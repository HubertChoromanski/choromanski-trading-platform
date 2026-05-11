export function critiqueAgentOSResult({ output = {}, plan = {} } = {}) {
  const warnings = [...(output.warnings ?? []), ...(output.qualityAudit?.warnings ?? [])];
  const missingArtifacts = [];
  if (plan.artifacts?.docx && !(output.artifacts ?? []).some((artifact) => artifact.format === "docx")) missingArtifacts.push("docx");
  if (plan.artifacts?.xlsx && !(output.artifacts ?? []).some((artifact) => artifact.format === "xlsx")) missingArtifacts.push("xlsx");
  return {
    confidence: output.qualityAudit?.strongEnough ? "moderate" : "low",
    missingArtifacts,
    mustDisclose: [
      "AH did not change strategy or backtest math.",
      "AH cannot place trades.",
      "Any live deployment requires separate explicit confirmation.",
      ...(missingArtifacts.length ? [`Missing requested artifacts: ${missingArtifacts.join(", ")}`] : []),
    ],
    warnings,
  };
}
