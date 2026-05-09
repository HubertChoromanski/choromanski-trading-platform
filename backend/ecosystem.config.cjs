module.exports = {
  apps: [
    {
      name: "choromanski-trading-backend",
      script: "src/index.js",
      cwd: __dirname,
      env_file: ".env",
      env: {
        NODE_ENV: "production",
        PORT: 8787,
      },
      autorestart: true,
      max_memory_restart: "350M",
      min_uptime: "10s",
      restart_delay: 3000,
      error_file: "logs/error.log",
      out_file: "logs/out.log",
      log_file: "logs/combined.log",
      time: true,
    },
  ],
};
