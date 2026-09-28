#!/usr/bin/env bash
# Reassemble the byte-exact git format-patch outputs (split because the GitHub MCP
# write path rejects ~100KB payloads).
#   full = git format-patch 31aa6ec..HEAD --stdout  (78930ac + 2a8429f + sizing-followups)
#   only = git format-patch 2a8429f..HEAD --stdout  (sizing-followups only)
set -euo pipefail
cd "$(dirname "$0")"
cat full-00.part full-01.part full-02.part full-03.part > ../sizing-followups-full.patch
cat only-00.part only-01.part > ../sizing-followups-only.patch
sha256sum ../sizing-followups-full.patch ../sizing-followups-only.patch
echo "expected full: f92a9b45d6d647c1599783b247c025cb24e57a2e4f593f816e378751bd3e3183"
echo "expected only: 39488f5d54d81531dac92f4a61cc9b861c57826cdc9c2b05baa502259f47460f"
