# TODO

Work items live in [HANDOFF.md](HANDOFF.md). This is the short list.

## Before the Marketplace

- [x] Repo topics, `homepageUrl`, `manifest.json`
- [x] Helper + platform caveats stated up front (README banner, manifest, landing page)
- [x] `.gitignore` lets `dist/karaoke.js` through (`dist/*` + `!dist/karaoke.js`)
- [ ] Manual `.txt` fallback so an install without the helper still works — **HANDOFF task A**
- [ ] Commit `dist/karaoke.js`
- [ ] Re-add the `spicetify-extensions` topic — it is the Marketplace's only discovery
      mechanism, and it is deliberately off until the above lands

## Offsets

- [ ] Split per-track offset from the device baseline — **HANDOFF task B**. A real bug on its
      own: change headphones today and every tuned track is wrong by the same constant.
- [ ] Shared `offsets/community.json` — **HANDOFF task C**. Needs B first.

## Product

- [ ] Live resolve in the browser harness (today: mock candidates)
- [ ] Solo Quick-Sing stats — only session rounds are recorded
