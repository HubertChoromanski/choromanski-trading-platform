import { formatNumber, metric } from "./confidenceScoring.js";

function rowName(row, fallback = "candidate") {
  return row ? `rank ${row.rank ?? fallback}` : fallback;
}

export function compareRows({ row = {}, rows = [] } = {}) {
  const top = rows[0] ?? row;
  const rawBest = rows.slice().sort((left, right) => metric(right, "netProfit") - metric(left, "netProfit"))[0] ?? row;
  const pfBest = rows.slice().sort((left, right) => metric(right, "profitFactor") - metric(left, "profitFactor"))[0] ?? row;
  const ddBest = rows.slice().sort((left, right) => Math.abs(metric(left, "maxDrawdown")) - Math.abs(metric(right, "maxDrawdown")))[0] ?? row;
  const comparisons = [];

  if (top?.id && row?.id && top.id !== row.id) {
    comparisons.push(`Compared with ${rowName(top, 1)}, this row has net ${formatNumber(metric(row, "netProfit"))} vs ${formatNumber(metric(top, "netProfit"))}, PF ${formatNumber(metric(row, "profitFactor"))} vs ${formatNumber(metric(top, "profitFactor"))}, and drawdown ${formatNumber(metric(row, "maxDrawdown"))} vs ${formatNumber(metric(top, "maxDrawdown"))}.`);
  }
  if (rawBest?.id && row?.id && rawBest.id !== row.id) {
    comparisons.push(`${rowName(rawBest)} has stronger raw PnL, but the robustness rank can reject it if its drawdown, sample quality, or validation penalties are worse.`);
  }
  if (pfBest?.id && row?.id && pfBest.id !== row.id) {
    comparisons.push(`${rowName(pfBest)} has the strongest stored PF (${formatNumber(metric(pfBest, "profitFactor"))}), but PF alone can over-reward small samples.`);
  }
  if (ddBest?.id && row?.id && ddBest.id !== row.id) {
    comparisons.push(`${rowName(ddBest)} has the lowest stored drawdown (${formatNumber(metric(ddBest, "maxDrawdown"))}), useful if capital preservation matters more than upside.`);
  }

  return comparisons.length ? comparisons : ["This row is the main stored comparison anchor in the active run."];
}

