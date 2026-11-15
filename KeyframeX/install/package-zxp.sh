#!/bin/bash
# KeyframeX — build a signed .zxp for distribution with Adobe's ZXPSignCmd.
#   ./package-zxp.sh /path/to/ZXPSignCmd [certificate.p12] [password]
# Without a certificate, a self-signed one is created (fine for your own machines).
set -euo pipefail
ZXP="${1:?Path to ZXPSignCmd (https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD)}"
CERT="${2:-}"
PASS="${3:-keyframex}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$SRC/dist"
STAGE="$(mktemp -d)/KeyframeX"
mkdir -p "$OUT" "$STAGE"
rsync -a --exclude 'tests' --exclude 'dist' --exclude '.debug' --exclude '.DS_Store' "$SRC/" "$STAGE/"
if [ -z "$CERT" ]; then
  CERT="$OUT/keyframex-selfsigned.p12"
  [ -f "$CERT" ] || "$ZXP" -selfSignedCert XX NA KeyframeX KeyframeX "$PASS" "$CERT"
fi
VERSION=$(node -p "require('$SRC/package.json').version")
"$ZXP" -sign "$STAGE" "$OUT/KeyframeX-$VERSION.zxp" "$CERT" "$PASS" -tsa http://timestamp.digicert.com
echo "Built $OUT/KeyframeX-$VERSION.zxp — install it with a ZXP installer (e.g. aescripts ZXP Installer)."
