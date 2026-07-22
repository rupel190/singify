import { describe, test, expect } from "bun:test";
import { createHandler, type HandlerDeps } from "./helper";
import { SessionExpiredError } from "../src/resolver";
import type { ParsedSong } from "../src/ultrastar-parser";

const FAKE_SONG = { headers: { title: "T" }, lines: [], durationMs: 0 } as unknown as ParsedSong;

const baseDeps: HandlerDeps = {
  hasCredentials: true,
  login: async () => {},
  relogin: async () => {},
  resolveLocal: () => null,
  resolveForTrack: async () => ({ status: "notFound" }),
  searchForTrack: async () => ({ status: "notFound" }),
  confirmPick: async () => FAKE_SONG,
};

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`http://127.0.0.1:4455${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("helper handler", () => {
  test("OPTIONS preflight → 204 with CORS headers", async () => {
    const res = await createHandler(baseDeps)(req("OPTIONS", "/pick"));
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  test("/health reports credential status without needing a session", async () => {
    const res = await createHandler({ ...baseDeps, hasCredentials: false })(
      req("GET", "/health")
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, hasCredentials: false });
  });

  test("GET /resolve returns the resolver result + CORS header", async () => {
    const deps: HandlerDeps = {
      ...baseDeps,
      resolveForTrack: async (trackId, artist, title) => {
        expect(trackId).toBe("spotify:track:abc");
        expect(artist).toBe("A");
        expect(title).toBe("T");
        return { status: "cached", song: FAKE_SONG };
      },
    };
    const res = await createHandler(deps)(
      req("GET", "/resolve?trackId=spotify:track:abc&artist=A&title=T")
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect((await res.json()).status).toBe("cached");
  });

  test("GET /resolve without a trackId → 400", async () => {
    const res = await createHandler(baseDeps)(req("GET", "/resolve?artist=A"));
    expect(res.status).toBe(400);
  });

  test("POST /pick downloads and returns the song", async () => {
    let picked = -1;
    const deps: HandlerDeps = {
      ...baseDeps,
      confirmPick: async (_trackId, candidate) => {
        picked = candidate.id;
        return FAKE_SONG;
      },
    };
    const res = await createHandler(deps)(
      req("POST", "/pick", { trackId: "t1", candidate: { id: 42, title: "x" } })
    );
    expect(res.status).toBe(200);
    expect(picked).toBe(42);
    expect((await res.json()).song.headers.title).toBe("T");
  });

  test("POST /pick without a body → 400", async () => {
    const res = await createHandler(baseDeps)(req("POST", "/pick", { trackId: "t1" }));
    expect(res.status).toBe(400);
  });

  test("local chart wins: returns status 'local' and never calls USDB", async () => {
    let called = false;
    const deps: HandlerDeps = {
      ...baseDeps,
      resolveLocal: (artist, title) => {
        expect(artist).toBe("A");
        expect(title).toBe("T");
        return { song: FAKE_SONG, path: "/charts/x.txt", score: 0.99 };
      },
      resolveForTrack: async () => {
        called = true;
        return { status: "notFound" };
      },
    };
    const res = await createHandler(deps)(
      req("GET", "/resolve?trackId=t1&artist=A&title=T")
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("local");
    expect(body.song.headers.title).toBe("T");
    expect(called).toBe(false);
  });

  test("force=1 re-search: hits USDB search, skips local + cache resolve", async () => {
    let searched = false;
    let localCalled = false;
    let resolveCalled = false;
    const deps: HandlerDeps = {
      ...baseDeps,
      resolveLocal: () => {
        localCalled = true;
        return { song: FAKE_SONG, path: "/x.txt", score: 1 };
      },
      resolveForTrack: async () => {
        resolveCalled = true;
        return { status: "notFound" };
      },
      searchForTrack: async (artist, title) => {
        searched = true;
        expect(artist).toBe("A");
        expect(title).toBe("T");
        return { status: "needsPicker", candidates: [{ id: 1 } as never] };
      },
    };
    const res = await createHandler(deps)(
      req("GET", "/resolve?trackId=t1&artist=A&title=T&force=1")
    );
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("needsPicker");
    expect(searched).toBe(true);
    expect(localCalled).toBe(false); // force bypasses the local folder
    expect(resolveCalled).toBe(false); // …and the cache/auto-select path
  });

  test("force=1 with no credentials → notFound, never searches", async () => {
    let searched = false;
    const deps: HandlerDeps = {
      ...baseDeps,
      hasCredentials: false,
      searchForTrack: async () => {
        searched = true;
        return { status: "notFound" };
      },
    };
    const res = await createHandler(deps)(req("GET", "/resolve?trackId=t1&force=1"));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("notFound");
    expect(searched).toBe(false);
  });

  test("no credentials + no local chart → notFound (200), not a 503 nag", async () => {
    let called = false;
    const deps: HandlerDeps = {
      ...baseDeps,
      hasCredentials: false,
      resolveLocal: () => null,
      resolveForTrack: async () => {
        called = true;
        return { status: "notFound" };
      },
    };
    const res = await createHandler(deps)(req("GET", "/resolve?trackId=t1"));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("notFound");
    expect(called).toBe(false);
  });

  test("a session-expiry triggers exactly one re-login + retry", async () => {
    let calls = 0;
    let reloginCalls = 0;
    const deps: HandlerDeps = {
      ...baseDeps,
      relogin: async () => {
        reloginCalls++;
      },
      resolveForTrack: async () => {
        calls++;
        if (calls === 1) throw new SessionExpiredError();
        return { status: "notFound" };
      },
    };
    const res = await createHandler(deps)(req("GET", "/resolve?trackId=t1"));
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    expect(reloginCalls).toBe(1);
  });

  test("a non-session error surfaces as 502", async () => {
    const deps: HandlerDeps = {
      ...baseDeps,
      resolveForTrack: async () => {
        throw new Error("USDB search failed: HTTP 500");
      },
    };
    const res = await createHandler(deps)(req("GET", "/resolve?trackId=t1"));
    expect(res.status).toBe(502);
    expect((await res.json()).message).toContain("HTTP 500");
  });

  test("unknown route → 404", async () => {
    const res = await createHandler(baseDeps)(req("GET", "/nope"));
    expect(res.status).toBe(404);
  });
});
