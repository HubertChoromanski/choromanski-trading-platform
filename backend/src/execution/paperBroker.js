export function calculatePaperPositionSize({ entryPrice, equity, risk, stopLoss }) {
  const slDistancePercent = Math.abs(entryPrice - stopLoss) / entryPrice;
  const riskAmount = equity * (risk.riskPerTradePercent / 100);
  const notionalSize = slDistancePercent > 0 ? riskAmount / slDistancePercent : 0;

  return {
    marginRequired: notionalSize / Math.max(1, risk.leverage),
    notionalSize,
    quantity: entryPrice > 0 ? notionalSize / entryPrice : 0,
    riskAmount,
    slDistancePercent,
  };
}

export function createPaperPosition({ entryEvent, order }) {
  return {
    ...order,
    entryTime: entryEvent.time,
    setupId: entryEvent.setupId,
  };
}

export function closePaperPosition({ candle, event, position }) {
  const exitPrice = event?.exitPrice ?? position.stopLoss ?? candle.close;
  const pnl =
    position.direction === "LONG"
      ? (exitPrice - position.entryPrice) * position.quantity
      : (position.entryPrice - exitPrice) * position.quantity;

  return {
    exitPrice,
    pnl,
  };
}
