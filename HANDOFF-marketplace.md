# Handoff — make the Marketplace install usable standalone

**Goal:** someone who installs singify from the Spicetify Marketplace, and who has *not*
set up the Bun helper, should still be able to sing a song. Today they get an overlay that
can never load a chart, which makes the listing worse than no listing.

**Non-goal:** replacing the helper. The helper stays the good path — USDB auto-download,
on-disk cache, XDG mirrors. This is a floor, not a replacement.

## The shape of the fix

The renderer already knows when it's alone. `src/index.ts` keeps a `helperDown` flag,
set by `helperIsUnreachable()` which probes `/health` (`src/index.ts:752-764`) precisely so
a code bug is never misreported as a missing helper. That flag already reaches the UI —
`src/session-view.tsx:981` branches to `<HelperDownNotice>`.

So the whole feature slots into an existing, correct branch. **Do not add a second
helper-detection path.**

The parser needs nothing. `parse(raw: string)` in `src/ultrastar-parser.ts:88` is pure —
string in, `ParsedSong` out, no filesystem, no network. It already runs in the renderer.
A dropped `.txt` is just a string.

## Work

1. **Accept a chart file in `HelperDownNotice`** (`src/session-view.tsx`, below line ~1005).
   Add a drop zone plus a normal `<input type="file" accept=".txt">` — drag-and-drop alone
   is undiscoverable and unusable on a TV. Read with `File.text()`, hand to `parse()`, and
   feed the result down the same path a resolved chart takes today.

2. **Surface parse failures properly.** `parse()` throws on a malformed chart. Catch it and
   say which line broke — "that doesn't look like an UltraStar file" is not enough when
   someone has just downloaded a `.txt` from a random site.

3. **Remember it without the helper.** Charts loaded this way should survive a restart, so
   persist them keyed by Spotify track id. `src/persist.ts` already owns the
   localStorage-is-live / helper-is-the-mirror split — extend that rather than inventing a
   new store, and make the mirror step a no-op when `helperDown`. Watch the size: charts are
   a few KB each, localStorage is ~5 MB, so cap the count and evict oldest.

4. **Point people at the charts.** The empty state should link to
   <https://usdb.animux.de/> and say in one line what to search for and what to save. Right
   now nothing in the UI tells a new user where UltraStar files come from.

5. **Say it in the notice, not just the README.** `HelperDownNotice` should read as "load a
   file, or set up the helper for automatic download", with the helper framed as the upgrade.

## Check it the way a stranger would

Run the browser harness (`bun run dev`) with the helper **stopped**. That is exactly the
Marketplace user's situation, and it is the only test that matters here. The existing
`server/store.test.ts` pattern (overriding `XDG_*` into a temp dir) is the model for any new
persistence test.

## Then, and only then

- `bun run build` and commit `dist/karaoke.js` — `.gitignore` allows that one path
  (`dist/*` + `!dist/karaoke.js`).
- Soften the warning in `manifest.json` and the README banner from "there is nothing to
  sing" to "manual charts work, the helper adds automatic download".
- Same edit on the landing page: `rupelxyz/singify/index.html`, the `.notice` block.
