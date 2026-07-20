# Spicetify Karaoke (singify)

UltraStar karaoke inside Spotify via Spicetify. When a song plays, it fetches the
matching UltraStar `.txt` from USDB, parses it, and renders a syllable-highlighted
lyric scroll + pitch lane in a fullscreen overlay.

**Stack:** Bun · TypeScript · Spicetify (Electron/Chromium renderer) · Linux (NixOS)

## Why not fork an existing engine?

Existing engines (USDX, Vocaluxe, Performous, UltraStar Play, allkaraoke) own the
audio; Spotify never exposes decoded PCM (DRM), so that's impossible here. singify
rides only what Spotify *does* expose — the playback clock + the mic — overlaying
the chart on whatever's already playing.

## Approach: browser-first, Spotify later

The hard, iterative part — the karaoke rendering — is developed in a **plain
browser** with instant reload, no Spotify required. The *same* `KaraokeView`
component then runs unchanged inside Spotify. This works because of a small
ports-and-adapters split:

- **Shared core** — `ultrastar-parser.ts` (pure) and `karaoke-view.tsx`, which
  reads `Spicetify.React` and takes the playback position through a
  `getPositionMs()` prop. It has no idea which world it's in.
- **Two host adapters** fill those holes:
  - `dev/harness.tsx` — browser: fakes the `Spicetify` global with real React,
    drives a synthetic transport clock, feeds a fixture chart.
  - `src/index.ts` — Spotify: uses Spotify's injected React, interpolates the
    clock from `Player` events, resolves real charts.

Add UI features once (in the core) and both hosts get them for free.

## Status

| Module | State |
| --- | --- |
| `src/ultrastar-parser.ts` | ✅ UltraStar `.txt` parser (headers, beats→ms, RELATIVE, note types) · tested |
| `src/usdb.ts` | ✅ USDB client (login, search-scrape, downloadTxt) · tested · ⚠️ Node-only auth (see below) |
| `src/cache.ts` | ✅ Query sanitisation, fuzzy matching, on-disk song cache · tested · ⚠️ uses `node:fs` |
| `src/resolver.ts` | ✅ cache + USDB resolution flow, session-expiry handling · tested |
| `src/karaoke-view.tsx` | ✅ Pitch lane + per-syllable lyric wipe · **browser-verified** in the harness |
| `src/index.ts` (extension) | ✅ clock, overlay, `songchange` wiring, hotkeys · ⚠️ **not yet proven in a live Spotify client** |
| `server/helper.ts` (localhost bridge) | ✅ Bun HTTP server wrapping resolver/usdb/cache · CORS · lazy login + retry · tested · needs a USDB account to resolve for real |
| `src/resolver-client.ts` (thin client) | ✅ browser/Spotify side; same signatures as `resolver.ts`, fetches the helper |
| Lyric offset (audio-sync knob) | ✅ `[` / `]` / `\` in Spotify, buttons in the harness |
| `src/song-picker.tsx` (candidate chooser) | ✅ browser-verified in the harness · wired into both hosts |
| `src/pitch.ts` (pitch detection) | ✅ autocorrelation f0 + Hz↔MIDI↔pitch-class + marker smoother (median → EMA) · tested |
| `src/mic.ts` + live pitch marker | ✅ getUserMedia → detectPitch → smoothed marker on the lane · needs a mic to feel |
| `src/scoring.ts` (running score, HUD) | ✅ beat-weighted note points + line bonus, golden 2×, octave-agnostic · tested · HUD shows while mic is live |
| `src/result-screen.tsx` (end-of-song) | ✅ grade tier + stars + score breakdown + "Sing again" · shows when playback passes the song end |
| Credentials prompt + config loader | ⬜ not started |
| Localhost helper (USDB + cache bridge) | ⬜ needed for live Spotify — see *Known runtime gap* |

**Tests:** `bun test` → **97 pass** (parser + cache/resolver + pitch detection + scoring + helper).
No live USDB calls; everything is fixture/mock/synthetic-tone based.

## Dev workflow

```bash
nix develop            # or `direnv allow` once, then it auto-loads (flake.nix)
bun install            # first time only
bun test               # 50 core tests
bun run dev            # browser harness → http://localhost:3000 (or next free port)
bun run helper         # localhost bridge → http://127.0.0.1:4455 (USDB + cache)
bun run build          # bundle → dist/karaoke.js
```

The harness renders `<KaraokeView>` against a fixture chart with a play/pause/seek
transport, so you can iterate on the UI without Spotify. **Drop a real UltraStar
`.txt` onto the stage** (or use *Load .txt…*) to test against real charts — no
USDB account needed. Free CC-licensed charts: [UltraStar-Deluxe/songs](https://github.com/UltraStar-Deluxe/songs).

### Hotkeys (in Spotify) / controls (in the harness)

| Action | Spotify | Harness |
| --- | --- | --- |
| Toggle karaoke overlay | `K` | (always shown) |
| Nudge lyrics later / earlier | `[` / `]` (±20 ms) | −20 / +20 buttons |
| Reset sync | `\` | ⟲ reset |
| Choose among matches | picker overlay (press `K`) | "Picker demo →" toggle |
| Toggle mic (live pitch) | `M` | 🎤 Mic button |

The **offset** shifts the whole karaoke timeline against the audio (positive =
lyrics fire earlier), to compensate for output latency and slightly-off UltraStar
`GAP` values. It's a property of the *clock*, so it lives entirely in the two
adapters — `karaoke-view.tsx` never changed to add it. In Spotify the value is
persisted (`localStorage`); in the harness it's ephemeral.

## Cache layout

```
~/spicetify-karaoke/
  songs/Artist - Title [USDB-12345].txt
  cache.json    ← { [spotifyTrackId]: "./songs/Artist - Title [USDB-12345].txt" }
