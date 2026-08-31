# singify — codebase review (2026-08-31)

Full-repo review by six parallel agents: architecture/rewrite-readiness, correctness,
silent-failure hunting, performance, test coverage, simplification. Findings below are
de-duplicated across passes and ranked. **Tier-0 items are already fixed** (commit
`f6860da`) and marked ✅.

---

## Correctness

- ✅ **Stats data-loss race** — `persist.ts` `ensureLoaded`. No in-flight-promise memo
  → a `recordStatRound` and a `loadStatRounds` that both start while `statsCache` is
  `null` each build their own array; the slower overwrites the faster, dropping a
  just-recorded round. Found independently by correctness, silent-failures, AND
  test-coverage. **Fixed:** memoized in-flight load + flush-on-exit + logged failures.
- ✅ **BOM breaks `parse()`** — `ultrastar-parser.ts`. A leading `﻿` (common on
  Windows-exported `.txt`) fails `startsWith("#")` → throws "missing #BPM" → silently
  disables local-folder autoload + manual `L`. **Fixed:** strip a leading BOM.
- ✅ **Result "★ best" matched by title** — `session-view.tsx`. Singing a song twice
  gold-starred both rows. **Fixed:** `bestRound` now carries an `index`; match by it.
- ⬜ **RELATIVE two-number line break** (low-confidence) — `ultrastar-parser.ts:131`.
  `- p1 p2` advances by `p1`, ignoring `p2` (the next-line start), mistiming later
  lines in those legacy charts. Rare; confirm against a real relative chart first.

## Robustness / silent failures

- ✅ **`cache.json` non-atomic + silent reset** — `cache.ts`. Bare `writeFile` +
  corrupt-read→`{}` could truncate and silently wipe the whole track→chart map,
  re-hammering USDB. **Fixed:** atomic temp+rename + log on corrupt read.
- ⬜ **`TypeError` = "helper unreachable" is too broad** — `index.ts:1437,1503`. A
  genuine code `TypeError` in the resolve path is reclassified as connection-refused:
  no toast, wrong "start the helper" caution. Detect refusal more narrowly (probe
  `helperHealth()` on failure). *(Also flagged by test-coverage.)*
- ⬜ **Session Continue/Skip/Restart fail silently** — `index.ts:1282,1317,426`.
  `Player.next?.()` / `seek` are console-only on failure → the session stalls with no
  feedback. Surface a toast like `startPlaylistSession` already does.
- ⬜ **Settings/offsets mirror failures swallowed** — `persist.ts:77,80`. Low impact
  (localStorage is the live truth) but a persistently-down mirror is undiagnosable —
  add a log.
- ⬜ **`writeStore` shared temp path** (low) — `server/store.ts:66`. Two concurrent
  PUTs to the same store can ENOENT on rename; unique temp suffix fixes it.
- **Keep (good):** `openMic` fallback notifies; `usdb` raises on the logged-out page;
  helper 503/relogin; `store.writeStore` atomic; the stats `reachable` flag.

## Performance (60fps hot path — no-canvas constraint)

- ⬜ **`detectPitch` is O(n²) on the render thread** — `pitch.ts:240`, per player per
  frame. **Capping the ACF loop at `maxLag` (~685) is a ~44% cut, zero behavior
  change** (lags above it are computed and discarded). Also reuse the per-frame
  `new Float32Array(2048)` scratch. Real fix: move detection to an AudioWorklet/Worker.
- ⬜ **Whole tree re-renders every frame** — `karaoke-view.tsx:224` (`setFrame`/tick).
  Drive the hot properties (track `translateX`, marker, score text, trail) imperatively
  via refs; `setState` only on discrete changes → zero per-frame reconciliation. The
  single biggest render-latency lever, and it captures most of what Solid would buy.
- ⬜ **Trail rebuilds ~70 reconciled dots/frame** — `karaoke-view.tsx:468`. Dot x =
  `pt.ms*pxPerMs + trackTranslate`, so spawning them into the already-translated note
  layer makes them scroll for free (spawn-and-forget like the sparks).
