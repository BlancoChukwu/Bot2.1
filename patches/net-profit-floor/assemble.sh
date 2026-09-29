#!/usr/bin/env bash
# Reassemble the net-profit-floor + receiver-sweep + scope-docs series (3 commits on top of 9b3937b).
#   bash patches/net-profit-floor/assemble.sh [out.mbox]   -> writes the mbox and verifies its sha256
#   git checkout -b fix/net-profit-floor 9b3937b && git am net-profit-floor-series.mbox
# Parts store whitespace-only lines as ASCII markers so nothing can strip them in transit:
#   "@SP@"  == a single space line (diff blank context line),  "@SIG@" == "-- " (format-patch signature separator).
set -euo pipefail
cd "$(dirname "$0")"
out="${1:-net-profit-floor-series.mbox}"
cat 02-series-*.part | sed -e 's/^@SP@$/ /' -e 's/^@SIG@$/-- /' > "$out"
expected="$(tr -d '[:space:]' < SERIES.sha256)"
actual="$(sha256sum "$out" | cut -d' ' -f1)"
if [ "$expected" != "$actual" ]; then
  echo "SHA256 MISMATCH: expected $expected got $actual" >&2
  exit 1
fi
echo "OK $out sha256=$actual"
