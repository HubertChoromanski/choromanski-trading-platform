#!/usr/bin/env bash
set -euo pipefail

URL="${HEALTH_URL:-http://127.0.0.1:8787/health}"

curl --fail --silent --show-error "$URL" | node -e '
let input = "";
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  const payload = JSON.parse(input);
  console.log(JSON.stringify({
    ok: payload.ok,
    service: payload.service,
    deploymentMode: payload.production?.deploymentMode,
    processManager: payload.production?.processManager,
    uptimeSeconds: payload.production?.uptimeSeconds,
    sztab: payload.production?.sztab,
  }, null, 2));
});
'
