# Handoff

Three pieces of work. **A** must ship before singify goes on the Spicetify Marketplace.
**B** is a pair of offset issues — one deferred by the owner, one live and worth fixing on
its own. **C** is offset sharing, and it needs the live half of B.

Already done, don't redo: repo topics, `homepageUrl`, `manifest.json`, the helper/platform
notices (README banner, manifest description, and the `.notice` block on
`rupelxyz/singify/index.html`), and the `.gitignore` carve-out that lets `dist/karaoke.js`
be committed (`dist/*` + `!dist/karaoke.js` — `dist/` alone can't work, git never descends
into an excluded directory).

**The `spicetify-extensions` topic has been deliberately removed.** That topic is the
Marketplace's entire discovery mechanism — there is no review queue, no submission form.
Re-add it as the last step of task A, not before. Right now a Marketplace install could
never load a chart, and there is exactly one first impression per user.

---

## A. Make a Marketplace install usable without the helper

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

## B. Offsets: what's deferred, and what isn't

**Owner's call: the baseline split is deferred.** Everything here is HDMI and cabled, and a
wired headset measured no worse than the speakers, so the device term is near-constant in
practice. A single global latency setting is the intended fix and it can come later. Do not
treat the split as a blocker for C.

**What is not deferred:** `punchSync()` writes unvalidated. See "the punch problem" below.
That one is worth doing on its own, and task C's export depends on it.

### The deferred part, for whenever it comes up

`src/index.ts:125-175`. The stored per-track offset is an **absolute** number, and it folds
together two things that have nothing to do with each other:

- **Output latency** — a property of *your* audio path. Wired vs Bluetooth differs by
  150–300 ms.
- **Chart GAP error** — a property of *the UltraStar file* against Spotify's master. Usually
  tens of ms, and the same for everybody.

`defaultOffset` is commented as "a device latency baseline", but it is only a *seed* for
untuned tracks. The moment you nudge a track, the value written to
`OFFSET_PREFIX + trackId` is absolute and has your headphone latency baked into it.

Two consequences:

- Switch headphones and **every** tuned track is wrong by the same constant. With 107 tuned
  tracks the only remedy today is retuning all of them. (Deferred: the setup is cabled, so
  this term barely moves in practice.)
- A shared offsets file is meaningless. Every value carries its contributor's audio path.

**Fix:** store the per-track value as a delta against the baseline.

```
effectiveOffset = deviceBaseline + trackDelta
```

- `deviceBaseline` — one global number, `DEFAULT_OFFSET_KEY`, belongs in the *settings*
  store (`~/.config/singify/settings.json`). It is configuration, not data.
- `trackDelta` — per track, belongs in the *offsets* store
  (`~/.local/share/singify/offsets.json`). It is the device-independent, shareable quantity.

Give the user a way to set the baseline directly — a calibration step, or simply "apply this
nudge to all tracks instead of this one". Changing headphones should be one knob.

**Migration is required and must run once.** Existing values are absolute. Version the
offsets document (`{ "v": 2, "offsets": { … } }`), and on first load under v2 subtract the
current `defaultOffset` from every stored per-track value. An unversioned document is v1.
Get this wrong and you silently double-apply the baseline on every tuned song.

### The punch problem — this one is live

`~/.local/share/singify/offsets.json` has content now that the CORS/persistence bug is fixed
(`baf8c3e`). 107 tuned tracks, values stored as strings. The distribution:

```
within ±200 ms      20 / 107
within ±1 s         47 / 107
within ±2 s         54 / 107
beyond ±2 s         53 / 107
largest magnitudes  92956, 48232, -46816, 44953 ms
```

**A large value is not automatically wrong.** An UltraStar chart cut against a different
release — album version vs single edit, or a version with a long intro — genuinely needs a
multi-second offset, and the owner reports roughly 80% of these working in practice. Treat
the file as a good default, not as junk.

