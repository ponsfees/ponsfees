#!/usr/bin/env bash
# Renders public/og.png (1200x630) from card.html in headless Chrome, with the real web fonts.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
OUT="$HERE/../../public/og.png"
cp "$HERE/../../public/mark.png" "$HERE/mark.png"
"$CHROME" --headless --disable-gpu --hide-scrollbars --window-size=1200,630 --screenshot="$OUT" \
  --virtual-time-budget=6000 "file://$HERE/card.html" >/dev/null 2>&1
[ -f "$OUT" ] || { echo "FATAL: no image was written" >&2; exit 1; }
SIZE=$(sips -g pixelWidth -g pixelHeight "$OUT" 2>/dev/null | awk '/pixel/{print $2}' | paste -sd'x' -)
echo "wrote $OUT ($SIZE)"
[ "$SIZE" = "1200x630" ] || { echo "FATAL: expected 1200x630" >&2; exit 1; }
