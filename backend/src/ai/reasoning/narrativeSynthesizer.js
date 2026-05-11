import { formatNumber, metric } from "./confidenceScoring.js";

export function synthesizeNarrative({
  confidence,
  contradictions = [],
  evidence = [],
  hypotheses = [],
  next = [],
  question = "",
  recommendation = "",
  risk,
  row = {},
} = {}) {
  const rank = row.rank ?? 1;
  const lower = question.toLowerCase();
  const asksTrust = lower.includes("trust") || lower.includes("live") || lower.includes("worr") || lower.includes("fake") || lower.includes("suspicious");
  const asksRanking = lower.includes("rank") || lower.includes("best") || lower.includes("why");
  const conclusion = asksTrust
    ? recommendation
    : asksRanking
      ? `Config #${rank} ranks well only in a research sense: the ranking is driven by score, drawdown, PF, trade count, and validation penalties rather than one headline metric.`
      : `The selected result is a ${row.research?.label ?? "research candidate"} with ${confidence?.label ?? "unknown"} confidence and ${risk?.label ?? "unknown"} risk.`;

  const why = [
    `Its stored metrics are net ${formatNumber(metric(row, "netProfit"))} USDT, PF ${formatNumber(metric(row, "profitFactor"))}, max DD ${formatNumber(metric(row, "maxDrawdown"))}, and ${formatNumber(metric(row, "totalTrades"), 0)} trades.`,
    evidence[0] ?? "",
    contradictions[0] && contradictions[0] !== "No major internal contradiction stands out in the stored metrics." ? contradictions[0] : "",
  ].filter(Boolean).join(" ");

  const recommendationText = recommendation && recommendation !== conclusion ? ` ${recommendation}` : "";
  return {
    answer: `${conclusion} ${why}${recommendationText}`.trim(),
    sections: [
      { body: conclusion, title: "Conclusion" },
      { bullets: evidence.slice(0, 8), title: "Evidence Used" },
      { bullets: contradictions.slice(0, 4), title: "Conflicting Evidence" },
      { bullets: hypotheses.slice(0, 4), title: "Working Hypotheses" },
      { bullets: next.slice(0, 5), title: "Recommended Next Tests" },
    ],
  };
}
