export const POSITION_SIZE_MODES = {
  EQUITY_PERCENT: "equity-percent",
  FIXED_USDT: "fixed-usdt",
  RISK_BASED: "risk-based",
};

export function calculatePositionSize({
  entryPrice,
  equity,
  fixedUsdt = 100,
  leverage = 1,
  mode = POSITION_SIZE_MODES.RISK_BASED,
  riskPercent = 1,
  stopLoss,
  equityPercent = 10,
}) {
  const safeEntry = Number(entryPrice);
  const safeEquity = Number(equity);
  const safeLeverage = Math.max(1, Number(leverage) || 1);
  const slDistance = Math.abs(safeEntry - Number(stopLoss));
  const slDistancePercent = safeEntry > 0 ? slDistance / safeEntry : 0;
  let notionalSize;
  let riskAmount;

  if (mode === POSITION_SIZE_MODES.FIXED_USDT) {
    notionalSize = Math.max(0, Number(fixedUsdt) || 0);
    riskAmount = notionalSize * slDistancePercent;
  } else if (mode === POSITION_SIZE_MODES.EQUITY_PERCENT) {
    notionalSize = safeEquity * ((Number(equityPercent) || 0) / 100);
    riskAmount = notionalSize * slDistancePercent;
  } else {
    riskAmount = safeEquity * ((Number(riskPercent) || 0) / 100);
    notionalSize = slDistancePercent > 0 ? riskAmount / slDistancePercent : 0;
  }

  return {
    marginRequired: notionalSize / safeLeverage,
    notionalSize,
    quantity: safeEntry > 0 ? notionalSize / safeEntry : 0,
    riskAmount,
    slDistancePercent: slDistancePercent * 100,
  };
}
