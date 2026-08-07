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
      merge_logs: false,
      out_file: process.env.BOT_LOGFILE,
      error_file: process.env.BOT_ERRFILE,
      // Live-tx: in-flight drain bound is 60s; kill_timeout must exceed that with slack.
      kill_timeout: 75_000,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
