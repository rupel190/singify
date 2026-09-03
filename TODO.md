# TODO

## Getting it in front of people

Ordered by return, not by effort.

- [x] GitHub topics — `spicetify-extensions` is not decoration, it's how the Marketplace
      *discovers* the repo. The other topics (`karaoke`, `ultrastar`, `singstar`, …) feed
      GitHub's topic pages, which are crawled.
- [x] `manifest.json` at repo root — required alongside the topic. `main` points at
      `dist/karaoke.js`, so **the built bundle has to be committed** (`.gitignore` now lets
      exactly that one file through).
- [x] Repo homepage → <https://rupel.xyz/singify>
- [x] Helper + platform caveats stated up front — README banner, `manifest.json`
      description, and the landing page notice.
- [ ] **Nothing above is pushed yet.** The topics and homepage are GitHub settings and are
      live; `manifest.json`, the `.gitignore` change and the bundle are still local. The
      Marketplace cannot see any of it until it's committed and pushed.
- [ ] **Commit `dist/karaoke.js`** — until then the Marketplace listing installs nothing.
- [ ] **Manual `.txt` fallback so the listing is honest** — see
      [HANDOFF-marketplace.md](HANDOFF-marketplace.md). Right now a Marketplace install can
      never load a chart. Worth doing *before* listing rather than after.
- [ ] Announcement posts — r/spicetify, r/ultrastar, Spicetify Discord. Low appetite for
      these; they can wait, and the Marketplace listing does most of the same job without
      the self-promotion tax.

## Product

- **Optional "live resolve" in the harness** — point the browser harness at the running
  helper so real charts render in-browser (today it uses mock candidates).
- **Solo Quick-Sing stats** — today only session rounds are recorded; wire `onComplete` for
  solo so practice runs count too.
