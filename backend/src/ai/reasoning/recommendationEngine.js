import { metric } from "./confidenceScoring.js";

export function nextTests({ row = {}, rows = [], question = "" } = {}) {
  const tests = [];
  const lower = question.toLowerCase();
  const trades = metric(row, "totalTrades");

  if (!row.validation?.periods?.length || lower.includes("period") || lower.includes("q")) {
    tests.push("Split the same range into monthly or quarterly periods and check whether profit is distributed rather than concentrated.");
  }
  if (!row.validation?.fillSensitivity || lower.includes("conservative") || lower.includes("fill")) {
    tests.push("Re-test the selected config in Conservative fill mode and compare PF, net PnL, and drawdown.");
  }
  if (!row.validation?.timeframes?.length || lower.includes("timeframe")) {
    tests.push("Run the same config on neighboring timeframes to see if the edge survives small timing changes.");
  }
  if (rows.length >= 3) {
    tests.push("Run a local sensitivity sweep around the top 3 rows to see whether tiny parameter changes destroy the result.");
  }
  if (trades < 35) {
    tests.push("Extend the date range or use a higher-trade parameter neighborhood before trusting the result.");
  }

  return tests.slice(0, 5);
}

export function operatorRecommendation({ confidence, risk, row = {} }) {
  if (risk.label === "high" || confidence.label === "low") {
    return "I would not treat this as live-ready yet. Keep it in research and validate the weakness before creating a Battle Deck.";
  }
  if (confidence.label === "high" && risk.label === "low") {
    return "This is a reasonable production-candidate for deeper validation, not automatic deployment.";
  }
  if (row.research?.label === "aggressive candidate") {
    return "This is better framed as an aggressive candidate: interesting upside, but it needs stricter validation before live use.";
  }
  return "This is a research candidate. The next step is validation, not live execution.";
}

