#!/usr/bin/env bash
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-}"
DEPLOY_USER="${DEPLOY_USER:-root}"
DEPLOY_PATH="${DEPLOY_PATH:-/opt/choromanski-trading-platform}"

if [[ -z "$DEPLOY_HOST" ]]; then
  pm2 logs choromanski-trading-backend
  exit 0
fi

ssh -t "${DEPLOY_USER}@${DEPLOY_HOST}" "cd '$DEPLOY_PATH/backend' && pm2 logs choromanski-trading-backend"
