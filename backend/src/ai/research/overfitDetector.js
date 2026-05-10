import { metric, sampleQuality } from "./researchScoring.js";

function ratioDrop(base, comparison) {
  const baseProfit = Math.abs(metric(base, "netProfit"));
  if (baseProfit <= 0) return comparison && metric(comparison, "netProfit") < 0 ? 1 : 0;
  return Math.max(0, (metric(base, "netProfit") - metric(comparison, "netProfit")) / baseProfit);
}

export function detectOverfit(candidate = {}, validation = {}) {
  const reasons = [];
  let score = 0;
  const trades = metric(candidate, "totalTrades");
  const sample = sampleQuality(trades);

  if (sample.score < 0.45) {
    score += 0.25;
    reasons.push(`Trade sample is thin (${trades} trades).`);
  }

  const periods = validation.periods ?? [];
  if (periods.length) {
    const profitable = periods.filter((period) => metric(period, "netProfit") > 0).length;
    const worst = periods.reduce((min, period) => Math.min(min, metric(period, "netProfit")), Infinity);
    const best = periods.reduce((max, period) => Math.max(max, metric(period, "netProfit")), -Infinity);
    const consistency = profitable / periods.length;

    if (consistency < 0.5) {
      score += 0.25;
      reasons.push(`Only ${profitable}/${periods.length} validation periods were profitable.`);
    }

    if (Number.isFinite(best) && Number.isFinite(worst) && best > 0 && Math.abs(worst) > best * 0.8) {
      score += 0.15;
      reasons.push("One weak period gives back most of a strong period.");
    }
  }

  if (validation.legacy && validation.conservative) {
    const drop = ratioDrop(validation.legacy, validation.conservative);
    if (drop > 0.35) {
      score += 0.25;
      reasons.push(`Conservative fill reduces profit by about ${(drop * 100).toFixed(0)}%.`);
    }
  }

  const timeframes = validation.timeframes ?? [];
  if (timeframes.length) {
    const positive = timeframes.filter((row) => metric(row, "netProfit") > 0).length;
    if (positive <= Math.floor(timeframes.length / 2)) {
      score += 0.15;
      reasons.push("Nearby timeframe validation is weak.");
    }
  }

  if (metric(candidate, "profitFactor") > 4 && trades < 30) {
    score += 0.15;
    reasons.push("Very high profit factor on a small sample can be curve-fit.");
  }

  const bounded = Math.max(0, Math.min(1, score));
  return {
    explanation: reasons.length ? reasons : ["No major overfit warning was triggered by the available validation data."],
    label: bounded >= 0.7 ? "high" : bounded >= 0.4 ? "moderate" : "low",
    overfitRiskScore: Number(bounded.toFixed(3)),
  };
}
