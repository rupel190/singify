# Handoff

One task: make a Marketplace install usable before singify goes on the Marketplace.

Already done, don't redo: repo topics, `homepageUrl`, `manifest.json`, the helper/platform
notices (README banner, manifest description, and the `.notice` block on
`rupelxyz/singify/index.html`), and the `.gitignore` carve-out that lets `dist/karaoke.js`
be committed (`dist/*` + `!dist/karaoke.js` — `dist/` alone can't work, git never descends
into an excluded directory).

**The `spicetify-extensions` topic has been deliberately removed.** That topic is the
Marketplace's entire discovery mechanism — there is no review queue, no submission form.
Re-add it as the last step below, not before. Right now a Marketplace install could
never load a chart, and there is exactly one first impression per user.

---

## Make a Marketplace install usable without the helper

**Goal:** someone who installs from the Marketplace and has not set up the Bun helper can
still sing. **Non-goal:** replacing the helper — it stays the good path (USDB auto-download,
disk cache, XDG mirrors). This is a floor.

The renderer already knows when it's alone. `src/index.ts:752-764` keeps a `helperDown`
flag set by `helperIsUnreachable()`, which probes `/health` specifically so a code bug is
never misreported as a missing helper. That flag already reaches the UI:
`src/session-view.tsx:981` branches to `<HelperDownNotice>`. **Use that branch. Do not add a
second detection path.**

The parser needs nothing: `parse(raw: string)` at `src/ultrastar-parser.ts:88` is pure —
string in, `ParsedSong` out, no fs, no network. A dropped `.txt` is just a string. Note the
harness already does exactly this (`bun run dev` → *Load .txt…*), so the interaction exists
and only needs lifting into the Spotify adapter.

1. **Accept a chart in `HelperDownNotice`** (`src/session-view.tsx`, below ~line 1005).
   Drop zone *plus* a real `<input type="file" accept=".txt">` — drag-and-drop alone is
   undiscoverable and unusable on a TV, which is a first-class target here. Feed the result
   into the same path a resolved chart takes.
2. **Report parse failures with the failing line.** `parse()` throws on malformed input;
   "that doesn't look like an UltraStar file" is not enough for someone who just downloaded
   a random `.txt`.
3. **Remember it without the helper.** Persist by Spotify track id. `src/persist.ts` already
   owns the localStorage-is-live / helper-is-the-mirror split — extend it, make the mirror a
   no-op while `helperDown`. Charts are a few KB and localStorage is ~5 MB, so cap the count
   and evict oldest.
4. **Say where charts come from.** Link <https://usdb.animux.de/> from the empty state.
   Nothing in the UI currently tells a new user that UltraStar files are a thing.
5. **Reframe the notice** as "load a file, or set up the helper for automatic download",
   with the helper as the upgrade rather than the requirement.

**Verify the way a stranger would:** `bun run dev` with the helper *stopped*. That is the
Marketplace user's exact situation and the only test that matters here.

**Then:** `bun run build`, commit `dist/karaoke.js`, soften the warnings in `manifest.json`,
the README banner and the landing-page `.notice` from "there is nothing to sing" to "manual
charts work, the helper adds automatic download" — and re-add the `spicetify-extensions`
topic.

---

---

## Offsets

Moved out of this file — see [README.md](README.md) for what an offset is and
[TODO.md](TODO.md) for the sharing plan.

## Also open

- `server/helper.ts` and `server/helper.test.ts` had uncommitted local changes when this
  was written. Check them before staging anything.
- Optional live-resolve in the harness — point it at the running helper so real charts
  render in-browser (today it uses mock candidates).
- Solo Quick-Sing stats — only session rounds are recorded; wire `onComplete` for solo.
