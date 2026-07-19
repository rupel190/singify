# Spicetify Karaoke (singify)

UltraStar karaoke inside Spotify via Spicetify. When a song plays, it fetches the
matching UltraStar `.txt` from USDB, parses it, and (planned) renders a
syllable-highlighted lyric scroll + pitch lane in Spotify's main panel.

**Stack:** Bun · TypeScript · Spicetify (Electron/Chromium renderer) · Linux

## Status

| Module | State |
| --- | --- |
| `src/ultrastar-parser.ts` | ✅ UltraStar `.txt` parser (headers, beats→ms, RELATIVE, note types) |
| `src/usdb.ts` | ✅ USDB client (login, search-scrape, downloadTxt) |
| `src/cache.ts` | ✅ Query sanitisation, fuzzy matching, on-disk song cache |
| `src/resolver.ts` | ✅ cache + USDB resolution flow, session-expiry handling |
| `src/index.ts` (extension scaffold) | ⬜ not started |
| React lyric-scroll + pitch-lane UI | ⬜ not started |
| Picker UI | ⬜ not started |

**Tests:** `bun test` → 50 pass (28 parser + 22 cache/resolver). No live USDB
calls; everything is fixture/mock based.

## Cache layout

```
~/spicetify-karaoke/
  songs/Artist - Title [USDB-12345].txt
  cache.json    ← { [spotifyTrackId]: "./songs/Artist - Title [USDB-12345].txt" }
```

## Notable design decisions (deviations from the handoff)

- **`saveSong(spotifyTrackId, usdbId, artist, title, txt)`** takes the Spotify
  track id first — the handoff's `saveSong(id, …)` couldn't populate `cache.json`
  (which is keyed by Spotify track id) without it.
- **`loadSong` is async** (returns `Promise<ParsedSong | null>`) because it reads
  from disk.
- **`fuzzyMatch`** returns `max(editSimilarity, tokenOverlap)` — edit-similarity
  absorbs typos, token overlap absorbs word reorders. Auto-select threshold
  `MATCH_THRESHOLD = 0.85`.
- **Session expiry** surfaces as a typed `SessionExpiredError` from the resolver
  so the extension layer (which owns USDB credentials) re-logs-in and retries.
  The resolver deliberately holds no credentials.
- **`setCacheDir(dir)`** overrides the cache root (used by tests).

## Remaining work (priority order)

1. Extension scaffold `src/index.ts` — wait for `Spicetify.Player`, hook
   `songchange`, interpolate playback position from `onprogress`.
2. React lyric-scroll + pitch-lane component (rAF driven via `getPosition`).
3. Picker UI for `resolveForTrack` → `{ status: "needsPicker", candidates }`.
4. Credentials prompt + storage at `~/.config/spicetify-karaoke/config.json`.
5. Mic input / scoring layer (future).

## Running

```bash
bun install
bun test
```
