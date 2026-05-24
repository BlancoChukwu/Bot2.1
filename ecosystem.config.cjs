module.exports = {
  apps: [
    {
      name: "aave-liquidator-base",
      script: "dist/src/index.js",
      node_args: "--max-old-space-size=4096",
      max_memory_restart: "3G",
      kill_timeout: 15_000,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