- ⬜ **`scoring.read()` allocs 2 Maps + loops all notes/frame** — `scoring.ts:185`.
  Make it incremental (update the active note's delta in `sample()`).
- ⬜ **Marker animates `top` + transition** (layout) — `karaoke-view.tsx`. Use a
  composited `transform` instead.
- ⬜ **Gold-shimmer animates `background-position`** (repaint) — `karaoke-view.tsx`.
  Move to a `translateX` overlay (compositor-friendly; matters on the RDNA4 GPU).
- ⬜ **Spark `useEffect` has no deps** (runs every commit) + `getElementById` per burst
  — `karaoke-view.tsx:409`. Fold into `computeFrame`/rAF; hoist `ensureSparkStyles`.

## Architecture & Solid rewrite

Ports-and-adapters split is genuinely clean. **Pure core** (`ultrastar-parser, scoring,
pitch, session, stats, cache, resolver, usdb, mic, persist, playlist-source`) has zero
framework → ports verbatim. The `node:fs` firewall is a type-only import in
`resolver-client.ts` — preserve it.

Migration surface:
- **`index.ts` (~1657 lines)** — biggest win *and* refactor: an imperative store that
  hand-calls `renderOverlay()` ~40× after every mutation; Solid signals delete every
  one (a `<Switch>/<Match>` + one `render()`). Strongest rewrite argument.
- **`karaoke-view.tsx`** — the one true rewrite (frame loop, `useSize`, per-render spark
  effect, engines-in-refs → signal model). Faithful port wastes Solid; fine-grained is
  the real 60fps gain.
- **`session-view.tsx` (~1291 lines)** — high volume, low difficulty (mostly stateless).
- **Main risk — build tooling:** Solid needs its dedicated compiler
  (`vite-plugin-solid`/`babel-preset-solid`); `bun build` alone won't transform it, and
  the output must stay a single self-contained IIFE (Spicetify loads a classic script).
  **De-risk this spike first.**
- **Rough budget: ~8–12 days.**

Smells to fix regardless of the rewrite:
- `PLAYER_COLORS` exported from `karaoke-view.tsx` (a view) → extract a `theme.ts`.
- Interpolated clock + the three-cell stage grid are duplicated between `index.ts:1003`
  and `harness.tsx:995` — factor before porting so it isn't done twice.
- Per-file palettes; the `Spicetify.React` global indirection; the `activeScreen` /
  `window.screen` shadow trap (carry the warning forward).

**Verdict:** do the imperative perf work in React **first** — it captures most of Solid's
benefit, is incremental, and lets you *measure* whether a rewrite still earns ~8–12 days.

## Simplification / dead code

- **Safe deletes:** `helperHealth`+`HelperHealth` (`resolver-client.ts:80`),
  `session.roundsDone` (`:143`), `usdb.isLoggedIn` (`:87`), the unused `_react` param on
  `primaryBtn`/`ghostBtn`, `serve.ts:13` no-op `join`.
- **Top dedup:** shared `theme.ts` (green defined 7×, gold 6×, the dark palette twice)
  and shared `storage-keys.ts` (every `singify:*` key defined in both `index.ts` and
  `persist.ts`). Then `writeLS()` for the 7 try/catch `setItem` sites,
  `currentItem()`/`playerCall()` in `index.ts`, folding `aggregateByMic/ByPlayer`, and a
  shared `server/xdg.ts` (`store.ts`/`config.ts`/`cache.ts` triplicate the XDG helpers).
- **Legacy (needs-care, compat trade-offs):** `PLAYER_SENS_KEY` fallback, the sensitivity
  v1→v2 migration, the `ReactDOM.render` shim.
- **Don't merge** `resolver.ts` vs `resolver-client.ts` — intentional impl-vs-HTTP.

## Test gaps

- ✅ persist no-clobber / race (added `persist.test.ts`).
- ⬜ `seedFromHelper` no-clobber; the autoskip streak (extract a pure reducer);
  `rosterSlotForScore` (pass the roster in → trivially testable); `resolver-client`
  (mock `fetch`); `karaoke-view` predicates `isAtEnd`/`isJumpBack` (extract).
- Env note: the test runner has no DOM/localStorage, so those need a small `globalThis`
  stub (see `persist.test.ts`); `mock.module` is the house pattern.

---

## Suggested order

1. ✅ **Tier-0** (done, `f6860da`).
2. **Perf in React** (framework-free): cap the ACF loop, take the highway off per-frame
   `setState` (marker/trail/track imperative), incremental `scoring.read()`, marker →
   `transform`, gold-shimmer overlay. Measure — this is the data that decides the rewrite.
3. **Robustness + cleanup:** helperDown classification, session-advance toasts, the safe
   dead-code deletes, `theme.ts` + `storage-keys.ts`.
4. **Rewrite decision** — if perf-in-React isn't enough, budget ~8–12 days and de-risk the
   Solid build-tooling spike first.
