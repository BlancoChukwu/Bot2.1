module.exports = {
  apps: [
    {
      name: "aave-liquidator-base",
      script: "dist/src/index.js",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      restart_delay: 5_000,
      node_args: "--max-old-space-size=1024 --expose-gc",
      max_memory_restart: "1200M",
      // Fine while ENABLE_LIVE_TX=false; before live tx, confirm shutdown.addHook chain
      // (checkpoint close, in-flight execution drain) completes within this window.
      kill_timeout: 15_000,
      env: {
        NODE_ENV: "production",
        SIMULATION_MODE: "false",
        SKIP_DEPLOYMENT_SAFETY_GATE: "false",
        SKIP_COLD_START_FULL_SWEEP: "true",
      },
    },
  ],
};
