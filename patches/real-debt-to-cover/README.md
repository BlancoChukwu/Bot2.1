# real-debt-to-cover patches

Local commit `2a8429f` (on top of `78930ac`, which is on top of master `31aa6ec`).
`git push` is 403 and the GitHub MCP rejects ~100KB payloads, so the two
`git format-patch` outputs are stored here as parts that concatenate byte-exactly.

```bash
bash patches/real-debt-to-cover/assemble.sh   # writes patches/real-debt-to-cover-{full,only}.patch + sha256
# full (78930ac + fix), for a 31aa6ec / 643a2cd-equivalent tree WITHOUT 78930ac:
git am patches/real-debt-to-cover-full.patch
# only the fix, for a tree that already has 78930ac:
git am patches/real-debt-to-cover-only.patch
```

| file | sha256 |
|---|---|
| real-debt-to-cover-full.patch (104772 B) | 90f28d9c76ab8eea6a6b226f1302f56d6dd953cde8ecf2cda3c73a131a1fdb99 |
| real-debt-to-cover-only.patch (93329 B) | cdfe50a83392fce06f1bda327b80b6cbe7eeabb08fe8d6bc71be23d6782097eb |

Note: this branch was cut from `backup/78930ac-miss-fix` (75e217b), whose `src/index.ts`
does not contain the 78930ac hunks (too large for MCP). Apply the patches to a real
checkout of `78930ac` / the host tree rather than to this branch's partial tree.
Marker: debt_to_cover_resolve_failed / pair_not_held_skip.
