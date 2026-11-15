# KeyframeX

**Turn HTML motion videos into native, editable After Effects compositions.**

KeyframeX is an After Effects panel (CEP, AE 2022+, macOS & Windows). Drop an HTML
animation on it — made with CSS, GSAP, Web Animations, SVG, `requestAnimationFrame`
or canvas — and it plays the page frame by frame in a hidden Chrome/Edge, then
rebuilds it as real After Effects layers: text layers in the right font, shape
layers, track mattes, effects, footage, audio, and keyframes with proper bezier eases.

## Quick start

1. Install: `bash install/install-mac.sh` (macOS) or `install\install-windows.cmd` (Windows), then restart After Effects. Details: [docs/INSTALL.md](docs/INSTALL.md).
2. **Window → Extensions → KeyframeX**.
3. Drop an `.html` file on the panel (try `tests/fixtures/basic.html`). It converts automatically and shows the progress in %.
4. Check the layers, keyframes, length, fonts and notes. Pick **Build into** (New comps / Active comp) and **Keyframes** (Light / Balanced / Exact) → **Build in After Effects**.

Wrong length? Click **Change length**, type the seconds and convert again. Pictures or
clips loaded from the web are downloaded next to the page; the **Online media** card lists
them and **Relink in AE** swaps placeholders for files you saved yourself.

## What converts

See [shared/authoring-guide.md](shared/authoring-guide.md) for the full table. In short:
transforms, opacity, colours, 2-colour gradients, borders, radius, shadows, blur, blend
modes, text (split per letter/word, counters, changing words), `overflow:hidden` and
`clip-path` (as mattes), SVG shapes/paths/morphs/draw-on/text, images (WebP/SVG → PNG),
video (time remap), audio, canvas (PNG sequence). CSS 3D is flattened to 2D.

## For developers

| | |
|---|---|
| Architecture | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Scene format | [docs/SCENE_FORMAT.md](docs/SCENE_FORMAT.md), [engine/schema/scene.schema.json](engine/schema/scene.schema.json) |
| Tests | `node tests/run.js` — [docs/TESTING.md](docs/TESTING.md) |
| CLI | `node cli/keyframex.js help` |
| vs. the old extension | [docs/IMPROVEMENTS.md](docs/IMPROVEMENTS.md) |
| Changes | [docs/CHANGELOG.md](docs/CHANGELOG.md) |

No build step and no npm dependencies.
