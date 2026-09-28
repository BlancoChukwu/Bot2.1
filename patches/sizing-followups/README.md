# sizing-followups patches

Local commit `9b3937b` on branch `fix/sizing-followups`, parent `2a8429f` (real-debt-to-cover),
which sits on `78930ac` on top of master `31aa6ec`.
`git push` is 403 and the GitHub MCP rejects ~100KB payloads, so the two
`git format-patch` outputs are stored here as parts that concatenate byte-exactly.

```bash
bash patches/sizing-followups/assemble.sh   # writes patches/sizing-followups-{full,only}.patch + sha256
# full (78930ac + real-debt + sizing-followups), for a 31aa6ec tree:
git am patches/sizing-followups-full.patch
# only the sizing-followups commit, for a tree that already has 2a8429f:
git am patches/sizing-followups-only.patch
```

Parts:
- `01-header-full.part` / `01-header-only.part`: mail header of the sizing-followups commit (`[PATCH 3/3]` vs single).
- `02-body-aa..ad.part`: shared commit body + diff.
- full also reuses `../real-debt-to-cover/{01-78930ac-miss-fix,02-header-full,03-body-aa..ac}.part`,
  renumbered `[PATCH n/2]` -> `[PATCH n/3]` by assemble.sh.

| file | size | sha256 |
|---|---|---|
| sizing-followups-full.patch | 261223 B | f92a9b45d6d647c1599783b247c025cb24e57a2e4f593f816e378751bd3e3183 |
| sizing-followups-only.patch | 156701 B | 39488f5d54d81531dac92f4a61cc9b861c57826cdc9c2b05baa502259f47460f |

Round-trip verified 2026-09-28 ~10:48 MDT: parts downloaded from this branch, assembled (sha256 match),
`git am` only-patch onto clean 2a8429f and full-patch onto clean 31aa6ec both give a tree identical to
`9b3937b`; `tsc --noEmit` clean; `vitest run`: 109 files passed / 2 skipped, 439 tests passed / 3 skipped.

Markers: `AAVE_V33_LIQUIDATION_RULES`, `liquidation_bonus_unavailable_skip`,
`LIQUIDATION_RECEIVER_READINESS_BLOCKED`, `LIQUIDATION_RECEIVER_CODEHASH`, `MustNotLeaveDust`, Base 6-pair set.
