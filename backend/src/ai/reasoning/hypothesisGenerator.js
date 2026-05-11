import { metric } from "./confidenceScoring.js";

export function generateHypotheses({ row = {}, question = "" } = {}) {
  const params = row.params ?? {};
  const text = question.toLowerCase();
  const hypotheses = [];

  if (params.atrMultiplier !== undefined) {
    hypotheses.push(Number(params.atrMultiplier) >= 1.5
      ? "Higher ATR multiplier likely filtered tighter/noisier exits and reduced false reversal pressure, but may also lower trade frequency."
      : "Lower ATR multiplier likely made the system more reactive, which can improve early exits but may increase noise sensitivity.");
  }
  if (params.bandwidth !== undefined) {
    hypotheses.push(Number(params.bandwidth) >= 10
      ? "Wider bandwidth usually smooths the envelope and may reduce marginal setups."
      : "Narrower bandwidth usually reacts faster and may create more setup candidates, with higher noise risk.");
  }
  if (params.envelopeMultiplier !== undefined) {
    hypotheses.push(Number(params.envelopeMultiplier) >= 3
      ? "A larger NWE multiplier tends to demand more extreme band interaction before setups appear."
      : "A smaller NWE multiplier tends to make setups easier to trigger and may raise trade frequency.");
  }
  if (params.maxSameSideFailures !== undefined) {
    hypotheses.push(`maxSameSideFailures=${params.maxSameSideFailures} controls how quickly repeated failed same-side/opposite setup behavior stops or blocks continuation. Very low values can cut trends early; high values can tolerate more adverse setup failures.`);
  }
  if (params.sizingMode) {
    hypotheses.push(params.sizingMode === "fixed-risk"
      ? "Fixed Risk sizing normalizes capital-at-stop, so PnL changes are driven less by variable stop distance and more by signal quality."
      : "Position Percent sizing keeps exposure simpler, but actual loss at SL varies with stop distance.");
  }
  if (text.includes("parameter") || text.includes("matter")) {
    hypotheses.push("The best way to identify the dominant parameter is a local sensitivity check around the top rows, not a single sweep ranking.");
  }
  if (metric(row, "totalTrades") < 20) {
    hypotheses.push("Because trade count is low, any parameter story should be treated as a hypothesis rather than a conclusion.");
  }

  return hypotheses.length ? hypotheses : ["The stored row has limited parameter context, so I would validate nearby settings before assigning a causal explanation."];
}

