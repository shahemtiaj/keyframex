# KeyframeX scene format (`keyframex.scene`, version 1)

The scene is the single contract between the converter, the After Effects
builder, the CLI and anyone writing scenes by hand. Full JSON Schema: `engine/schema/scene.schema.json`.
Complete example: `examples/hand-written-scene.json`.

```jsonc
{
  "format": "keyframex.scene", "version": 1,
  "comp": { "name": "Promo", "width": 1920, "height": 1080, "fps": 30, "duration": 8, "bgColor": [0,0,0] },
  "assets": [{ "id": "a1", "kind": "image", "path": "/abs/photo.png", "rel": "assets/photo.png" }],
  "fonts": [{ "family": "Inter", "postScriptName": "Inter-Bold", "weight": 700 }],
  "layers": [ /* top → bottom */ ],
  "notes": [{ "kind": "approx", "message": "…", "layers": ["card"] }]
}
```

## Tracks
`{ "value": v }` or `{ "keys": [ { "t": 0.5, "v": [960, 540], "interp": "bezier", "eo": [[0, 33.3]] }, … ], "spatial": true }`

| Field | Meaning |
|---|---|
| `t` | seconds |
| `v` | value (units below) |
| `interp` | interpolation of the segment leaving this key: `bezier`, `linear` (default), `hold` |
| `ei` / `eo` | ease into / out of the key: `[[speed, influence%]]` — one pair for spatial and 1-D properties, one per dimension otherwise |

Units: position/size px (comp space), scale %, rotation degrees, opacity 0–100,
colours `[r,g,b]` 0–1, trim 0–100, text tracking 1/1000 em, leading px.

## Layers
Common: `id` (unique), `type`, `name`, `comment`, `in`, `out`, `blend` (AE BlendingMode name),
`matte` (id of a matte layer), `matteSource`, `parent`, `transform { anchor, position, scale, rotation, opacity }`, `effects[]`.

| type | Fields |
|---|---|
| `shape` | `shape: { kind: rect|ellipse|path, size, roundness, paths, fillRule }`, `fill { color, opacity }`, `stroke { color, width, opacity, cap, join, dashes, dashOffset }`, `trim { start, end }` |
| `text` | `text: { source, font, size, tracking, leading, justify, color, stroke, noFill, counter { prefix, suffix, decimals, commas, value } }` |
| `image` / `video` | `asset`, `box` ([w,h] of the HTML box), `fit` (fill/cover/contain/none), `cornerRadius`, `timeRemap`, `muted` |
| `audio` | `asset`, `startAt` |
| `solid` | `color` |
| `null` | – |

Effects: `dropShadow { color, opacity, direction, distance, softness }`, `blur { amount }`,
`fill { color }`, `gradient { kind, start, end, colors, box }`.

Conventions the builder relies on: shape contents are centred on the anchor; text
anchor `[0,0]` is the first baseline at the justification point; footage anchor is
the source centre (leave `anchor` out for footage).
