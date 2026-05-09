#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs data
pm2 start ecosystem.config.cjs --env production
