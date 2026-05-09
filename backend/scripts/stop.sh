#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
pm2 stop choromanski-trading-backend
