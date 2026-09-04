# TODO

## Before the Marketplace

- [x] Repo topics, `homepageUrl`, `manifest.json`
- [x] Helper + platform caveats stated up front (README banner, manifest, landing page)
- [x] `.gitignore` lets `dist/karaoke.js` through (`dist/*` + `!dist/karaoke.js`)
- [ ] Manual `.txt` fallback so an install without the helper still works —
      see [HANDOFF.md](HANDOFF.md)
- [ ] Commit `dist/karaoke.js`
- [ ] Re-add the `spicetify-extensions` topic — it is the Marketplace's only discovery
      mechanism, and it is deliberately off until the above lands

## Shared offsets

What an offset *is* — and why it's the shareable part of a tuned library — is in the
README. The plan for sharing them:

- **The XDG file stays put.** `~/.local/share/singify/offsets.json` is live machine
  state, helper-written on every nudge, never in git.
- **`offsets/` in the repo holds packs**, not one blessed file: `offsets/community.json`
  as the general pool, with nothing stopping `offsets/eurovision.json` or somebody's
  personal pack beside it. Import takes a path, so several can be layered.
- **Records carry evidence, not a bare number:**

  ```json
  {
    "v": 1,
    "offsets": {
      "spotify:track:1KrpXYLMCJ8GaDSz61FQNU": {
        "usdbId": 7016,
        "offsetMs": -40,
        "samples": 3,
        "artist": "Jonathan Coulton",
        "title": "Re: Your Brains"
      }
    }
  }
  ```

  `usdbId` is load-bearing — an offset is only valid for *that* chart, and a different
  USDB entry for the same Spotify track is a different `GAP`. Artist and title are
  denormalised so a pull request diff is readable by a human.

- **Merge by median, not last-write-wins.** Two people tuning the same track differ by a
  few ms and whoever pushed last isn't more right. Reject outliers rather than averaging
  them in.
- **Import fills gaps and never overwrites** a track you've tuned yourself.
- **Export asks before publishing.** Tuning is self-validating in play, but a mis-tap that
  you never went back to fix is indistinguishable from a genuinely large offset once it
  leaves your machine. A confirmation pass beats a threshold.
- `bun run offsets:export` / `bun run offsets:import <pack>`, helper-side, out of the
  extension bundle.

## Product

- [ ] Live resolve in the browser harness (today: mock candidates)
- [ ] Solo Quick-Sing stats — only session rounds are recorded
- [ ] Global output-latency setting, so the per-track offset carries only chart error