The actual problem is that **you cannot tell a legitimate large offset from a mis-punch.**
`punchSync()` (`src/index.ts:238`) writes `firstMs - getBaseMs()`, so the stored value
absorbs the playback position at the instant you tapped. The comment assumes you press `P` on
the first sung word; nothing enforces it. Punch at 0:45 by accident and a 45-second "offset"
is persisted, indistinguishable from a chart that really is 45 seconds out.

So:

- **Give the write a sanity check.** Not a hard rejection — large values are sometimes right —
  but `punchSync()` should confirm before persisting anything past a few seconds
  ("that's a 45 s shift, sure?"), and the readout should make the magnitude obvious.
- **Make them auditable.** A list of tuned tracks sorted by |offset| would let a human clear
  the mistakes in one pass. There is no way to see or clear a bad punch today short of
  editing the JSON.
- **Never export raw.** Task C's export needs a confirmation step or a plausibility gate;
  publishing the file as-is would ship whatever mis-punches are in it.

Within ±2 s the numbers look like what you'd expect: median −183 ms, stdev 565 ms.

---

## C. Shared offsets

Only after B. Your instinct that the XDG path makes this awkward is right, and the resolution
is that these are two different objects:

- `~/.local/share/singify/offsets.json` — **your live state.** Machine-local, written by the
  helper on every nudge, never in git. Leave it exactly where it is.
- `offsets/` **in the repo** — a folder of curated packs, not one blessed file. Owner's call,
  and it's the better shape: `offsets/community.json` as the general pool, but nothing stops
  `offsets/eurovision.json` or someone's personal pack living alongside it. The user picks
  which to import, or imports several and merges.

Committing the live XDG file would be wrong; having a shared dataset in the repo is not. The
repo is in fact the right home: it is already how people get the extension, PRs give you
review, and git gives you merge, history and blame for free. No server, no account, no
moderation queue.

**Record shape.** Not a bare number — a measurement with noise needs to carry its evidence:

```json
{
  "v": 2,
  "offsets": {
    "spotify:track:1KrpXYLMCJ8GaDSz61FQNU": {
      "usdbId": 7016,
      "deltaMs": -40,
      "samples": 3,
      "artist": "Jonathan Coulton",
      "title": "Re: Your Brains"
    }
  }
}
```

`usdbId` matters: the delta is only valid for *that* chart. A different USDB entry for the
same Spotify track is a different GAP and a different delta.

Artist and title are denormalised on purpose — they make the file diffable by a human
reviewing a PR, and they are what a generated web page would list.

**Merge rule: median, not last-write-wins.** Two contributors measuring the same track will
differ by a few ms; whoever pushed last is not more correct. Median over samples, and drop
outliers beyond a threshold (say ±150 ms from the median) rather than averaging them in — a
big outlier is almost always someone who hadn't calibrated their baseline.

**Import is opt-in and never silently overwrites.** A user's own tuning for a track always
wins over the community value. Import fills gaps.

**Commands to add.** `bun run offsets:export` (live store → a PR-ready fragment, only tracks
you've actually tuned) and `bun run offsets:import <pack>` (a pack → gaps in the live store).
Import takes a path or a name so several packs can be layered. Keep both out of the extension
bundle; they're helper-side.

**Then the landing page gets its list.** `offsets/community.json` is a real, legally clean,
per-track dataset — artist, title, USDB id — and it answers the question every visitor has
before installing: *will it know my songs?* Chart `.txt` files can never be republished
(they're USDB's, and `charts/` is gitignored for that reason); this metadata can.

---

## Also open

- `server/helper.ts` and `server/helper.test.ts` have uncommitted local changes that predate
  this work. Look at them before staging anything.
- Optional live-resolve in the harness — point it at the running helper so real charts render
  in-browser (today it uses mock candidates).
- Solo Quick-Sing stats — only session rounds are recorded; wire `onComplete` for solo.
