# Liquidator Cockpit V2

**Stack:** Tauri 2 + React + TypeScript + Vite + Tailwind v4 + uPlot  
**Runs on:** this laptop only (desktop app)  
**Bot runs on:** Oracle VM `/home/ubuntu/liquidator`

## HARD CONSTRAINT — ZERO BOT HOT-PATH IMPACT

The cockpit is an operator plane on the laptop. It must never degrade liquidation latency.

| Rule | Status |
| --- | --- |
| No shared process with bot | Separate Tauri/Vite app under `cockpit/` |
| No bot-side cockpit hooks | Bot `src/` must not import cockpit code |
| Telemetry adapters start mock/local; remote reads are slow poll only | Never sub-second log scrapes on VM |
| Controls run via laptop SSH/SCP allowlist | Not inside bot Node event loop |
| Secrets never shown or logged | Key path configured locally; values redacted |

## Design lock (v1) — operator answers

- Industrial chassis feel; **function-only** controls (no decorative widgets)
- Background: neutral dark gray (`#121212` / `#1a1a1a`) — **no blue-tinted surfaces**
- Section headers: pure white (`#FFFFFF`)
- Phosphor green data (`#00FF41` / `#00CC33`); amber/red for caution/critical only
- STOP BOT = crimson + neon red rim; PREPARE & START LIVE = amber + gold rim
- Critical alerts **flash red** until acknowledged/cleared (`prefers-reduced-motion` → steady red)
- Layout: **three panes nearly equal**; middle pane **slightly** wider (aesthetic only)
  - Middle top: **Diagnostics / alerts** (primary operator attention)
  - Right: session/status + HF traces
- Q4 discarded for v1 (no extra feature from that option)

### v1 functional controls

| Control | Behavior |
| --- | --- |
| PREPARE & START LIVE | VM: dry-run receipt → `./start-event-purity-production.sh` |
| LIVE MODE | **Read-only** indicator (no mutation) |
| STOP BOT | Confirm → `npm run bot:stop` |
| UPDATE CODE | VM only: `git pull --ff-only` (laptop pushes to GitHub manually) |
| SYNC ENV | Production only: SCP `.env.event-purity-production` → VM, then `cp` to `.env` |
| LOG | Cycles log filters on each click: all → liquidations → errors (persisted) |

**Not in v1:** Start Soak, Sync Soak Env, laptop `git push` from cockpit.

### LED rail (v1)

- Removed — no annunciator / FLASH OK bar in the UI
- RPC latency LED remains cancelled (would require extra RPC usage)

### Env sync sequence (exact)

On laptop (via cockpit SCP):

```text
scp -i <sshKeyPath> ".env.event-purity-production" ubuntu@143.47.121.38:/home/ubuntu/liquidator/
```

On VM (via cockpit SSH):

```text
cd /home/ubuntu/liquidator && cp .env.event-purity-production .env
```

## Develop

```bash
cd cockpit
npm install
npm run launch     # Windows one-click: ACL + tauri:dev
npm run dev        # browser UI (mock ops / mock telemetry)
npm run tauri:dev  # desktop shell with SSH/SCP + live poll
```

Open http://127.0.0.1:5179/ for Vite-only preview (never contacts the VM).

