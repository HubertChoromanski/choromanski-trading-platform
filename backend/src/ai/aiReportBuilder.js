function fmt(value, digits = 2) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : "";
}

function metricRows(metrics = {}) {
  return [
    ["netProfit", fmt(metrics.netProfit)],
    ["profitFactor", fmt(metrics.profitFactor)],
    ["winRate", fmt(metrics.winRate)],
    ["maxDrawdown", fmt(metrics.maxDrawdown)],
    ["totalTrades", metrics.totalTrades ?? 0],
    ["expectancy", fmt(metrics.expectancy)],
    ["averageTrade", fmt(metrics.averageTrade)],
    ["largestWin", fmt(metrics.largestWin)],
    ["largestLoss", fmt(metrics.largestLoss)],
  ];
}

export function backtestConclusion(metrics = {}) {
  const tradeCount = Number(metrics.totalTrades ?? 0);
  const netProfit = Number(metrics.netProfit ?? 0);
  const drawdown = Number(metrics.maxDrawdown ?? 0);
  const profitFactor = Number(metrics.profitFactor ?? 0);

  if (tradeCount === 0) {
    return "No trades were found in this sample. Check candle count, timeframe, and whether the strategy has enough setup events.";
  }

  if (netProfit > 0 && profitFactor >= 1.5 && drawdown < 10) {
    return "The sample is positive and drawdown stayed controlled. Next test wider periods to check robustness.";
  }

  if (netProfit > 0) {
    return "The sample is profitable, but risk quality depends on drawdown and trade count. Compare neighboring settings before trusting it.";
  }

  return "The sample is not profitable. Treat this configuration as weak for the selected period unless another period tells a different story.";
}

export function buildBacktestSummaryReport(result = {}) {
  return {
    conclusions: [backtestConclusion(result.metrics)],
    generatedAt: new Date().toISOString(),
    metrics: result.metrics ?? {},
    range: result.range ?? result.analysisRange ?? null,
    rows: metricRows(result.metrics),
    source: "backtest",
    title: result.name ?? "Backtest Summary",
  };
}

export function buildSweepReport(rows = []) {
  const ranked = rows.slice(0, 20);
  const best = ranked[0] ?? null;

  return {
    conclusions: [
      best
        ? `Best visible configuration by score is rank ${best.rank ?? 1} with net profit ${fmt(best.netProfit)} and drawdown ${fmt(best.maxDrawdown)}%.`
        : "No sweep results are available yet.",
      ranked.length < 10 ? "Small result sets are useful for debugging, not robustness." : "Compare nearby settings before assuming one row is stable.",
    ],
    generatedAt: new Date().toISOString(),
    rows: ranked.map((row) => ({
      maxDrawdown: row.maxDrawdown,
      netProfit: row.netProfit,
      params: row.params,
      profitFactor: row.profitFactor,
      rank: row.rank,
      score: row.score,
      totalTrades: row.totalTrades,
      winRate: row.winRate,
    })),
    source: "sweep",
    title: "Sweep Comparison Report",
  };
}

export function reportToCsv(report = {}) {
  const rows = report.rows ?? [];
  if (!rows.length) {
    return "field,value\nconclusion,\"No rows available\"\n";
  }

  if (Array.isArray(rows[0])) {
    return ["field,value", ...rows.map(([field, value]) => `${field},${value}`)].join("\n");
  }

  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const escape = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((key) => escape(typeof row[key] === "object" ? JSON.stringify(row[key]) : row[key])).join(",")),
  ].join("\n");
}
