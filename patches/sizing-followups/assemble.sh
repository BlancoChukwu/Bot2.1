#!/usr/bin/env bash
# Reassemble the byte-exact git format-patch outputs (split because the GitHub MCP
# write path rejects ~100KB payloads).
#   full = git format-patch 31aa6ec..9b3937b --stdout  (78930ac + 2a8429f + sizing-followups)
#   only = git format-patch 2a8429f..9b3937b --stdout  (sizing-followups only)
# The first two commits of "full" reuse ../real-debt-to-cover/ parts; only the
# "[PATCH n/2]" -> "[PATCH n/3]" subject numbering differs.
set -euo pipefail
cd "$(dirname "$0")"
R=../real-debt-to-cover
{
  sed 's/\[PATCH 1\/2\]/[PATCH 1\/3]/' "$R/01-78930ac-miss-fix.part"
  sed 's/\[PATCH 2\/2\]/[PATCH 2\/3]/' "$R/02-header-full.part"
  cat "$R/03-body-aa.part" "$R/03-body-ab.part" "$R/03-body-ac.part"
  cat 01-header-full.part 02-body-aa.part 02-body-ab.part 02-body-ac.part 02-body-ad.part
} > ../sizing-followups-full.patch
cat 01-header-only.part 02-body-aa.part 02-body-ab.part 02-body-ac.part 02-body-ad.part > ../sizing-followups-only.patch
sha256sum ../sizing-followups-full.patch ../sizing-followups-only.patch
echo "expected full: f92a9b45d6d647c1599783b247c025cb24e57a2e4f593f816e378751bd3e3183"
echo "expected only: 39488f5d54d81531dac92f4a61cc9b861c57826cdc9c2b05baa502259f47460f"
