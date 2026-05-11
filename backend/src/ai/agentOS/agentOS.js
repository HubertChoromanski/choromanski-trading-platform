import { executeAgentOSTask } from "./toolExecutor.js";
import { agentOSTaskToPlanOptions, isAgentOSGoal, planAgentOSTask } from "./taskPlanner.js";
import { AGENT_OS_TOOL_CATALOG } from "./fileManifest.js";

export { agentOSTaskToPlanOptions, isAgentOSGoal, planAgentOSTask };

export function createAgentOSPendingOperation({ message = "", options = {}, workspaceContext = {} } = {}) {
  const task = planAgentOSTask({ message, options, workspaceContext });
  const planOptions = agentOSTaskToPlanOptions(task, options);
  const id = `ah-agent-os-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    estimatedDuration: task.estimatedDuration,
    id,
    name: `AH Agent OS ${task.symbol} ${task.timeframe}`,
    params: {
      options: {
        ...planOptions,
        confirmLargeJob: true,
        operationId: id,
        workspaceContext,
      },
      prompt: message,
      workspaceContext,
    },
    plan: {
      ...planOptions,
      agentOSTask: task,
      maxCombinations: task.requestedCombinations,
      plannedCombinations: task.requestedCombinations,
      requestedCombinations: task.requestedCombinations,
      requestedCombinationsExplicit: true,
    },
    riskNotes: task.safetyNotes,
    status: task.missingFields.length ? "collecting_info" : "ready_to_confirm",
    summary: [
      task.symbol,
      task.timeframe,
      task.range ? `${task.range.from} → ${task.range.to}` : "range missing",
      `${task.requestedCombinations} combinations`,
      task.methodology,
      `artifacts: ${Object.entries(task.artifacts).filter(([, enabled]) => enabled).map(([key]) => key).join(", ")}`,
    ].join(" · "),
    tools: task.tools,
    type: "agent-os-research-package",
  };
}

export async function runAgentOS({ isCancelled, onProgress, plan, run, toolRegistry }) {
  return executeAgentOSTask({ isCancelled, onProgress, plan, run, toolRegistry });
}

export function agentOSToolCatalog() {
  return {
    ok: true,
    tools: AGENT_OS_TOOL_CATALOG,
    version: "agent-os-v1",
  };
}
