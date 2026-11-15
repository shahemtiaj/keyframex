---
name: keyframex-scene-json
description: Write or edit a KeyframeX scene.json — a plain-JSON description of an After Effects composition (layers, keyframes with eases, text, shapes, mattes, effects) that the KeyframeX extension builds natively. Use when the user wants precise After Effects keyframes without going through HTML, wants to tweak a converted scene (timing, colours, text, easing), or asks an AI to "make an AE comp" directly.
---

# Author KeyframeX scenes directly

A scene is the contract between KeyframeX's converter and its After Effects
builder, so anything you write in it becomes native layers and keyframes.
`references/scene.schema.json` is the full JSON Schema; `references/example-scene.json`
is a complete, valid example (text with source-text keys, a Counter, Trim Paths,
an ellipse, a rounded rect with drop shadow, a solid).

## Inputs
- What the comp should contain and do, or an existing `scene.json` to change.

## Output
- A valid `scene.json` (format `keyframex.scene`, version 1), plus a validation result.

## Model
- `comp`: `name, width, height, fps, duration (s), bgColor [r,g,b 0–1]`.
- `layers`: **top → bottom**. Types: `shape` (rect / ellipse / path), `text`, `image`,
  `video`, `audio`, `solid`, `null`. Every layer needs a unique `id`.
- Tracks: `{ "value": v }` or `{ "keys": [{ "t": sec, "v": value, "interp": "bezier"|"linear"|"hold", "ei": [[speed, influence]], "eo": [[speed, influence]] }] }`.
  - Units: position px (comp space), scale %, rotation degrees, opacity 0–100, colours 0–1.
  - Ease: `[speed, influence%]`, one pair for position (spatial) and 1-D values, one pair
    **per dimension** for scale/size. Easy ease = `[0, 33.33]` on both sides; a strong
    ease-out into a key = `ei: [[0, 80]]`. Influence must be 0.1–100.
  - Keys must be in time order. `interp` describes the segment LEAVING the key.
- Shape layers: content is centred on the layer's anchor (default [0,0]); `rect`/`ellipse`
  take `size`; `path` takes `paths` = array of `{v, i, o, c}` (tangents relative to vertices).
- Text: `source` (string or hold keys), `font` (`postScriptName` preferred), `size`, `justify`,
  `tracking` (1/1000 em), `leading` px, `color`. Anchor [0,0] = first baseline at the
  justification point. `counter` makes a Counter slider drive the text.
- Mattes: give the matte layer `"matteSource": true` and set `"matte": "<matte id>"` on the layers it clips.
- Footage: add to `assets` (`id`, `kind`, `path` absolute or `rel` to the scene file) and reference by `asset`.
- Effects: `dropShadow`, `blur`, `fill` (colour), `gradient` (2-colour ramp).

## Steps
1. Start from `references/example-scene.json`; keep ids unique and layers top → bottom.
2. Write times in seconds within `comp.duration`; keep keys ordered.
3. Validate before handing it over:
   `node <KeyframeX>/cli/keyframex.js validate scene.json --json`.
   Fix every error it lists (they name the exact field).
4. Build: the user drops the `scene.json` (or its folder) on the KeyframeX panel and clicks
   **Build in After Effects**. The panel validates it again and lists any problem in its Activity log.

## Edge cases
- Unknown font → the layer uses After Effects' default font; the panel lists it as a missing font after the build.
- A layer with neither fill nor stroke is invisible (validation warns).
- `in`/`out` trim the layer; `out` must be after `in`.
- Editing a converted scene: keep `source`/`notes` as they are; change only layers/keys.
