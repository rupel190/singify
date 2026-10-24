# Handoff

**Marketplace status:** an install without the helper now works — the no-chart screen offers
**Load chart file**, the chart is remembered per Spotify track in localStorage (30 max, LRU)
and auto-sync times it. Verified in a real client with the helper stopped.

**Still open, on purpose:** what to do about the helper itself for Marketplace users — clear
in-app onboarding, or moving USDB download into the extension. Until that's decided the
`spicetify-extensions` GitHub topic (the Marketplace's only discovery mechanism) stays off.

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
