/**
 * local-charts.ts — resolve a Spotify track against a folder of UltraStar .txt
 * charts on disk.
 *
 * This is the no-account, no-network autoload source: drop a chart in the folder
 * and it plays when its track comes on. Getting the chart is up to you (manual
 * USDB download, a CC pack, hand-authored) — singify only cares that a .txt with
 * matching #ARTIST/#TITLE headers is in the folder.
 *
 * Matching reuses the SAME sanitize + fuzzy logic as the USDB path (cache.ts +
 * resolver.ts) so local and remote resolution rank tracks identically.
 */

import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse, type ParsedSong } from "../src/ultrastar-parser";
import { sanitizeQuery, fuzzyMatch } from "../src/cache";
import { MATCH_THRESHOLD } from "../src/resolver";

export interface LocalMatch {
  song: ParsedSong;
  path: string;
  score: number;
}

interface Entry {
  path: string;
  mtimeMs: number;
  artist: string;
  title: string;
  song: ParsedSong;
}

export interface LocalCharts {
  /** Best chart for this track, or null if none clears the match threshold. */
  resolve: (artist: string, title: string) => LocalMatch | null;
  /** Number of parseable charts currently indexed. */
  count: () => number;
  /** The folders being scanned (absolute), for diagnostics/logging. */
  dirs: () => string[];
}

/**
 * Build a lazily-refreshed index over one or more folders. Every folder is
 * scanned and unioned; missing folders are simply skipped (so a stable home dir
 * and a dev repo dir can both be listed and whichever exists contributes). Each
 * resolve re-reads the listings and (re)parses only files whose mtime changed —
 * so a chart dropped in while the helper runs is picked up without a restart,
 * but unchanged files are never re-parsed.
 */
export function createLocalCharts(dirs: string | string[]): LocalCharts {
  const dirList = Array.isArray(dirs) ? dirs : [dirs];
  const cache = new Map<string, Entry>(); // keyed by absolute file path

  function refresh(): void {
    const seen = new Set<string>();
    for (const dir of dirList) {
      if (!existsSync(dir)) continue; // missing folder → skip, not an error
      for (const name of readdirSync(dir)) {
        if (!name.toLowerCase().endsWith(".txt")) continue;
        const path = join(dir, name);
        let mtimeMs: number;
        try {
          mtimeMs = statSync(path).mtimeMs;
        } catch {
          continue; // vanished between listing and stat
        }
        seen.add(path);
        const hit = cache.get(path);
        if (hit && hit.mtimeMs === mtimeMs) continue; // unchanged → keep parsed copy
        try {
          const song = parse(readFileSync(path, "utf8"));
          cache.set(path, {
            path,
            mtimeMs,
            artist: song.headers.artist,
            title: song.headers.title,
            song,
          });
        } catch {
          cache.delete(path); // unparseable → forget it rather than crash a resolve
        }
      }
    }
    // Drop entries for files that disappeared from every folder.
    for (const path of [...cache.keys()]) {
      if (!seen.has(path)) cache.delete(path);
    }
  }

  return {
    dirs: () => dirList,
    resolve(artist, title) {
      refresh();
      const cleaned = sanitizeQuery(title, artist);
      let best: LocalMatch | null = null;
      for (const e of cache.values()) {
        const score =
          (fuzzyMatch(e.title, cleaned.title) +
            fuzzyMatch(e.artist, cleaned.artist)) /
          2;
        if (score > MATCH_THRESHOLD && (!best || score > best.score)) {
          best = { song: e.song, path: e.path, score };
        }
      }
      return best;
    },
    count() {
      refresh();
      return cache.size;
    },
  };
}
