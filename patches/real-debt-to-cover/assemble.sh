#!/usr/bin/env bash
# Reassemble the byte-exact git format-patch outputs (split only because the GitHub MCP
# write path rejects ~100KB payloads).
#   full = git format-patch 31aa6ec..2a8429f --stdout  (78930ac miss-fix + real-debt-to-cover)
#   only = git format-patch 78930ac..2a8429f --stdout  (real-debt-to-cover only)
set -euo pipefail
cd "$(dirname "$0")"
cat 01-78930ac-miss-fix.part 02-header-full.part 03-body-aa.part 03-body-ab.part 03-body-ac.part > ../real-debt-to-cover-full.patch
cat 02-header-only.part 03-body-aa.part 03-body-ab.part 03-body-ac.part > ../real-debt-to-cover-only.patch
sha256sum ../real-debt-to-cover-full.patch ../real-debt-to-cover-only.patch
echo "expected full: 90f28d9c76ab8eea6a6b226f1302f56d6dd953cde8ecf2cda3c73a131a1fdb99"
echo "expected only: cdfe50a83392fce06f1bda327b80b6cbe7eeabb08fe8d6bc71be23d6782097eb"
