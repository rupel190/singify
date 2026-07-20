/**
 * helper.ts — the localhost bridge.
 *
 * Why this exists: USDB auth needs real Cookie/Set-Cookie headers and the song
 * cache needs disk (node:fs) — both impossible inside Spotify's Chromium
 * renderer. So the already-tested resolver/usdb/cache modules run HERE, in Bun,
 * and the extension talks to them over HTTP (see src/resolver-client.ts). This
 * same helper also lets the browser harness resolve real charts.
 *
 * The HTTP surface mirrors the resolver 1:1:
 *   GET  /health                              → { ok, hasCredentials }
 *   GET  /resolve?trackId&artist&title        → ResolveResult
 *   POST /pick  { trackId, candidate }         → { song }
 *
 * This file owns the one thing the resolver deliberately doesn't: credentials.
 * It logs in lazily and, on a session-expiry, re-logs-in and retries once.
 *
 * createHandler() is split out (deps injected) so the routing/CORS/retry logic
 * is unit-testable without a live USDB.
 */

import { SessionExpiredError, type ResolveResult } from "../src/resolver";
import type { USDBSong } from "../src/usdb";
import type { ParsedSong } from "../src/ultrastar-parser";

class NoCredentialsError extends Error {}

export interface HandlerDeps {
  hasCredentials: boolean;
  /** Ensure a live session (idempotent); throws if credentials are bad. */
  login: () => Promise<void>;
  /** Drop the session and log in fresh. */
  relogin: () => Promise<void>;
  resolveForTrack: (
    trackId: string,
    artist: string,
    title: string
  ) => Promise<ResolveResult>;
  confirmPick: (trackId: string, candidate: USDBSong) => Promise<ParsedSong>;
}

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

export function createHandler(
  deps: HandlerDeps
): (req: Request) => Promise<Response> {
  // Ensure we're logged in, run `fn`, and if the session had expired, re-login
  // and retry exactly once. Credentials live here, not in the resolver.
  async function withSession<T>(fn: () => Promise<T>): Promise<T> {
    if (!deps.hasCredentials) throw new NoCredentialsError();
    await deps.login();
    try {
      return await fn();
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        await deps.relogin();
        return await fn();
      }
      throw err;
    }
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === "/health") {
      return json({ ok: true, hasCredentials: deps.hasCredentials });
    }

    try {
      if (url.pathname === "/resolve" && req.method === "GET") {
        const trackId = url.searchParams.get("trackId") ?? "";
        const artist = url.searchParams.get("artist") ?? "";
        const title = url.searchParams.get("title") ?? "";
        if (!trackId) return json({ error: "missing trackId" }, 400);
        const result = await withSession(() =>
          deps.resolveForTrack(trackId, artist, title)
        );
        return json(result);
      }

      if (url.pathname === "/pick" && req.method === "POST") {
        const body = (await req.json().catch(() => null)) as {
          trackId?: string;
          candidate?: USDBSong;
        } | null;
        if (!body?.trackId || !body?.candidate) {
          return json({ error: "missing trackId or candidate" }, 400);
        }
        const song = await withSession(() =>
          deps.confirmPick(body.trackId!, body.candidate!)
        );
        return json({ song });
      }
    } catch (err) {
      if (err instanceof NoCredentialsError) {
        return json(
          {
            error: "no-credentials",
            message:
              'USDB credentials not configured. Create ~/.config/spicetify-karaoke/config.json with { "usdbUser": "…", "usdbPass": "…" }.',
          },
          503
        );
      }
      return json(
        {
          error: "resolve-failed",
          message: err instanceof Error ? err.message : "internal error",
        },
        502
      );
    }

    return json({ error: "not-found" }, 404);
  };
}

// ── Startup ──────────────────────────────────────────────────────────────────

async function startHelper(): Promise<void> {
  // Imports kept inside startup so the test (which only needs createHandler)
  // doesn't pull the disk-cache / config modules.
  const { loadConfig, configPath } = await import("./config");
  const usdb = await import("../src/usdb");
  const { resolveForTrack, confirmPick } = await import("../src/resolver");
  const { setCacheDir, getCacheDir } = await import("../src/cache");

  const cfg = loadConfig();
  if (cfg.cacheDir) setCacheDir(cfg.cacheDir);
  const hasCredentials = !!(cfg.usdbUser && cfg.usdbPass);

  let loggedIn = false;
  const login = async (): Promise<void> => {
    if (loggedIn) return;
    const ok = await usdb.login(cfg.usdbUser!, cfg.usdbPass!);
    if (!ok) throw new Error("USDB login failed — check credentials in config.json");
    loggedIn = true;
  };
  const relogin = async (): Promise<void> => {
    loggedIn = false;
    await login();
  };

  const handler = createHandler({
    hasCredentials,
    login,
    relogin,
    resolveForTrack,
    confirmPick,
  });

  const server = Bun.serve({ port: cfg.port, fetch: handler });
  console.log(`[singify helper] listening on http://127.0.0.1:${server.port}`);
  if (hasCredentials) {
    console.log(`[singify helper] cache: ${getCacheDir()}`);
  } else {
    console.log(
      `[singify helper] ⚠ no USDB credentials. Create ${configPath()} ` +
        `(or set SINGIFY_USDB_USER / SINGIFY_USDB_PASS). ` +
        `/health works; /resolve returns 503 until configured.`
    );
  }
}

// Run only when invoked directly (`bun run helper`), not when imported by tests.
if (import.meta.main) void startHelper();
