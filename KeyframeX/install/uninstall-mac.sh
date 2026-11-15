#!/bin/bash
# KeyframeX — remove from macOS. Settings in ~/Library/Application Support/KeyframeX are kept.
set -euo pipefail
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/KeyframeX"
if [ -L "$DEST" ]; then rm "$DEST"; elif [ -d "$DEST" ]; then mv "$DEST" "$HOME/.Trash/KeyframeX-$(date +%s)"; fi
echo "KeyframeX removed. Restart After Effects."
