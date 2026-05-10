export function neighboringTimeframes(timeframe = "15m") {
  const order = ["10m", "15m", "20m", "30m", "1h", "4h"];
  const index = order.indexOf(timeframe);
  if (index < 0) return ["15m", "30m", "1h"];
  return [order[index - 1], order[index], order[index + 1]].filter(Boolean);
}

export function summarizeTimeframes(rows = []) {
  const ranked = rows
    .slice()
    .sort((left, right) => Number(right.metrics?.netProfit ?? right.netProfit ?? 0) - Number(left.metrics?.netProfit ?? left.netProfit ?? 0));

  return {
    bestTimeframe: ranked[0]?.timeframe ?? null,
    positiveTimeframes: rows.filter((row) => Number(row.metrics?.netProfit ?? row.netProfit ?? 0) > 0).map((row) => row.timeframe),
    weakTimeframes: ranked.slice(-2).map((row) => row.timeframe),
  };
}
