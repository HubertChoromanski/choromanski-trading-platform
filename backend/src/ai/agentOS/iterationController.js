export function decideNextIteration({ output = {}, userGoal = "" } = {}) {
  const weak = output.qualityAudit?.strongEnough === false;
  const lowRows = !(output.rankedResults ?? output.rows ?? []).length;
  if (lowRows) {
    return {
      action: "ask_user",
      reason: "No result rows were produced.",
      suggestion: "Expand data range, check candle availability, or loosen constraints.",
    };
  }
  if (weak) {
    return {
      action: "propose_followup",
      reason: "Best rows are weak or incomplete.",
      suggestion: "Expand parameter ranges or run a broader adaptive sweep.",
    };
  }
  if (/manual|reczny|ręczny|hubert/i.test(userGoal)) {
    return {
      action: "compare_baseline",
      reason: "User referenced a manual/baseline comparison.",
      suggestion: "Run auditSearchCoverage against the named saved backtest.",
    };
  }
  return {
    action: "validate",
    reason: "Research candidates exist.",
    suggestion: "Validate top category winners on Conservative fill and neighboring periods.",
  };
}
