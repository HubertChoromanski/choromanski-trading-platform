# Choromanski Trading Platform Deployment

This guide prepares the backend to run 24/7 on an Ubuntu/Hetzner VPS with PM2 and a Caddy or nginx reverse proxy. Start with small paper tests, then tiny live size.

## Target Architecture

- Backend: Node.js API on the VPS, bound to `127.0.0.1:8787`, managed by PM2.
- Frontend: Vite production build copied to `/var/www/choromanski-frontend`.
- Reverse proxy: Caddy or nginx serves the frontend over HTTPS and proxies `/api/*` to the local backend.
- Persistent state: backend JSON state under `backend/data` or the path configured by `DATA_DIR`.
- Live operation: Sztab interval runners run inside the backend PM2 process and continue without the browser/laptop.
- Secrets: BingX/OpenAI/API tokens stay only in `backend/.env` on the VPS.

## 1. Install System Packages

```bash
sudo apt update
sudo apt install -y git curl ufw
```

Install Node.js LTS:

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

Install PM2:

```bash
sudo npm install -g pm2
```

## 2. Clone And Install

```bash
git clone <your-repo-url> Choromanski-Trading-Platform
cd Choromanski-Trading-Platform/backend
npm install
mkdir -p data logs
```

## 3. Configure Secrets

```bash
cp .env.example .env
nano .env
```

Set:

```bash
BINGX_API_KEY=your_key
BINGX_API_SECRET=your_secret
BINGX_BASE_URL=https://open-api.bingx.com
DASHBOARD_TOKEN=choose-a-long-random-token
HOST=127.0.0.1
PORT=8787
DATA_DIR=./data
SZTAB_AUTO_RESUME_ON_START=false
SZTAB_RUNNER_STALE_SECONDS=120
```

Never put real keys in frontend files. Restrict the BingX API key by VPS IP if BingX allows it. Disable withdrawal permission.

`SZTAB_AUTO_RESUME_ON_START=false` is the safest default. Set it to `true` only after you have verified restart recovery with tiny live size; then interrupted Sztab intervals will attempt safe auto-resume after backend startup.

## 4. Start Backend With PM2

```bash
npm run start:prod
npm run status
npm run logs
```

Enable PM2 startup after reboot:

```bash
pm2 save
pm2 startup
```

Run the command PM2 prints.

Recommended log rotation:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 20M
pm2 set pm2-logrotate:retain 14
```

## 5. Frontend

For local development:

```bash
cd ../hubert-platform/frontend
cp .env.example .env
npm install
npm run dev
```

For production build:

```bash
npm run build
```

Serve `dist/` with Caddy, Nginx, or another static server. Set:

```bash
VITE_BACKEND_URL=/api
VITE_DASHBOARD_TOKEN=the-same-dashboard-token-if-you-enable protected live controls
VITE_DISPLAY_TIME_ZONE=Europe/Warsaw
VITE_DISPLAY_LOCALE=pl-PL
```

Then rebuild.

## 6. Operator Flow

1. Open Execution Center.
2. Click `Test BingX`.
3. Confirm Futures USDT balance is visible.
4. Unlock a profile.
5. Set mode to `Live`.
6. Save Draft.
7. Lock Profile.
8. Click `Reconcile Now`.
9. If clean, click `Confirm Resume`.
10. Click `Arm Live`.
11. Only then click `Start Live`.

If the backend restarts while live mode was active, it enters `NEEDS_RECONCILIATION`. It will not blindly resume trading.

## 7. Logs And Maintenance

```bash
cd backend
npm run logs
npm run status
npm run restart:prod
npm run stop:prod
```

Update from Git:

```bash
git pull
cd backend
npm install
npm run restart:prod
```

## 8. Firewall

Only expose ports you need:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
```

Keep backend port `8787` private behind a reverse proxy when possible.

## 9. Caddy

See `deploy/Caddyfile.example` for an HTTPS reverse proxy template.

For nginx, see `deploy/nginx.conf.example`.

## 10. Deployment Scripts

From your local machine:

```bash
DEPLOY_HOST=your.vps.ip DEPLOY_USER=root FRONTEND_DOMAIN=trading.example.com ./deploy/deploy.sh
```

For updates:

```bash
DEPLOY_HOST=your.vps.ip DEPLOY_USER=root ./deploy/update.sh
```

Operational helpers:

```bash
DEPLOY_HOST=your.vps.ip ./deploy/restart-prod.sh
DEPLOY_HOST=your.vps.ip ./deploy/logs-prod.sh
HEALTH_URL=https://trading.example.com/api/health ./deploy/healthcheck.sh
```

The scripts intentionally exclude `backend/.env`, `backend/data`, logs, cache, and artifacts so secrets and live state are not overwritten from the laptop.

## 11. Sztab Restart Recovery

On backend startup, existing live Battle runner state still enters manual reconciliation. Sztab interval runners are separate:

- with `SZTAB_AUTO_RESUME_ON_START=false`, any interval that was running is marked `interrupted`;
- with `SZTAB_AUTO_RESUME_ON_START=true`, interrupted intervals attempt safe recovery using the saved Sztab config and assigned API profile;
- pending trigger orders are reconciled from BingX before a new trigger order can be armed;
- terminal trigger states such as `FAILED`, `CANCELED`, `EXPIRED`, `REJECTED`, or `order not exist` clear local armed state and allow the next setup.

Use the UI or API to recover manually:

```bash
curl -X POST -H "X-Dashboard-Token: $DASHBOARD_TOKEN" https://trading.example.com/api/sztab/recover-interrupted
```

Emergency Sztab controls:

```bash
curl -X POST -H "X-Dashboard-Token: $DASHBOARD_TOKEN" https://trading.example.com/api/sztab/stop-all
curl -X POST -H "X-Dashboard-Token: $DASHBOARD_TOKEN" https://trading.example.com/api/sztab/cancel-pending-triggers
```

## 12. Before Larger Capital

- Run paper mode for several days.
- Run live with the smallest practical size.
- Confirm SL orders appear on BingX immediately after entries.
- Confirm reconciliation catches manual exchange changes.
- Confirm PM2 restart enters `NEEDS_RECONCILIATION` instead of auto-trading.
- Confirm Sztab pending trigger orders reconcile correctly after PM2 restart.
- Confirm `/api/production/status` reports PM2, memory, uptime, and Sztab runner status.
- Keep withdrawal permission disabled on API keys.
