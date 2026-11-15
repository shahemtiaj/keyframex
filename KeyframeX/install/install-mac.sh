#!/bin/bash
# KeyframeX — install for After Effects on macOS (unsigned install).
# Copies the extension into the per-user CEP folder, removes other copies that
# After Effects could load instead, and enables unsigned extensions (PlayerDebugMode)
# for CEP 9–13. Restart After Effects afterwards.
#   bash install-mac.sh          copy (normal)
#   bash install-mac.sh --link   developers: symlink to this folder instead
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
EXT_DIR="$HOME/Library/Application Support/Adobe/CEP/extensions"
DEST="$EXT_DIR/KeyframeX"
STAMP="$(date +%Y%m%d-%H%M%S)"
TRASH="$HOME/.Trash"

echo "Installing KeyframeX from: $SRC"
mkdir -p "$EXT_DIR"

# After Effects loads EVERY folder in the extensions folders. Any other folder that
# declares a KeyframeX bundle would compete with this one, so move them to the Trash.
for dir in "$EXT_DIR" "/Library/Application Support/Adobe/CEP/extensions"; do
  [ -d "$dir" ] || continue
  for ext in "$dir"/*; do
    [ -e "$ext" ] || continue
    [ "$ext" = "$DEST" ] && continue
    man="$ext/CSXS/manifest.xml"
    if [ -f "$man" ] && grep -qi 'KeyframeX' "$man"; then
      echo "Found another KeyframeX copy: $ext"
      if mv "$ext" "$TRASH/$(basename "$ext")-$STAMP" 2>/dev/null; then
        echo "  → moved to the Trash"
      else
        echo "  ! could not move it (permissions). Please delete it yourself, then restart After Effects."
      fi
    fi
  done
done

if [ -L "$DEST" ]; then
  rm "$DEST"
elif [ -d "$DEST" ]; then
  mv "$DEST" "$TRASH/KeyframeX-previous-$STAMP"
  echo "Previous install moved to the Trash."
fi

if [ "${1:-}" = "--link" ]; then
  ln -s "$SRC" "$DEST"
  echo "Linked $DEST -> $SRC"
else
  mkdir -p "$DEST"
  cp -R "$SRC/." "$DEST/"
  rm -rf "$DEST"/tests/fixtures/*" (KeyframeX)"
  echo "Copied to $DEST"
fi

for v in 9 10 11 12 13; do
  defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1
done
echo "Enabled unsigned extensions (PlayerDebugMode) for CSXS 9-13."
echo "Done. Restart After Effects, then open Window > Extensions > KeyframeX."
