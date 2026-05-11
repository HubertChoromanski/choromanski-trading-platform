import { formatNumber, formatPercent, metric } from "./confidenceScoring.js";

function paramsText(row = {}) {
  const params = row.params ?? {};
  const parts = [];
  if (params.bandwidth !== undefined) parts.push(`BW ${params.bandwidth}`);
  if (params.envelopeMultiplier !== undefined) parts.push(`NWE ${params.envelopeMultiplier}`);
  if (params.atrLength !== undefined || params.atrMultiplier !== undefined) {
    parts.push(`ATR ${params.atrLength ?? "?"}/${params.atrMultiplier ?? "?"}`);
  }
  if (params.maxSameSideFailures !== undefined) parts.push(`max failures ${params.maxSameSideFailures}`);
  if (params.sizingMode) parts.push(params.sizingMode);
  return parts.join(", ") || "parameters not stored";
}

export function buildEvidence({ row = {}, rows = [], run = {} } = {}) {
  const rank = row.rank ?? ((rows.findIndex((item) => item?.id === row?.id) + 1) || 1);
  const evidence = [
    `Rank ${rank}; score ${formatNumber(row.score ?? row.research?.robustnessScore)}.`,
    `Net ${formatNumber(metric(row, "netProfit"))} USDT, PF ${formatNumber(metric(row, "profitFactor"))}, drawdown ${formatNumber(metric(row, "maxDrawdown"))}, win rate ${formatPercent(metric(row, "winRate"))}, trades ${formatNumber(metric(row, "totalTrades"), 0)}.`,
    `Parameters: ${paramsText(row)}.`,
    `Range: ${row.canonical?.range?.from ?? row.provenance?.from ?? run.plan?.range?.from ?? "unknown"} to ${row.canonical?.range?.to ?? row.provenance?.to ?? run.plan?.range?.to ?? "unknown"}; fill ${row.canonical?.fillMode ?? row.params?.fillMode ?? run.plan?.fillMode ?? "legacy"}; sizing ${row.canonical?.sizingMode ?? row.params?.sizingMode ?? run.plan?.sizingMode ?? "position-percent"}.`,
  ];

  if (row.research?.label) evidence.push(`Research label: ${row.research.label}.`);
  if (row.integrity?.warnings?.length) {
    evidence.push(`Integrity warnings: ${row.integrity.warnings.join(" ")}`);
  }
  if (row.research?.overfit?.label) {
    evidence.push(`Overfit risk: ${row.research.overfit.label}; ${(row.research.overfit.explanation ?? []).join(" ")}`);
  }
  if (row.validation?.fillSensitivity) {
    const sensitivity = row.validation.fillSensitivity;
    evidence.push(`Fill sensitivity: ${sensitivity.label}; Legacy net ${formatNumber(sensitivity.legacyNet)}, Conservative net ${formatNumber(sensitivity.conservativeNet)}, drop ${formatPercent(sensitivity.dropPercent)}.`);
  }
  if (row.validation?.periods?.length) {
    const periods = row.validation.periods;
    const profitable = periods.filter((period) => metric(period, "netProfit") > 0).length;
    const worst = periods.slice().sort((left, right) => metric(left, "netProfit") - metric(right, "netProfit"))[0];
    const best = periods.slice().sort((left, right) => metric(right, "netProfit") - metric(left, "netProfit"))[0];
    evidence.push(`Period validation: ${profitable}/${periods.length} periods profitable; best ${best?.label ?? "n/a"} (${formatNumber(metric(best, "netProfit"))}), worst ${worst?.label ?? "n/a"} (${formatNumber(metric(worst, "netProfit"))}).`);
  }
  if (row.validation?.timeframes?.length) {
    const positives = row.validation.timeframes.filter((item) => metric(item, "netProfit") > 0).length;
    evidence.push(`Neighboring timeframe validation: ${positives}/${row.validation.timeframes.length} positive.`);
  }

  return {
    bullets: evidence,
    paramsText: paramsText(row),
  };
}

export function strongestAndWeakestRows(rows = []) {
  const ranked = rows.filter(Boolean);
  return {
    bestDrawdown: ranked.slice().sort((left, right) => Math.abs(metric(left, "maxDrawdown")) - Math.abs(metric(right, "maxDrawdown")))[0] ?? null,
    bestPf: ranked.slice().sort((left, right) => metric(right, "profitFactor") - metric(left, "profitFactor"))[0] ?? null,
    rawBest: ranked.slice().sort((left, right) => metric(right, "netProfit") - metric(left, "netProfit"))[0] ?? null,
    selected: ranked[0] ?? null,
  };
}
