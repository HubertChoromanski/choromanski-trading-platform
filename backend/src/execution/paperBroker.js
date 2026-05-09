export function calculatePaperPositionSize({ entryPrice, equity, risk, stopLoss }) {
  const slDistancePercent = Math.abs(entryPrice - stopLoss) / entryPrice;
  const mode = risk.positionSizeMode ?? "risk-based";
  const riskAmount = equity * (Number(risk.riskPerTradePercent ?? 1) / 100);
  const notionalSize =
    mode === "fixed-usdt"
      ? Number(risk.fixedNotional ?? 0)
      : mode === "percent-move"
        ? equity * Number(risk.priceMoveRiskPercent ?? 1)
        : slDistancePercent > 0
          ? riskAmount / slDistancePercent
          : 0;
  const requiredLeverage =
    equity > 0 && notionalSize > 0
      ? Math.max(1, Math.ceil(notionalSize / equity))
      : Math.max(1, Number(risk.leverage ?? 1));
  const leverage = Math.max(requiredLeverage, Number(risk.leverage ?? 1));

  return {
    leverage,
    marginRequired: notionalSize / leverage,
    notionalSize,
    quantity: entryPrice > 0 ? notionalSize / entryPrice : 0,
    riskAmount,
    sizingMode: mode,
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
