/**
 * resolver-client.ts — browser/Spotify side of song resolution.
 *
 * Same signatures as resolver.ts, but instead of touching USDB + disk directly
 * (impossible in a renderer), it calls the localhost helper (server/helper.ts).
 * The extension and harness import THIS in place of resolver.ts; the helper runs
 * the real, tested resolver in Bun.
 *
 * 127.0.0.1 (not "localhost") avoids IPv6/DNS resolution quirks in Electron.
 */

import type { ResolveResult } from "./resolver";
import type { USDBSong } from "./usdb";
import type { ParsedSong } from "./ultrastar-parser";

export const HELPER_BASE =
  (globalThis as { SINGIFY_HELPER_BASE?: string }).SINGIFY_HELPER_BASE ??
  "http://127.0.0.1:4455";

/** Pull the best human-readable message out of a helper error response. */
async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; error?: string };
    return body.message ?? body.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

export async function resolveForTrack(
  spotifyTrackId: string,
  artist: string,
  title: string
): Promise<ResolveResult> {
  const q = new URLSearchParams({ trackId: spotifyTrackId, artist, title });
  const res = await fetch(`${HELPER_BASE}/resolve?${q}`);
  if (!res.ok) throw new Error(await errorMessage(res));
  return (await res.json()) as ResolveResult;
}

export async function confirmPick(
  spotifyTrackId: string,
  candidate: USDBSong
): Promise<ParsedSong> {
  const res = await fetch(`${HELPER_BASE}/pick`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trackId: spotifyTrackId, candidate }),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  const { song } = (await res.json()) as { song: ParsedSong };
  return song;
}

export interface HelperHealth {
  ok: boolean;
  hasCredentials: boolean;
}

/** Probe whether the helper is up. Returns null if it isn't reachable. */
export async function helperHealth(): Promise<HelperHealth | null> {
  try {
    const res = await fetch(`${HELPER_BASE}/health`);
    if (!res.ok) return null;
    return (await res.json()) as HelperHealth;
  } catch {
    return null; // connection refused → helper not running
  }
}
