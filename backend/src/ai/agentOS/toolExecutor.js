import { runResearchWorkflow } from "../research/researchEngine.js";
import { createAgentOSArtifacts } from "./artifactEngine.js";
import { selectCategoryWinners, auditResultQuality, auditSearchCoverage } from "./resultAuditor.js";
import { critiqueAgentOSResult } from "./selfCritic.js";
import { decideNextIteration } from "./iterationController.js";

export async function executeAgentOSTask({ isCancelled, onProgress, plan, run, toolRegistry }) {
  await onProgress({ completed: 0, percent: 2, total: plan.maxCombinations ?? 1000 }, "Agent OS planning");
  const researchOutput = await runResearchWorkflow({
    isCancelled,
    onProgress,
    plan: {
      ...plan,
      jobId: run.id,
      methodology: plan.methodology ?? "adaptive multi-stage search",
    },
    toolRegistry,
  });

  if (researchOutput.cancelled) {
    return {
      ...researchOutput,
      agentOS: true,
      summary: researchOutput.summary ?? "Agent OS task cancelled during research.",
    };
  }

  const rows = researchOutput.rankedResults ?? researchOutput.rows ?? [];
  const categoryWinners = selectCategoryWinners(rows);
  const qualityAudit = auditResultQuality(rows, categoryWinners);
  const searchCoverage = auditSearchCoverage({ agentPlan: plan, aiRun: run });
  const output = {
    ...researchOutput,
    agentOS: true,
    categoryWinners,
    nextTests: [
      "Open each category winner as a normal backtest and verify metric parity.",
      "Run Conservative fill validation for the PF and overall winners.",
      "Run a neighboring-parameter sweep around winners that survive validation.",
      "Compare winners against any manual baseline if one exists.",
    ],
    qualityAudit,
    recommendation: qualityAudit.strongEnough
      ? "Treat the category winners as research candidates. Validate them before creating strategy deck drafts."
      : "Nie znalazłem dobrego kandydata w tym zakresie. Najlepsze wyniki są słabe lub niepełne; rozszerz zakres parametrów albo sprawdź inną metodę.",
    searchCoverage,
    summary: qualityAudit.strongEnough
      ? `Agent OS completed adaptive research and selected category winners from ${rows.length} ranked rows.`
      : "Agent OS completed the search, but the result quality is weak or incomplete.",
    toolsUsed: [
      ...(researchOutput.toolsUsed ?? []),
      "getTopByMetric",
      "rankByPF",
      "rankByWinRate",
      "rankByNetProfit",
      "rankByDrawdown",
      "rankOverall",
      "detectOverfit",
      "auditSearchCoverage",
      "createResearchPackage",
    ],
    warnings: [
      ...(researchOutput.warnings ?? []),
      ...(qualityAudit.warnings ?? []),
      "Agent OS is analysis-only and cannot trade automatically.",
    ],
  };
  output.selfCritique = critiqueAgentOSResult({ output, plan });
  output.iterationDecision = decideNextIteration({ output, userGoal: plan.userGoal ?? run.prompt });
  output.artifacts = createAgentOSArtifacts({ output, plan, run });
  await onProgress({ completed: plan.maxCombinations ?? rows.length, percent: 100, total: plan.maxCombinations ?? rows.length }, "Agent OS report package ready");
  return output;
}