```

## The localhost helper (`server/helper.ts`)

Two pieces can't run inside Spotify's **Chromium renderer**: USDB auth needs real
`Cookie` / `Set-Cookie` headers (browsers forbid both, and usdb.animux.de sends no
CORS), and the cache needs `node:fs`. So the tested `resolver`/`usdb`/`cache`
modules run in **Bun**, behind a small HTTP server; the extension and harness are
thin `fetch` clients (`src/resolver-client.ts`), which have the *same signatures*
as `resolver.ts`. Swapping the import moved all of USDB + cache out of the
extension bundle (57 KB → 36 KB, zero `node:fs`).

```
GET  /health                        → { ok, hasCredentials }
GET  /resolve?trackId&artist&title  → ResolveResult
POST /pick { trackId, candidate }   → { song }
```

The helper owns the one thing the resolver won't: credentials. It logs in lazily
and re-logs-in + retries once on session expiry.

**Config:** `~/.config/spicetify-karaoke/config.json`
`{ "usdbUser": "…", "usdbPass": "…", "port": 4455, "cacheDir": "…" }`
(or `SINGIFY_USDB_USER` / `SINGIFY_USDB_PASS` / `SINGIFY_PORT` env vars). Without
credentials the server still starts and `/health` works; `/resolve` returns 503.
Needs a USDB account to resolve for real.

**Live-Spotify caveat (stage 2):** Spotify's CSP may block `fetch` to
`127.0.0.1` from the renderer. Untested — the browser harness reaches the helper
fine; the Spotify path may need a CSP tweak or a Spicetify-side proxy.

## Deploying into Spotify (NixOS / spicetify-nix)

This repo's owner runs Spicetify declaratively via `spicetify-nix`. singify is a
custom extension — same shape as any other entry in `enabledExtensions`:

```nix
singify = {
  src  = pkgs.fetchFromGitHub { owner = "rupel190"; repo = "singify"; rev = "dist"; hash = "…"; };
  name = "karaoke.js";
};
```

i.e. `bun run build` → publish `dist/karaoke.js` to a `dist` branch → point Nix at
it (mirroring the existing `spicetify-visualizer` setup). No reinstall.

## Notable design decisions

- **`saveSong(spotifyTrackId, usdbId, artist, title, txt)`** takes the Spotify
  track id first — `cache.json` is keyed by it, so the mapping can't be populated
  otherwise.
- **`loadSong` is async** (`Promise<ParsedSong | null>`) — it reads from disk.
- **`fuzzyMatch`** returns `max(editSimilarity, tokenOverlap)` — edit-similarity
  absorbs typos, token overlap absorbs word reorders. Auto-select threshold
  `MATCH_THRESHOLD = 0.85`.
- **Session expiry** surfaces as a typed `SessionExpiredError` from the resolver
  so the extension layer (which owns credentials) re-logs-in and retries. The
  resolver deliberately holds no credentials.
- **Pitch lane is DOM + CSS transform**, not canvas — a single GPU-composited
  `translateX` moves the note track. On this project's RDNA4 GPU (which has a
  documented habit of crashing Spotify's GPU process on the wrong path) that's
  the safer choice as well as the cheaper one.
- **`setCacheDir(dir)`** overrides the cache root (used by tests).

## Remaining work (priority order)

1. **USDB account + config** — add credentials to
   `~/.config/spicetify-karaoke/config.json`, then resolve a real chart end-to-end
   via `bun run helper` (the helper itself is done).
2. **Point the harness at the helper** — optional "live resolve" mode so real
   charts render in the browser (today it uses mock candidates).
3. **Live-Spotify bring-up** — first `spicetify apply`; confirm the
   overlay/clock/picker against a real track, and whether CSP allows the
   `127.0.0.1` helper fetch.
4. **Scoring polish** — difficulty selector (tolerance ±2/±1/±0) and rap notes
   (`R`/`G` tokens) once the parser emits them. Core scoring, end-of-song result
   screen, and marker smoothing are done (`src/scoring.ts`,
   `src/result-screen.tsx`, `pitch.ts`): beat-weighted 9000 + 1000 line bonus,
   golden 2×, octave-agnostic, live HUD, grade tiers, median+EMA marker.
