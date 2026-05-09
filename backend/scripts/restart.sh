#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
pm2 restart ecosystem.config.cjs --env production
