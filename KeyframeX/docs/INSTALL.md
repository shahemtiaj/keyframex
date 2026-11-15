# Installing KeyframeX

**Requirements:** After Effects 2022 (v22) or newer on macOS or Windows, and Google
Chrome, Microsoft Edge, Brave or Chromium on the same computer (KeyframeX uses it
invisibly in the background to read pages). No Node.js, npm or other installs are needed.

## Option A: install script (unsigned, recommended for now)

KeyframeX ships as source. CEP loads unsigned extensions only when "debug mode"
is on. The scripts copy the extension into your user's CEP folder and switch that on.

**macOS**
```bash
cd "/path/to/New/KeyframeX/install"
bash install-mac.sh            # copies to ~/Library/Application Support/Adobe/CEP/extensions/KeyframeX
# bash install-mac.sh --link   # developers: symlink instead, so edits apply on panel reload
```

**Windows** — double-click `install\install-windows.cmd` (copies to
`%APPDATA%\Adobe\CEP\extensions\KeyframeX`).

Then **restart After Effects** and open **Window → Extensions → KeyframeX**.

The scripts also move any **other** KeyframeX copy found in the CEP extensions folders
to the Trash. After Effects loads every folder there, and a second copy can be loaded
instead of this one, with a different panel and different errors.

## Option B: signed ZXP

```bash
bash install/package-zxp.sh /path/to/ZXPSignCmd            # self-signed
bash install/package-zxp.sh /path/to/ZXPSignCmd cert.p12 pw # your certificate
```
Install `dist/KeyframeX-1.1.0.zxp` with a ZXP installer (aescripts ZXP Installer,
Anastasiy's Extension Manager). Signed installs don't need debug mode.

## First run

1. The dot in the header turns green when the panel can talk to After Effects
   (hover it to see the AE version). Red: click the reload button next to it.
2. Settings (gear): shows which browser KeyframeX found. Set a path if none is found.

## Data folder

| OS | Folder |
|---|---|
| macOS | `~/Library/Application Support/KeyframeX/` |
| Windows | `%APPDATA%\KeyframeX\` |

It holds `settings.json` (browser path, defaults, recent files).

## Uninstall

macOS: `bash install/uninstall-mac.sh`. Windows: delete
`%APPDATA%\Adobe\CEP\extensions\KeyframeX`. Delete the data folder to remove settings.

## Command line (optional)

With Node.js 15+ you can run the converter without After Effects (drop the resulting `scene.json` on the panel to build it):
```bash
node KeyframeX/cli/keyframex.js convert page.html --quality balanced
node KeyframeX/cli/keyframex.js validate "page (KeyframeX)/scene.json"
```
