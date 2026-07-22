import { describe, test, expect, beforeEach, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setCacheDir } from "./cache";
import type { SearchResult } from "./usdb";

// ── Mock the USDB client ─────────────────────────────────────────────────────
// Mutable impls so each test can steer search/download behaviour.

let searchImpl: (opts: unknown) => Promise<SearchResult>;
let downloadImpl: (id: number) => Promise<string>;

mock.module("./usdb", () => ({
  search: (opts: unknown) => searchImpl(opts),
  downloadTxt: (id: number) => downloadImpl(id),
}));

const {
  resolveForTrack,
  searchForTrack,
  confirmPick,
  SessionExpiredError,
  MATCH_THRESHOLD,
} = await import("./resolver");

const TXT = `#TITLE:Hello
#ARTIST:Adele
#BPM:120
#GAP:0
: 0 4 60 Hel-
: 4 4 60 lo
E`;

function song(over: Partial<import("./usdb").USDBSong> = {}) {
  return {
    id: 1,
    artist: "Adele",
    title: "Hello",
    edition: "",
    golden: false,
    language: "English",
    rating: 5,
    views: 100,
    ...over,
  };
}

function result(songs: ReturnType<typeof song>[]): SearchResult {
  return { songs, paging: { current: 1, pages: 1 } };
}

beforeEach(() => {
  setCacheDir(mkdtempSync(join(tmpdir(), "sk-resolver-")));
  searchImpl = async () => result([]);
  downloadImpl = async () => TXT;
});

describe("searchForTrack (re-choose)", () => {
  test("always returns the ranked picker — even a lone high-confidence match", async () => {
    // resolveForTrack would auto-download this; searchForTrack must NOT.
    let downloaded = false;
    downloadImpl = async () => {
      downloaded = true;
      return TXT;
    };
    searchImpl = async () => result([song({ id: 7 })]);
    const r = await searchForTrack("Adele", "Hello");
    expect(r.status).toBe("needsPicker");
    if (r.status === "needsPicker") expect(r.candidates.map((c) => c.id)).toEqual([7]);
    expect(downloaded).toBe(false);
  });

  test("ranks multiple candidates best-first", async () => {
    searchImpl = async () =>
      result([song({ id: 1, title: "Hello (Live)" }), song({ id: 2, title: "Hello" })]);
    const r = await searchForTrack("Adele", "Hello");
    expect(r.status).toBe("needsPicker");
    if (r.status === "needsPicker") expect(r.candidates[0].id).toBe(2);
  });

  test("notFound when USDB has nothing", async () => {
    searchImpl = async () => result([]);
    expect((await searchForTrack("x", "y")).status).toBe("notFound");
  });
});

describe("resolveForTrack", () => {
  test("returns notFound when USDB has no results", async () => {
    searchImpl = async () => result([]);
    const r = await resolveForTrack("t1", "Nobody", "Nothing");
    expect(r.status).toBe("notFound");
  });

  test("auto-downloads a single high-confidence match", async () => {
    let downloadedId = -1;
    searchImpl = async () => result([song({ id: 42 })]);
    downloadImpl = async (id) => {
      downloadedId = id;
      return TXT;
    };

    const r = await resolveForTrack("t2", "Adele", "Hello");
    expect(r.status).toBe("downloaded");
    if (r.status === "downloaded") {
      expect(r.usdbId).toBe(42);
      expect(r.song.headers.title).toBe("Hello");
    }
    expect(downloadedId).toBe(42);
  });

  test("does NOT auto-download when the single match is weak", async () => {
    searchImpl = async () =>
      result([song({ id: 9, artist: "Totally Different", title: "Other" })]);
    const r = await resolveForTrack("t3", "Adele", "Hello");
    expect(r.status).toBe("needsPicker");
  });

  test("returns picker for multiple results, ranked best-first", async () => {
    searchImpl = async () =>
      result([
        song({ id: 1, artist: "Wrong Band", title: "Something Else" }),
        song({ id: 2, artist: "Adele", title: "Hello" }),
      ]);
    const r = await resolveForTrack("t4", "Adele", "Hello");
    expect(r.status).toBe("needsPicker");
    if (r.status === "needsPicker") {
      expect(r.candidates[0].id).toBe(2); // best match first
    }
  });

  test("second call hits the cache (no search)", async () => {
    searchImpl = async () => result([song({ id: 5 })]);
    await resolveForTrack("t5", "Adele", "Hello");

    let searched = false;
    searchImpl = async () => {
      searched = true;
      return result([]);
    };
    const r = await resolveForTrack("t5", "Adele", "Hello");
    expect(r.status).toBe("cached");
    expect(searched).toBe(false);
  });
});

describe("confirmPick", () => {
  test("downloads, caches, and parses the picked candidate", async () => {
    downloadImpl = async () => TXT;
    const parsed = await confirmPick("t6", song({ id: 77 }));
    expect(parsed.headers.artist).toBe("Adele");
  });

  test("maps 'session expired' to SessionExpiredError", async () => {
    downloadImpl = async () => {
      throw new Error("USDB session expired — please re-login");
    };
    await expect(confirmPick("t7", song())).rejects.toBeInstanceOf(
      SessionExpiredError
    );
  });
});

describe("MATCH_THRESHOLD", () => {
  test("is the documented 0.85", () => {
    expect(MATCH_THRESHOLD).toBe(0.85);
  });
});
