# Liquidator Cockpit V2

Local desktop operator station for the Oracle VM liquidator. **Runs on this laptop only.**

See [DESIGN.md](./DESIGN.md) for security/zero-impact rules and design lock.

## One-click flow (Windows)

1. Double-click / run the launcher (hardens SSH key ACL, checks `ssh`, starts the desktop app):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-cockpit.ps1
```

Or from this folder:

```bash
npm run launch
```

2. Confirm Connection fields are pre-filled (VM `143.47.121.38`, your SSH key path, local repo path).
3. Click **CONNECT** once — SSH preflight runs (`bot:status`). On success, core telemetry polls every ~20s.
4. Use ops controls: PREPARE & START LIVE, STOP, UPDATE CODE, SYNC ENV.

SSH key ACL (OpenSSH equivalent of `chmod 600`) — the launcher runs this for you:

```powershell
icacls "C:\Users\brick\Downloads\ssh-key-2026-05-29 (1).key" /inheritance:r /grant:r "%USERNAME%:R"
```

### Release binary (optional)

```powershell
# Build installer / exe
cd cockpit
npm run tauri:build

# Launch release if present (builds if missing)
powershell -ExecutionPolicy Bypass -File .\scripts\start-cockpit.ps1 -Release
```

Create a desktop shortcut to `scripts\start-cockpit.ps1` (or the built `.exe` under `src-tauri\target\release\`) for true one-click open.

## Quick start (dev)

```bash
cd cockpit
npm install

# Browser UI with mock telemetry + simulated ops (no SSH)
npm run dev
# → http://127.0.0.1:5179/

# Full desktop shell (SSH/SCP allowlisted commands + live telemetry)
npm run tauri:dev
# or: npm run launch
```

| Mode | Telemetry | Ops commands |
| --- | --- | --- |
| `npm run dev` (browser) | Mock | Simulated — never contacts VM |
| `tauri:dev` / `start-cockpit.ps1` | Real SSH poll when Connected | Real SSH/SCP allowlist |

## First-run settings (desktop)

Pre-filled defaults:

- VM host: `143.47.121.38`
- VM user: `ubuntu`
- VM path: `/home/ubuntu/liquidator`
- SSH key path on this laptop
- Local repo path (folder that contains `.env.event-purity-production`)

Use **Browse** for key/repo paths, then **CONNECT**. Settings persist in `localStorage`.

## Functional controls (v1)

| Control | Action |
| --- | --- |
| CONNECT | SSH preflight → start 20s telemetry poll (does **not** start the bot) |
| PREPARE & START LIVE | VM: dry-run receipt → production live start |
| STOP BOT | Confirm → `npm run bot:stop` |
| UPDATE CODE | VM: `git pull --ff-only` (push from laptop yourself) |
| SYNC ENV | SCP `.env.event-purity-production` → VM, then `cp` to `.env` |
| LOG | Cycles filters: all → liquidations → errors → all (persisted) |

Live mode (`true`/`false`) is shown only in **Run status**. Cockpit is live/production only — no soak controls.

## Live telemetry (core v1)

When Connected, the cockpit polls over SSH (slow, read-only — **no bot hot-path impact**):

- `watch-bot-summary.mjs --json` (liquidations, circuit, recent attempts/critical)
- `curl` to VM-local `:9090/healthz` and `/status`
- `ensure-single-bot.mjs --status` for RUNNING/OFF

Candidates table / HF traces are **not wired in v1** (empty-state message).

## Notes

- Critical alerts flash red until acknowledged.
- LED rail / annunciator bar removed from UI.
- Bot hot path is never shared with this app — no imports from bot `src/`.
- Private keys are never committed; only the **path** is configured locally.
