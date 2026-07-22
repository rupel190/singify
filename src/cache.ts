/**
 * cache.ts — local song cache
 *
 * Maps Spotify track IDs (or URIs) to local UltraStar .txt files so USDB is
 * only hit once per song. Layout:
 *
 *   ~/spicetify-karaoke/
 *     songs/
 *       Artist - Title [USDB-12345].txt
 *     cache.json    ← { [spotifyTrackId]: "./songs/Artist - Title [USDB-12345].txt" }
 *
 * Also exposes the pure query-normalisation + fuzzy-matching helpers the
 * resolver uses to decide auto-select vs. show-picker.
 *
 * NOTE ON THE handoff SIGNATURE: the handoff lists `saveSong(id, artist, title,
 * txt)`, but cache.json is keyed by Spotify track id — saveSong can't populate
 * that mapping without it. So saveSong takes the spotifyTrackId as its first
 * arg and the USDB id (for the filename) as its second. Similarly loadSong is
 * async because it reads from disk.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parse, type ParsedSong } from "./ultrastar-parser";

// ── Paths (overridable for tests) ────────────────────────────────────────────

// The download cache is regenerable, so it belongs under XDG_CACHE_HOME
// (~/.cache) rather than a bare ~/spicetify-karaoke dir.
function defaultCacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(xdg, "spicetify-karaoke");
}

let baseDir = defaultCacheDir();

/** Override the cache root (used by tests / custom install locations). */
export function setCacheDir(dir: string): void {
  baseDir = dir;
}

export function getCacheDir(): string {
  return baseDir;
}

function songsDir(): string {
  return join(baseDir, "songs");
}

function cacheFile(): string {
  return join(baseDir, "cache.json");
}

// ── Query normalisation ──────────────────────────────────────────────────────

// Parenthetical / bracketed groups that are noise for matching (they don't
// change which UltraStar chart we want): "(Remastered 2011)", "(Radio Edit)"…
const NOISE_KEYWORDS =
  /(remaster(?:ed)?|radio edit|single version|album version|re-?recorded|anniversary|deluxe|expanded|bonus track|mono|stereo|explicit|clean|edit|version|edition)/i;

// A trailing " - …" segment that is pure noise, e.g. "Song - 2011 Remaster".
const DASH_NOISE = new RegExp(
  `\\s+-\\s+[^-]*${NOISE_KEYWORDS.source}[^-]*$`,
  "i"
);

// feat. / ft. / featuring — everything from here on is a guest credit.
const FEAT = /\s*[\(\[]?\s*(?:feat\.?|ft\.?|featuring)\s+.*$/i;

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function stripNoiseParens(s: string): string {
  // Drop any (…) or […] group that contains a noise keyword.
  return s.replace(/[\(\[]([^\)\]]*)[\)\]]/g, (full, inner: string) =>
    NOISE_KEYWORDS.test(inner) ? "" : full
  );
}

/** Clean a song title for querying USDB. */
export function cleanTitle(title: string): string {
  let t = title;
  t = t.replace(FEAT, "");
  t = stripNoiseParens(t);
  t = t.replace(DASH_NOISE, "");
  return collapse(t).toLowerCase();
}

/**
 * Clean an artist string. Keeps only the primary artist — drops "feat. X",
 * and secondary artists joined by "&", ",", "x", "vs".
 */
export function cleanArtist(artist: string): string {
  let a = artist;
  a = a.replace(FEAT, "");
  a = a.split(/\s*,\s*|\s+(?:&|x|vs\.?|with)\s+/i)[0] ?? a;
  return collapse(a).toLowerCase();
}

/**
 * Normalise a Spotify title/artist pair into a clean USDB search query.
 */
export function sanitizeQuery(
  title: string,
  artist: string
): { title: string; artist: string } {
  return { title: cleanTitle(title), artist: cleanArtist(artist) };
}

// ── Fuzzy matching ───────────────────────────────────────────────────────────

function normForCompare(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * Similarity score in [0, 1] between two strings. Combines normalised
 * Levenshtein similarity with token-overlap (Jaccard) so that reordered or
 * partially-matching multi-word strings still score well. 1 = identical.
 */
export function fuzzyMatch(a: string, b: string): number {
  const na = normForCompare(a);
  const nb = normForCompare(b);
  if (!na && !nb) return 1;
  if (!na || !nb) return 0;

  const maxLen = Math.max(na.length, nb.length);
  const editSim = Math.max(0, 1 - levenshtein(na, nb) / maxLen);

  const ta = new Set(na.split(" ").filter(Boolean));
  const tb = new Set(nb.split(" ").filter(Boolean));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  const tokenSim = union === 0 ? 0 : inter / union;

  // Take the stronger of the two signals: edit-similarity absorbs typos,
  // token overlap absorbs word reorders — each rescues the other.
  return Math.max(editSim, tokenSim);
}

// ── Persistence ──────────────────────────────────────────────────────────────

type CacheMap = Record<string, string>;

async function readCacheMap(): Promise<CacheMap> {
  if (!existsSync(cacheFile())) return {};
  try {
    return JSON.parse(await readFile(cacheFile(), "utf8")) as CacheMap;
  } catch {
    return {}; // corrupt cache → treat as empty rather than crashing
  }
}

async function writeCacheMap(map: CacheMap): Promise<void> {
  await mkdir(baseDir, { recursive: true });
  await writeFile(cacheFile(), JSON.stringify(map, null, 2), "utf8");
}

function sanitizeFilename(s: string): string {
  return s
    .replace(/[\/\\:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Write a downloaded .txt to disk and record the Spotify-track → file mapping.
 * Returns the absolute path of the written file.
 */
export async function saveSong(
  spotifyTrackId: string,
  usdbId: number,
  artist: string,
  title: string,
  txt: string
): Promise<string> {
  await mkdir(songsDir(), { recursive: true });

  const filename = `${sanitizeFilename(artist)} - ${sanitizeFilename(
    title
  )} [USDB-${usdbId}].txt`;
  const abs = join(songsDir(), filename);
  await writeFile(abs, txt, "utf8");

  // Store a relative POSIX path so cache.json is portable across machines.
  const rel = `./songs/${filename}`;
  const map = await readCacheMap();
  map[spotifyTrackId] = rel;
  await writeCacheMap(map);

  return abs;
}

/**
 * Cache-hit path: returns the parsed song for a Spotify track id, or null if
 * not cached / the file is missing / it fails to parse.
 */
export async function loadSong(
  spotifyTrackId: string
): Promise<ParsedSong | null> {
  const map = await readCacheMap();
  const rel = map[spotifyTrackId];
  if (!rel) return null;

  const abs = join(baseDir, rel.replace(/^\.\//, ""));
  if (!existsSync(abs)) return null;

  try {
    return parse(await readFile(abs, "utf8"));
  } catch {
    return null;
  }
}

/** Whether a Spotify track is already cached (and its file exists). */
export async function isCached(spotifyTrackId: string): Promise<boolean> {
  const map = await readCacheMap();
  const rel = map[spotifyTrackId];
  if (!rel) return false;
  return existsSync(join(baseDir, rel.replace(/^\.\//, "")));
}
