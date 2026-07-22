/**
 * resolver.ts — song resolution flow (cache + USDB)
 *
 *   resolveForTrack(spotifyTrackId, artist, title)
 *     → cache hit?                          → { status: "cached" }
 *     → sanitize + usdb.search()
 *     → no results                          → { status: "notFound" }
 *     → 1 result AND fuzzyMatch > THRESHOLD → auto download + cache
 *                                             → { status: "downloaded" }
 *     → otherwise                           → { status: "needsPicker", candidates }
 *
 * The picker case is handled by the UI, which calls confirmPick(trackId, pick)
 * to download + cache the chosen candidate.
 *
 * SESSION EXPIRY: usdb.downloadTxt throws "USDB session expired" when the
 * cookie has lapsed. The resolver surfaces this as a typed SessionExpiredError
 * so the extension layer (which owns the credentials) can re-login and retry —
 * the resolver deliberately does not hold credentials.
 */

import { parse, type ParsedSong } from "./ultrastar-parser";
import * as usdb from "./usdb";
import type { USDBSong } from "./usdb";
import { sanitizeQuery, fuzzyMatch, saveSong, loadSong } from "./cache";

/** Auto-select threshold: above this combined score we skip the picker. */
export const MATCH_THRESHOLD = 0.85;

export class SessionExpiredError extends Error {
  constructor() {
    super("USDB session expired — re-login required");
    this.name = "SessionExpiredError";
  }
}

export type ResolveResult =
  | { status: "cached"; song: ParsedSong }
  | { status: "downloaded"; song: ParsedSong; usdbId: number }
  | { status: "local"; song: ParsedSong } // matched a chart in the local folder
  | { status: "needsPicker"; candidates: USDBSong[] }
  | { status: "notFound" };

/** Score a candidate against the cleaned query (mean of title + artist sim). */
export function scoreCandidate(
  candidate: USDBSong,
  cleaned: { title: string; artist: string }
): number {
  const titleSim = fuzzyMatch(candidate.title, cleaned.title);
  const artistSim = fuzzyMatch(candidate.artist, cleaned.artist);
  return (titleSim + artistSim) / 2;
}

/**
 * Resolve an UltraStar chart for the currently-playing Spotify track.
 */
export async function resolveForTrack(
  spotifyTrackId: string,
  artist: string,
  title: string
): Promise<ResolveResult> {
  // 1. Cache
  const cached = await loadSong(spotifyTrackId);
  if (cached) return { status: "cached", song: cached };

  // 2. Search USDB with a cleaned query
  const cleaned = sanitizeQuery(title, artist);
  const { songs } = await usdb.search({
    artist: cleaned.artist,
    title: cleaned.title,
  });

  if (songs.length === 0) return { status: "notFound" };

  // 3. Rank candidates best-first
  const ranked = songs
    .map((s) => ({ song: s, score: scoreCandidate(s, cleaned) }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];

  // 4. Auto-select only when unambiguous: a single result that clears the bar.
  if (songs.length === 1 && best.score > MATCH_THRESHOLD) {
    const song = await downloadAndCache(spotifyTrackId, best.song);
    return { status: "downloaded", song, usdbId: best.song.id };
  }

  // 5. Otherwise let the user choose (ranked best-first).
  return { status: "needsPicker", candidates: ranked.map((r) => r.song) };
}

/**
 * Download + cache a user-picked (or auto-selected) candidate and return the
 * parsed song. Called by the picker UI.
 */
export async function confirmPick(
  spotifyTrackId: string,
  candidate: USDBSong
): Promise<ParsedSong> {
  return downloadAndCache(spotifyTrackId, candidate);
}

async function downloadAndCache(
  spotifyTrackId: string,
  candidate: USDBSong
): Promise<ParsedSong> {
  let txt: string;
  try {
    txt = await usdb.downloadTxt(candidate.id);
  } catch (err) {
    if (err instanceof Error && /session expired/i.test(err.message)) {
      throw new SessionExpiredError();
    }
    throw err;
  }

  await saveSong(
    spotifyTrackId,
    candidate.id,
    candidate.artist,
    candidate.title,
    txt
  );

  return parse(txt);
}
