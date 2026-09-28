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

| file | size | sha256 |
|---|---|---|
| sizing-followups-full.patch | 261223 B | f92a9b45d6d647c1599783b247c025cb24e57a2e4f593f816e378751bd3e3183 |
| sizing-followups-only.patch | 156701 B | 39488f5d54d81531dac92f4a61cc9b861c57826cdc9c2b05baa502259f47460f |

Local commit: `9b3937b`. Markers: `AAVE_V33_LIQUIDATION_RULES`, `liquidation_bonus_unavailable_skip`,
`LIQUIDATION_RECEIVER_READINESS_BLOCKED`, `MustNotLeaveDust`, Base 6-pair set.
