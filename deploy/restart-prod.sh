#!/usr/bin/env bash
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-}"
DEPLOY_USER="${DEPLOY_USER:-root}"
DEPLOY_PATH="${DEPLOY_PATH:-/opt/choromanski-trading-platform}"

if [[ -z "$DEPLOY_HOST" ]]; then
  cd "$(dirname "${BASH_SOURCE[0]}")/../backend"
  pm2 restart ecosystem.config.cjs --env production
  exit 0
fi

ssh "${DEPLOY_USER}@${DEPLOY_HOST}" "cd '$DEPLOY_PATH/backend' && pm2 restart ecosystem.config.cjs --env production"
