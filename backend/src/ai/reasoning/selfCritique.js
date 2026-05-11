import { metric } from "./confidenceScoring.js";

export function selfCritique({ row = {}, confidence, risk } = {}) {
  const warnings = [];
  if (confidence?.label !== "high") warnings.push(`Confidence is ${confidence?.label ?? "unknown"}, so I should avoid a hard recommendation.`);
  if (risk?.label !== "low") warnings.push(`Risk is ${risk?.label ?? "unknown"} because ${(risk?.reasons ?? []).join(", ")}.`);
  if (metric(row, "profitFactor") > 3.5 && metric(row, "totalTrades") < 35) {
    warnings.push("The PF/sample combination is suspicious enough that I would expect degradation in another period.");
  }
  if (!row.validation?.periods?.length) warnings.push("I cannot verify period consistency from the stored row.");

  return {
    summary: warnings.length
      ? "The conclusion needs caution because the stored evidence has gaps or fragility."
      : "The conclusion is supported by the stored diagnostics, though it is still only backtest evidence.",
    warnings,
  };
}

