#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_HOST="${DEPLOY_HOST:-}"
DEPLOY_USER="${DEPLOY_USER:-root}"
DEPLOY_PATH="${DEPLOY_PATH:-/opt/choromanski-trading-platform}"
FRONTEND_DOMAIN="${FRONTEND_DOMAIN:-}"

if [[ -z "$DEPLOY_HOST" ]]; then
  echo "Set DEPLOY_HOST, for example: DEPLOY_HOST=1.2.3.4 DEPLOY_USER=root ./deploy/deploy.sh" >&2
  exit 1
fi

if [[ -z "$FRONTEND_DOMAIN" ]]; then
  echo "Set FRONTEND_DOMAIN to the HTTPS domain that will serve the UI, for example trading.example.com." >&2
  exit 1
fi

echo "Deploying to ${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_PATH}"

rsync -az --delete \
  --exclude ".git" \
  --exclude "node_modules" \
  --exclude "backend/.env" \
  --exclude "backend/data" \
  --exclude "backend/logs" \
  --exclude "backend/cache" \
  --exclude "backend/artifacts" \
  --exclude "hubert-platform/frontend/dist" \
  "$ROOT_DIR/" "${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_PATH}/"

ssh "${DEPLOY_USER}@${DEPLOY_HOST}" "bash -s" <<EOF
set -euo pipefail
cd "$DEPLOY_PATH"
mkdir -p backend/data backend/logs backend/cache backend/artifacts /var/www/choromanski-frontend

cd backend
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created backend/.env from example. Fill backend secrets on the VPS before starting live trading." >&2
fi
npm ci || npm install

cd ../hubert-platform/frontend
printf 'VITE_BACKEND_URL=/api\nVITE_DISPLAY_TIME_ZONE=Europe/Warsaw\nVITE_DISPLAY_LOCALE=pl-PL\n' > .env.production.local
npm ci || npm install
npm run build
rsync -a --delete dist/ /var/www/choromanski-frontend/

cd ../../backend
pm2 start ecosystem.config.cjs --env production
pm2 save
pm2 status choromanski-trading-backend
EOF

echo "Deploy completed. Configure Caddy/nginx separately with deploy/Caddyfile.example or deploy/nginx.conf.example."
