export function validateOrder({
  apiConfigured = false,
  availableBalance = null,
  dailyLoss = 0,
  exchangePositionMismatch = false,
  liveModeEnabled = false,
  openPosition,
  order,
  profile,
  tradesToday = 0,
}) {
  const risk = profile.risk;
  const isLive = profile.executionMode === "live";

  if (isLive && !liveModeEnabled) {
    return { allowed: false, reason: "Live mode is not running" };
  }

  if (isLive && !apiConfigured) {
    return { allowed: false, reason: "BingX API keys are not configured" };
  }

  if (risk.emergencyStop) {
    return { allowed: false, reason: "Emergency stop active" };
  }

  if (!order.stopLoss || !Number.isFinite(order.stopLoss)) {
    return { allowed: false, reason: "Missing stop loss" };
  }

  if (!Number.isFinite(order.notionalSize) || order.notionalSize <= 0) {
    return { allowed: false, reason: "Invalid position size" };
  }

  if (!Number.isFinite(order.quantity) || order.quantity <= 0) {
    return { allowed: false, reason: "Invalid order quantity" };
  }

  if (openPosition && openPosition.direction === order.direction) {
    return { allowed: false, reason: "Duplicate same-side position" };
  }

  if (openPosition && isLive) {
    return { allowed: false, reason: "One live position per profile is already open" };
  }

  if (order.direction === "LONG" && !risk.allowLong) {
    return { allowed: false, reason: "Longs disabled" };
  }

  if (order.direction === "SHORT" && !risk.allowShort) {
    return { allowed: false, reason: "Shorts disabled" };
  }

  if (Math.abs(dailyLoss) >= risk.startingBalance * (risk.maxDailyLossPercent / 100)) {
    return { allowed: false, reason: "Daily loss limit reached" };
  }

  if (tradesToday >= risk.maxTradesPerDay) {
    return { allowed: false, reason: "Max trades per day reached" };
  }

  if (isLive && exchangePositionMismatch) {
    return { allowed: false, reason: "Exchange/local position mismatch" };
  }

  if (isLive && order.marginRequired > Number(availableBalance ?? 0)) {
    return { allowed: false, reason: "Insufficient available balance" };
  }

  if (isLive && !profile.locked) {
    return { allowed: false, reason: "Execution profile must be locked" };
  }

  if (isLive && !profile.strategyDeployed) {
    return { allowed: false, reason: "Strategy profile is not deployed" };
  }

  return { allowed: true, reason: "Allowed" };
}
