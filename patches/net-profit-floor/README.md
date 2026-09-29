# net-profit-floor patches

Three local commits on branch `fix/net-profit-floor`, on top of `9b3937b` (sizing-followups tip):

| commit | subject |
|---|---|
| `ffcdbeb` | Receiver sweep: post-fill + periodic `rescue()` of leftover balances to the executor wallet (hard-wired destination) |
| `f460c28` | Net-profit floor: `MIN_NET_PROFIT_USD` (default 1) + `MIN_DEBT_SANITY_USD` (default 5) replace the $50 hard debt floor; `liquidation_floor_shadow` on every eval; fail closed on missing inputs |
| `86c676f` | Docs: scope for cbETH/wstETH/weETH pairs and Moonwell rebase (scope only, no code) |

Local tip `86c676f`, tree `7e48a0d72d98060b2bf52838e9974cef33099691`.
`git push` is 403 and the GitHub MCP rejects ~100KB payloads, so the 3-patch `git format-patch` mbox
is stored here as parts that concatenate (after marker restore) byte-exactly.

```bash
bash patches/net-profit-floor/assemble.sh   # writes net-profit-floor-series.mbox and verifies its sha256
git checkout -b fix/net-profit-floor 9b3937b   # clean sizing-followups tip
git am net-profit-floor-series.mbox            # 3 commits; tree == 7e48a0d7...
```

Marker encoding: the parts store whitespace-only lines as ASCII markers so nothing in transit can strip them:
`@SP@` == a single-space line (diff blank context line), `@SIG@` == `-- ` (format-patch signature separator).
`assemble.sh` restores both, then checks `SERIES.sha256`.

| file | size (B) | sha256 |
|---|---|---|
| 02-series-0.part | 19998 | 91c93c7eaf7a83298d228959276027b1ffba48c432634d1c77fbd205ad5d009d |
| 02-series-1.part | 19958 | ef78008f603dd8097492a9ab6f24acee404475aedc9736c4c47d2804f7b05256 |
| 02-series-2.part | 9970 | cc1baef922db653be2a1579a179715fa81410e17c7eaff31a433432967f7faa0 |
| 02-series-3.part | 9998 | 998e7b4f17211793b9ea3cb7b03a547189d82f576ba0849ce5a9a3d4ae2cdeb9 |
| 02-series-4.part | 9969 | 7348fbb9a48b6e8aaa6290effab29e38e288edc72e1c08b3e17dffcecd99994d |
| 02-series-5.part | 9990 | fc420e779cd6c83020e5439a5b84b8684e73ecb899812dce4812725fd51c3090 |
| 02-series-6.part | 9995 | 6d73391f509aec4938871641dce5b17d4e40b54178a3b5ef9f867e5df0eeee44 |
| 02-series-7.part | 9991 | 66fa6d448d4749fbd6c2d9c3e7cbf0435386136b9110db2ce3397397efb1058b |
| 02-series-8.part | 9898 | 56216c7625e27de333074b22f0e402e7b4b7dfc9f4c497955dcc83192b0c0d77 |
| 02-series-9.part | 7634 | 9b9ee9779782982f73fc445b5e9338691649e5c7419a5d85a81fd6a8608e3c3f |
| assemble.sh | 906 | 54079aa0e47690025634e8633004bbb64722ced5aebe7bce8b71d51a9f9d1f8f |
| SERIES.sha256 | 65 | 62b17f3fde98ee9b04d89d47edc7a1b4b2628f9ab6f77b5ccf30ade03bb3749d |
| **net-profit-floor-series.mbox (assembled)** | 117317 | 2082e4c7e59f99288198bdb9b5ff853e5cc58f878ca2b735da78de62e6024a22 |

Reference sha256 of the individual `git format-patch` outputs (not published as files; the series mbox is their concatenation):

| patch | sha256 |
|---|---|
| Bot2.1-receiver-sweep-only.patch | 9e77dbffc6e66b95b877bff0ea4dc85bb86b725a2f0e871d2ad29fc2deb91fe8 |
| Bot2.1-net-profit-floor-only.patch | a14cf9aa63c1c60c93f8e24867ead95b09b2da77eaec4bc9a7920d80b49d783b |
| Bot2.1-scope-docs-only.patch | dc6d9b35e4ad8102705f50a58f3a7bd4212f94507cb565bcd6ac9e7a5e443389 |

Tests on the local branch: `tsc --noEmit` clean; `vitest run` 483 passed / 7 skipped / 0 failed (112 files);
with fork tests (anvil, keyless, owner impersonation) 486 passed / 1 failed / 3 skipped; the one failure is
`uiPoolDataProvider.test.ts`, rate-limited by the public RPC, and it fails identically on the untouched `9b3937b` baseline.

Constraints honored: no deploy, no LIVE env change, no receiver Solidity change, nothing pushed to master.
The sweep destination is not configurable (hard-wired to the signer address); `RECEIVER_SWEEP_INTERVAL_MS` only sets cadence.
