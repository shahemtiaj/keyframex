# Contributing to KeyframeX

## Setup

There is nothing to install. The extension, the engine and the tests use only Node.js
built-ins and the Chrome or Edge already on your computer.

```bash
git clone https://github.com/shahemtiaj/keyframex.git
cd keyframex/KeyframeX
node tests/run.js                 # 38 tests
bash install/install-mac.sh --link   # macOS: symlink the panel, so edits apply on panel reload
```

With `--link`, panel changes (`client/`, `engine/`, `shared/`) apply when you close and
reopen the panel. After changing `host/keyframex.jsx`, use the panel's reload button or
restart After Effects.

## Ground rules

- **Zero dependencies.** No npm packages in the extension or engine. The test runner uses
  `acorn` only for the ES3 check, and skips that check when acorn isn't installed.
- **The host is ES3 in one file.** `host/keyframex.jsx` runs in After Effects'
  ExtendScript: no `let`/`const`, arrow functions or template strings, and no reserved
  words as object keys (`in`, `out`, `class`…). Quote them (`'in': …`). A test checks
  this.
- **Every entry point of the host returns a JSON string** and never throws.
- **Never claim a fix works in After Effects without checking it there.** The mock in
  `tests/mock-ae.js` is strict, but it is not After Effects. When you find a real After
  Effects quirk, teach it to the mock and add a test.
- **Keep `KeyframeX/shared/authoring-guide.md` and
  `skills/keyframex-html-motion/references/authoring-guide.md` identical.** A test checks
  this.

## Fixing a conversion problem

1. Reproduce it with a small page in `KeyframeX/tests/fixtures/` (or add to `promo.html`).
2. Run `node tools/compare.js tests/fixtures/<page>.html --out /tmp/cmp` and look at the
   side-by-side images.
3. Fix the cause in `engine/` (sampling: `engine/page/sampler.js`; layers and keyframes:
   `engine/scene.js`; pictures: `engine/raster.js`) or in the host.
4. Add assertions to `tests/run.js`, run the whole suite, and check the result in After
   Effects. `tools/diag-text.jsx` (File › Scripts › Run Script File…) reports where text
   layers really landed.

## Releases

Bump the version in `KeyframeX/CSXS/manifest.xml` (twice), `KeyframeX/package.json` and
`VERSION` in `KeyframeX/host/keyframex.jsx`. Then add an entry to
`KeyframeX/docs/CHANGELOG.md` and update the version badge in `README.md`.
