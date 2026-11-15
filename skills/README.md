# KeyframeX AI skills

Reusable, vendor-neutral skills for working with the KeyframeX After Effects
extension: they help any AI assistant write HTML that converts cleanly, convert and
check it with the CLI, or write KeyframeX scenes directly. The extension itself has no
AI features; these skills only produce files that you drop on the panel.

Each skill is a folder with a `SKILL.md` (YAML front matter `name` +
`description`, then instructions) and optional `references/`. The format is the
open Agent Skills layout, and every file is plain Markdown/JSON — nothing is tied
to one AI vendor.

| Skill | Use it to |
|---|---|
| [`keyframex-html-motion`](keyframex-html-motion/SKILL.md) | Write HTML motion videos that convert into editable After Effects layers |
| [`keyframex-convert-build`](keyframex-convert-build/SKILL.md) | Convert a page with the CLI, read the notes, hand it over for building |
| [`keyframex-scene-json`](keyframex-scene-json/SKILL.md) | Write/edit `scene.json` directly for exact keyframes, eases, text, mattes |
| [`keyframex-troubleshoot`](keyframex-troubleshoot/SKILL.md) | Diagnose wrong size/length, fonts, placeholders, pictures, host-script errors |

## How the pieces fit

```
          brief ──► keyframex-html-motion ──► page.html
                                                  │
 keyframex-scene-json ──► scene.json ◄── KeyframeX engine (convert)
                              │
                              ▼
            KeyframeX panel (After Effects) ──► native comp
```

## Installing

- **Claude apps:** Settings → Capabilities → Skills → upload a zip of one skill folder.
- **Claude Code / other agents that read skill folders:** copy the folders into the
  agent's skills directory (for Claude Code: `~/.claude/skills/`).
- **Any other model:** paste the `SKILL.md` (and `references/` files) into the system
  prompt or a retrieval store.

The authoring guide in `keyframex-html-motion/references/authoring-guide.md` is a
copy of `KeyframeX/shared/authoring-guide.md`. The test suite fails if the two drift apart.
