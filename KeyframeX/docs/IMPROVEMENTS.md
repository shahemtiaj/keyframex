# KeyframeX vs. the old extension (CodeFlow 2.0.0)

The old extension in `Old/` is **CodeFlow 2.0.0 by Ae Flow Tools**. Its panel logic
(`main.js`, 625 KB), converter (`converter.js`, 531 KB) and bridge (`server.js`) are
obfuscated, its After Effects builder (`host/core.bin`) is encrypted, and its license
forbids reverse engineering. KeyframeX was therefore written from scratch
(clean-room). It is based on what CodeFlow documents publicly (manual, skill docs),
its manifest and its panel's HTML layout. No CodeFlow code was decompiled, copied or adapted.

## What the old extension did (from its documentation)

HTML motion page → headless Chrome → frame-by-frame reading → AE comps with text,
shapes, masks, 3D camera, blend modes, footage, counters; Light/Balanced/Exact keyframe
density; build into a new or the active comp; online media download + relink; font
install; a license gate (online check on open and before every build, 5 free builds);
one Claude-only skill.

## Improvements

| Area | Old | KeyframeX |
|---|---|---|
| Code | Obfuscated + encrypted, cannot be audited or extended | Readable, documented, modular (engine / host / panel), zero npm dependencies |
| Availability | Online license check on open and before each build; stops offline | Works offline; no accounts, no trial limits |
| Intermediate format | Internal | Public **scene format** with JSON Schema + validator. Scenes can be rebuilt without re-converting, edited by hand, or written directly by an AI |
| Time control | (undocumented) | Virtual clock for Date/performance/rAF/timers/CSS/WAAPI/SMIL/media + seeded random, so captures are deterministic |
| Geometry | (undocumented) | Chrome's transformed box quads, sub-pixel sizes, exact 2D decomposition, least-squares fit for 3D, SVG CTM + viewBox |
| Keyframes | Light / Balanced / Exact | Same presets, documented algorithm: one eased segment per motion, split at turning points, output as real AE speed/influence eases; measured error bound |
| Text | Text layers | Text layers placed on the browser's exact first baseline, wrapped lines rebuilt, centred/right alignment, tracking, leading, stroke, shadow; colour animation via Fill effect; counters with comma grouping/decimals; source-text holds |
| Clipping | Precomps with masks | Track mattes (AE 2023 API), per-layer fallback on AE 2022; `clip-path` inset/circle/ellipse/polygon/path, animated |
| Robustness | – | Every host call returns structured JSON; one undo group per build; per-layer error isolation; builds never overwrite; host script auto-reloads; serialized evalScript queue |
| Skills | One Claude skill | 4 vendor-neutral skills (write HTML, convert & build, write scenes directly, troubleshoot) |
| Automation | – | **CLI** (`convert`, `validate`) using the same engine as the panel |
| UI | One-column card layout | Same layout style, plus: cancel during conversion, recent files, clickable notes, AE connection dot, reload button that reloads the host script, "convert again" hint when the keyframe setting changes |
| Footprint | CSInterface.js shipped twice (80 KB) + ~1.4 MB obfuscated JS | 3 KB CEP helper; ~300 KB of readable source in total |
| Tests | – | 25 automated tests incl. real-browser conversion and a strict AE DOM mock |

In-panel AI generation and the local API for AI agents were built in 1.0 and removed in
1.1 (not needed for now); see CHANGELOG.md.

## Known gaps vs. the old extension (honest list)

- **CSS 3D** is flattened to the closest 2D transform. CodeFlow built an AE camera with
  3D layers. This is the most visible gap; see the conversion note for the error in px.
- **Parent nulls** are not generated: every layer gets world-space keyframes. That is accurate,
  but a container that moves many children is not a single control.
- `backdrop-filter` (frosted glass) is not converted (CodeFlow doesn't either).
- Only the nearest clipping container is applied when clips are nested.
- Online media is downloaded automatically during conversion; failed downloads become
  placeholders; the **Online media** card has **Relink in AE** (no separate "Download all" button).

These are natural next steps; the architecture document says where each one plugs in.
