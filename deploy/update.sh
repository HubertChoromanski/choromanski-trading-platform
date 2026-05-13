#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY_HOST="${DEPLOY_HOST:-}"
DEPLOY_USER="${DEPLOY_USER:-root}"
DEPLOY_PATH="${DEPLOY_PATH:-/opt/choromanski-trading-platform}"

if [[ -z "$DEPLOY_HOST" ]]; then
  echo "Set DEPLOY_HOST before running update.sh." >&2
  exit 1
fi

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
cd "$DEPLOY_PATH/backend"
npm ci || npm install
pm2 restart ecosystem.config.cjs --env production
cd ../hubert-platform/frontend
npm ci || npm install
npm run build
rsync -a --delete dist/ /var/www/choromanski-frontend/
EOF
