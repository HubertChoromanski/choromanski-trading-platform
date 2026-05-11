import { metric } from "./confidenceScoring.js";

export function uncertaintyFactors({ row = {} } = {}) {
  const factors = [];
  const trades = metric(row, "totalTrades");
  const periods = row.validation?.periods ?? [];
  const fill = row.validation?.fillSensitivity;

  if (trades < 35) {
    factors.push(`Trade count is ${trades}, so statistical confidence is limited.`);
  }
  if (!periods.length) {
    factors.push("No period validation is stored for this row.");
  }
  if (!fill) {
    factors.push("Legacy vs Conservative fill sensitivity was not stored for this row.");
  }
  if (!row.validation?.timeframes?.length) {
    factors.push("Nearby timeframe validation is missing.");
  }
  if (row.research?.overfit?.label !== "low") {
    factors.push(`Overfit risk is ${row.research?.overfit?.label ?? "not evaluated"}.`);
  }

  return factors.length ? factors : ["The stored diagnostics are reasonably complete, but this is still a backtest result rather than live proof."];
}

