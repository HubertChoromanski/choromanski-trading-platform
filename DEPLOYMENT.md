# Choromanski Trading Platform Deployment

This guide prepares the backend to run 24/7 on an Ubuntu VPS with PM2. Start with small paper tests, then tiny live size.

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
PORT=8787
```

Never put real keys in frontend files. Restrict the BingX API key by VPS IP if BingX allows it. Disable withdrawal permission.

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
VITE_BACKEND_URL=https://your-domain.com/api
VITE_DASHBOARD_TOKEN=the-same-dashboard-token-if-you-enable protected live controls
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

## 10. Before Larger Capital

- Run paper mode for several days.
- Run live with the smallest practical size.
- Confirm SL orders appear on BingX immediately after entries.
- Confirm reconciliation catches manual exchange changes.
- Confirm PM2 restart enters `NEEDS_RECONCILIATION` instead of auto-trading.
- Keep withdrawal permission disabled on API keys.
