export function metric(row = {}, key, fallback = 0) {
  const value = row.metrics?.[key] ?? row[key] ?? fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function sampleQuality(trades = 0) {
  if (trades >= 80) return { label: "strong sample", score: 1 };
  if (trades >= 35) return { label: "usable sample", score: 0.75 };
  if (trades >= 15) return { label: "thin sample", score: 0.45 };
  return { label: "low sample", score: 0.15 };
}

export function robustnessScore(row = {}, analysis = {}) {
  const netProfit = metric(row, "netProfit");
  const drawdown = Math.max(0, metric(row, "maxDrawdown"));
  const profitFactor = Math.max(0, Math.min(metric(row, "profitFactor"), 5));
  const winRate = Math.max(0, Math.min(metric(row, "winRate"), 100));
  const trades = Math.max(0, metric(row, "totalTrades"));
  const consistency = Number.isFinite(Number(analysis.consistencyScore)) ? Number(analysis.consistencyScore) : 0.5;
  const fillPenalty = Math.max(0, Number(analysis.fillModeSensitivity ?? 0));
  const timeframePenalty = Math.max(0, Number(analysis.timeframeSensitivity ?? 0));
  const overfitPenalty = Math.max(0, Number(analysis.overfitRiskScore ?? 0));
  const capital = Number(analysis.startingBalance ?? 10000) || 10000;
  const netPercent = (netProfit / capital) * 100;
  const sample = sampleQuality(trades);

  return Number((
    netPercent * 1.2 +
    profitFactor * 4 +
    winRate * 0.08 +
    sample.score * 12 +
    consistency * 16 -
    drawdown * 0.9 -
    fillPenalty * 8 -
    timeframePenalty * 6 -
    overfitPenalty * 10
  ).toFixed(4));
}

export function candidateLabel(row = {}, analysis = {}) {
  const trades = metric(row, "totalTrades");
  const score = Number(row.robustnessScore ?? robustnessScore(row, analysis));
  const overfit = Number(analysis.overfitRiskScore ?? row.overfitRiskScore ?? 0);
  const drawdown = metric(row, "maxDrawdown");
  const netProfit = metric(row, "netProfit");

  if (trades < 15) return "low sample";
  if (overfit >= 0.7) return "overfit risk";
  if (score >= 25 && drawdown <= 12 && netProfit > 0) return "production candidate";
  if (netProfit > 0 && drawdown > 18) return "aggressive candidate";
  if (score < 0 || netProfit <= 0) return "unstable";
  return "regime dependent";
}
