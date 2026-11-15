---
name: keyframex-convert-build
description: Convert an HTML motion page into a KeyframeX scene with the keyframex CLI, check the result, and hand it to the user to build in After Effects with the KeyframeX panel. Use when the user asks to "convert with KeyframeX", "check if this converts", or wants the After Effects version of an HTML animation you just wrote.
---

# Convert with KeyframeX

KeyframeX has two entry points that run the same engine:

| Entry point | Needs | Use for |
|---|---|---|
| **Panel** (After Effects → Window → Extensions → KeyframeX) | the user, After Effects | drop the HTML → it converts → **Build in After Effects** |
| **CLI** `node <KeyframeX>/cli/keyframex.js` | Node 15+, Chrome/Edge | convert + validate without After Effects, to check the page before handing it over |

## Inputs
- Absolute path to an `.html` page.
- Optional: `--fps`, `--duration` (s), `--quality` (`light` | `balanced` | `exact`).

## Output
- `<page folder>/<Name> (KeyframeX)/scene.json`, `report.md`, `assets/`, maybe `ONLINE MEDIA.txt`.
- A short report for the user, plus how to build it.

## Steps
1. Convert:
   ```
   node <KeyframeX>/cli/keyframex.js convert /abs/page.html --quality balanced --json
   ```
   This takes 5–60 s.
2. Read the JSON answer: `report` (layers, keyframes), `notes`, `fonts`, `media.online` / `media.missing`.
   - `page-error` notes → the page throws JavaScript errors; fix the HTML and convert again.
   - `missing` notes → an asset did not load; fix its path (relative to the HTML).
   - `approx` / `skip` notes → tell the user which parts are approximated, or rebuild them from plain elements.
3. Tell the user:
   - the scene folder path;
   - to build it: open **Window → Extensions → KeyframeX**, drop the HTML (or the `scene.json`
     / its folder) on the panel, choose **Build into** and **Keyframes**, click **Build in After Effects**;
   - the fonts it needs (the panel can install Google Fonts / @font-face fonts for After Effects);
   - anything approximated.

## Errors and edge cases
- "needs Google Chrome, Microsoft Edge…" → install Chrome or Edge, or pass `--browser /path/to/chrome`.
- Wrong length → pass `--duration`, or add `const DURATION = n;` to the page.
- Wrong size → the page needs a fixed-size `#stage` element.
- No Node on the machine → skip the CLI; the user drops the HTML on the panel directly.
