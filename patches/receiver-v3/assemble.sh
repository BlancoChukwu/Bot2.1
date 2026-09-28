#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:-Bot2.1-receiver-v3.patch}"
cat "$DIR"/part-* > "$OUT"
echo "Wrote $OUT ($(wc -c < "$OUT") bytes)"
sha256sum "$OUT"
EXPECTED=a21786fe10aeef141840f109ec73ccc5fca0c55faeef99ef3e37a45da0bf5cb9
GOT=$(sha256sum "$OUT" | awk '{print $1}')
test "$GOT" = "$EXPECTED"
