const MAX_LEVERAGE = 50;

export function validateOrder({
  config,
  dailyLoss = 0,
  openPositions = [],
  order,
  tradesToday = 0,
}) {
  if (config.emergencyStop) {
    return { allowed: false, reason: "Emergency stop active" };
  }

  if (!order.stopLoss || !Number.isFinite(order.stopLoss)) {
    return { allowed: false, reason: "Missing stop loss" };
  }

  if (!Number.isFinite(order.notionalSize) || order.notionalSize <= 0) {
    return { allowed: false, reason: "Invalid position size" };
  }

  if (order.notionalSize < config.minimumPositionSize) {
    return { allowed: false, reason: "Below minimum position size" };
  }

  if (order.notionalSize > config.maximumPositionSize) {
    return { allowed: false, reason: "Above maximum position size" };
  }

  if (order.marginRequired > config.startingBalance) {
    return { allowed: false, reason: "Margin exceeds balance" };
  }

  if (!Number.isFinite(config.leverage) || config.leverage <= 0 || config.leverage > MAX_LEVERAGE) {
    return { allowed: false, reason: "Invalid leverage" };
  }

  if (Math.abs(dailyLoss) >= config.startingBalance * (config.maxDailyLossPercent / 100)) {
    return { allowed: false, reason: "Daily loss limit reached" };
  }

  if (tradesToday >= config.maxTradesPerDay) {
    return { allowed: false, reason: "Max trades per day reached" };
  }

  if (openPositions.length >= config.maxOpenPositions) {
    return { allowed: false, reason: "Max open positions reached" };
  }

  if (openPositions.some((position) => position.direction === order.direction)) {
    return { allowed: false, reason: "Duplicate same-side position" };
  }

  if (order.direction === "LONG" && !config.allowLong) {
    return { allowed: false, reason: "Longs disabled" };
  }

  if (order.direction === "SHORT" && !config.allowShort) {
    return { allowed: false, reason: "Shorts disabled" };
  }

  return { allowed: true, reason: "Allowed" };
}
