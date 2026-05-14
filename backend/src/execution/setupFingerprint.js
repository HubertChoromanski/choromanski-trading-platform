import crypto from "node:crypto";

function stableNumber(value, decimals = 8) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Number(numeric.toFixed(decimals));
}

function stableString(value) {
  return String(value ?? "").trim().toUpperCase();
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortObject(value[key])]),
  );
}

function hashPayload(payload, length = 16) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(sortObject(payload)))
    .digest("hex")
    .slice(0, length);
}

export function strategyParamsHash(strategyParameters = {}) {
  return hashPayload({
    atrLength: stableNumber(strategyParameters.atrLength, 4),
    atrMultiplier: stableNumber(strategyParameters.atrMultiplier),
    bandwidth: stableNumber(strategyParameters.bandwidth),
    envelopeMultiplier: stableNumber(strategyParameters.envelopeMultiplier),
    maxSameSideFailures: stableNumber(strategyParameters.maxSameSideFailures, 4),
    strategySource: stableString(strategyParameters.strategySource ?? "pine-ha"),
  }, 12);
}

export function setupFingerprintInput({
  interval,
  setup = {},
  strategyParamsHash: explicitStrategyParamsHash,
  strategyParameters = {},
  symbol,
  takeProfit,
} = {}) {
  const strategyHash = explicitStrategyParamsHash ?? strategyParamsHash(strategyParameters);
  return {
    benchmarkTime: stableNumber(setup.benchmarkTime ?? setup.time, 0),
    direction: stableString(setup.direction),
    interval: stableString(interval ?? setup.interval ?? setup.timeframe),
    invalidationPrice: stableNumber(setup.invalidationPrice ?? setup.stopLoss),
    stopLoss: stableNumber(setup.stopLoss ?? setup.invalidationPrice),
    strategyParamsHash: strategyHash,
    symbol: stableString(symbol ?? setup.symbol),
    takeProfit: stableNumber(takeProfit ?? setup.takeProfit ?? setup.targetPrice),
    triggerPrice: stableNumber(setup.trigger ?? setup.triggerPrice),
  };
}

export function buildSetupFingerprint(context = {}) {
  const input = setupFingerprintInput(context);
  const hash = hashPayload(input, 20);
  return {
    hash,
    id: `sf_${hash}`,
    input,
    shortId: hash.slice(0, 8).toUpperCase(),
    strategyParamsHash: input.strategyParamsHash,
  };
}

export function withSetupFingerprint(setup = {}, context = {}) {
  if (!setup) return setup;
  const fingerprint = buildSetupFingerprint({
    ...context,
    setup,
  });
  return {
    ...setup,
    setupFingerprint: fingerprint.id,
    setupFingerprintInput: fingerprint.input,
    setupFingerprintShort: fingerprint.shortId,
    strategyParamsHash: fingerprint.strategyParamsHash,
  };
}

export function sameSetupFingerprint(left, right) {
  const leftFingerprint = typeof left === "string" ? left : left?.setupFingerprint;
  const rightFingerprint = typeof right === "string" ? right : right?.setupFingerprint;
  return Boolean(leftFingerprint && rightFingerprint && leftFingerprint === rightFingerprint);
}
