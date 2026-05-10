function net(row = {}) {
  return Number(row.metrics?.netProfit ?? row.netProfit ?? 0);
}

export function compareFillModes({ conservative, legacy }) {
  const legacyNet = net(legacy);
  const conservativeNet = net(conservative);
  const drop = legacyNet === 0 ? 0 : (legacyNet - conservativeNet) / Math.abs(legacyNet);

  return {
    conservativeNet,
    dropPercent: Number((drop * 100).toFixed(2)),
    label: Math.abs(drop) < 0.15 ? "low sensitivity" : Math.abs(drop) < 0.35 ? "moderate sensitivity" : "high sensitivity",
    legacyNet,
  };
}

export function compareSizingModes({ fixedRisk, positionPercent }) {
  return {
    fixedRiskNet: net(fixedRisk),
    label: Math.abs(net(positionPercent) - net(fixedRisk)) < Math.max(1, Math.abs(net(positionPercent)) * 0.15)
      ? "similar sizing profile"
      : "sizing sensitive",
    positionPercentNet: net(positionPercent),
  };
}
