import { formatNumber, metric } from "./confidenceScoring.js";

export function detectContradictions({ row = {}, rows = [] } = {}) {
  const findings = [];
  const net = metric(row, "netProfit");
  const pf = metric(row, "profitFactor");
  const dd = Math.abs(metric(row, "maxDrawdown"));
  const trades = metric(row, "totalTrades");
  const rawBest = rows.slice().sort((left, right) => metric(right, "netProfit") - metric(left, "netProfit"))[0];

  if (net > 0 && pf < 1.25) {
    findings.push("Net profit is positive, but profit factor is weak. That usually means the edge is thin or dependent on a few trades.");
  }
  if (net > 0 && dd > Math.abs(net) * 0.5) {
    findings.push("Drawdown is large relative to net profit, so the path may be hard to tolerate even if the final PnL is positive.");
  }
  if (pf > 4 && trades < 30) {
    findings.push("Profit factor is unusually high for a small sample. This can be real, but it is a classic suspicious-result pattern.");
  }
  if (rawBest?.id && row?.id && rawBest.id !== row.id) {
    findings.push(`The highest raw-PnL stored row is rank ${rawBest.rank ?? "n/a"} with net ${formatNumber(metric(rawBest, "netProfit"))}. The selected row is favored by risk-adjusted ranking, not raw profit alone.`);
  }

  return findings.length ? findings : ["No major internal contradiction stands out in the stored metrics."];
}
