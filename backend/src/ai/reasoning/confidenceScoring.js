export function metric(row = {}, key, fallback = 0) {
  const canonicalKey = key === "netProfit"
    ? "netPnl"
    : key === "totalTrades"
      ? "trades"
      : key;
  const value = row?.canonical?.metrics?.[canonicalKey] ?? row?.metrics?.[key] ?? row?.[key] ?? fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function formatNumber(value, digits = 2) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(digits) : "n/a";
}

export function formatPercent(value, digits = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(digits)}%` : "n/a";
}

export function confidenceScore({ row = {}, rows = [] } = {}) {
  const reasons = [];
  const trades = metric(row, "totalTrades");
  const profitFactor = metric(row, "profitFactor");
  const drawdown = Math.abs(metric(row, "maxDrawdown"));
  const netProfit = metric(row, "netProfit");
  const overfitLabel = row?.research?.overfit?.label;
  const overfitScore = Number(row?.research?.overfitRiskScore ?? row?.research?.overfit?.overfitRiskScore ?? 0);
  const completeness = row?.dataCompleteness ?? row?.canonical?.dataCompleteness;
  const fillDrop = Math.abs(Number(row?.validation?.fillSensitivity?.dropPercent ?? 0));
  const periods = row?.validation?.periods ?? [];
  const profitablePeriods = periods.filter((period) => metric(period, "netProfit") > 0).length;
  const periodRatio = periods.length ? profitablePeriods / periods.length : null;
  let score = 50;

  if (trades >= 80) {
    score += 15;
    reasons.push(`Trade sample is strong (${trades} trades).`);
  } else if (trades >= 35) {
    score += 8;
    reasons.push(`Trade sample is usable (${trades} trades).`);
  } else if (trades >= 15) {
    score -= 8;
    reasons.push(`Trade sample is thin (${trades} trades).`);
  } else {
    score -= 24;
    reasons.push(`Trade sample is too small for high confidence (${trades} trades).`);
  }

  if (completeness?.missingFields?.length) {
    score -= completeness.missingFields.length * 10;
    reasons.push(`Incomplete metrics: ${completeness.missingFields.join(", ")}.`);
  }

  if (netProfit > 0) score += 8;
  if (netProfit <= 0) {
    score -= 18;
    reasons.push("Net profit is not positive.");
  }

  if (profitFactor >= 1.6) {
    score += 10;
    reasons.push(`Profit factor is constructive (${formatNumber(profitFactor)}).`);
  } else if (profitFactor >= 1.25) {
    score += 4;
  } else if (profitFactor >= 1.15) {
    reasons.push(`Profit factor is positive but thin (${formatNumber(profitFactor)}).`);
  } else {
    score -= 12;
    reasons.push(`Profit factor is weak (${formatNumber(profitFactor)}).`);
  }

  if (drawdown <= 8) {
    score += 8;
  } else if (drawdown >= 18) {
    score -= 12;
    reasons.push(`Drawdown is heavy relative to a research candidate (${formatNumber(drawdown)}).`);
  }

  if (overfitLabel === "high" || overfitScore >= 0.7) {
    score -= 24;
    reasons.push("Overfit diagnostics are high risk.");
  } else if (overfitLabel === "moderate" || overfitScore >= 0.4) {
    score -= 11;
    reasons.push("Overfit diagnostics are moderate risk.");
  }

  if (fillDrop >= 35) {
    score -= 16;
    reasons.push(`Conservative fill sensitivity is high (${formatPercent(fillDrop)} drop).`);
  } else if (fillDrop >= 15) {
    score -= 7;
    reasons.push(`Conservative fill sensitivity is noticeable (${formatPercent(fillDrop)} drop).`);
  }

  if (periodRatio !== null) {
    if (periodRatio >= 0.7) {
      score += 8;
      reasons.push(`${profitablePeriods}/${periods.length} validation periods were profitable.`);
    } else if (periodRatio < 0.5) {
      score -= 14;
      reasons.push(`Only ${profitablePeriods}/${periods.length} validation periods were profitable.`);
    }
  }

  const rawBest = rows
    .slice()
    .sort((left, right) => metric(right, "netProfit") - metric(left, "netProfit"))[0];
  if (rawBest?.id && row?.id && rawBest.id !== row.id && metric(rawBest, "netProfit") > netProfit * 1.5) {
    reasons.push("A higher raw-PnL candidate exists, so this rank depends on robustness penalties and risk-adjusted scoring.");
  }

  const bounded = Math.max(0, Math.min(100, Math.round(score)));
  return {
    label: bounded >= 72 ? "high" : bounded >= 45 ? "moderate" : "low",
    reasons,
    score: bounded,
  };
}

export function riskAssessment({ row = {} } = {}) {
  const reasons = [];
  const trades = metric(row, "totalTrades");
  const drawdown = Math.abs(metric(row, "maxDrawdown"));
  const profitFactor = metric(row, "profitFactor");
  const overfit = row?.research?.overfit;
  const fillDrop = Math.abs(Number(row?.validation?.fillSensitivity?.dropPercent ?? 0));
  const periods = row?.validation?.periods ?? [];

  if (trades < 15) reasons.push("sample is too small");
  if (profitFactor < 1.2) reasons.push("profit factor is weak");
  if (drawdown > 18) reasons.push("drawdown is high");
  if (overfit?.label === "high") reasons.push("overfit risk is high");
  if (fillDrop > 35) reasons.push("Conservative fill damages the result");
  if (periods.length) {
    const profitable = periods.filter((period) => metric(period, "netProfit") > 0).length;
    if (profitable <= Math.floor(periods.length / 2)) reasons.push("period consistency is weak");
  }

  return {
    label: reasons.length >= 3 ? "high" : reasons.length ? "moderate" : "low",
    reasons: reasons.length ? reasons : ["No major risk flag was triggered by the stored diagnostics."],
  };
}
