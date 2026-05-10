import { sectionsToMarkdown, structuredResponse } from "./aiPromptTemplates.js";

function toolEvidence(toolName, result) {
  if (!result) return [];
  if (toolName === "getPlatformStatus") {
    return [
      `Bot status: ${result.status?.state?.botStatus ?? "unknown"}`,
      `Open live positions: ${result.live?.positions?.length ?? 0}`,
      `Data availability rows: ${result.availability?.length ?? 0}`,
    ];
  }
  if (toolName === "runHistoricalBacktest") {
    return [
      `Candles used: ${result.candlesUsed ?? 0}`,
      `Trades: ${result.metrics?.totalTrades ?? 0}`,
      `Net profit: ${result.metrics?.netProfit ?? 0}`,
      `Max drawdown: ${result.metrics?.maxDrawdown ?? 0}%`,
    ];
  }
  if (toolName === "runSweepAnalysis") {
    return [
      `Combinations tested: ${result.totalCombinations ?? 0}`,
      `Best score: ${result.best?.score ?? "none"}`,
    ];
  }
  return [`Tool used: ${toolName}`];
}

export function createAiService({ buildAiContext, memory, provider = process.env.AI_PROVIDER || "mock", tools }) {
  const providerMode = ["mock", "disabled", "local-placeholder"].includes(provider)
    ? provider
    : "mock";

  function status() {
    return {
      configured: false,
      message:
        providerMode === "disabled"
          ? "AI provider is disabled. The Workbench tools still run locally."
          : "AI Analyst Workbench is in mock mode. Add an external provider later for conversational reasoning.",
      model: process.env.AI_MODEL ?? "not connected",
      ok: true,
      provider: providerMode,
      tradingEnabled: false,
    };
  }

  async function chat(body = {}) {
    const message = String(body.message ?? "").trim();
    if (!message) {
      return {
        ok: false,
        message: "Ask a question first.",
      };
    }

    const context = await buildAiContext(body.context ?? {});
    const lower = message.toLowerCase();
    let toolName = "explainCurrentSetup";

    if (lower.includes("backtest")) toolName = "summarizeBacktest";
    if (lower.includes("sweep")) toolName = "runSweepAnalysis";
    if (lower.includes("status") || lower.includes("data") || lower.includes("live")) toolName = "getPlatformStatus";
    if (lower.includes("error") || lower.includes("issue") || lower.includes("can't") || lower.includes("cannot")) toolName = "diagnoseIssue";

    let toolResult;
    try {
      if (toolName === "runSweepAnalysis") {
        toolResult = await tools.runSweepAnalysis({ maxCombinations: 20 });
      } else if (toolName === "diagnoseIssue") {
        toolResult = await tools.diagnoseIssue({ question: message });
      } else {
        toolResult = await tools[toolName]();
      }
    } catch (error) {
      toolResult = {
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const response = structuredResponse({
      answer:
        "Mock AI read the selected safe platform context and ran a local analysis tool. External LLM reasoning is intentionally not connected in this foundation pass.",
      calculations: toolEvidence(toolName, toolResult),
      evidence: [
        `Provider mode: ${providerMode}`,
        `Context includes decks: ${Boolean(context.selectedSetup)}`,
        `Context includes latest backtest: ${Boolean(context.latestBacktest)}`,
      ],
      nextAction: "Use Quick Actions for exact tool output, or connect an external LLM provider later for richer explanations.",
      recommendation: "Review the tool output and verify in Backtests/Sweep before changing any live Battle Deck.",
      risks: ["Mock responses are deterministic summaries, not external LLM reasoning."],
    });
    const assistantText = sectionsToMarkdown(response);

    await memory.appendSessionMessage({ role: "user", text: message });
    await memory.appendSessionMessage({ role: "assistant", text: assistantText, toolName });

    return {
      contextSummary: {
        latestBacktest: context.latestBacktest?.name ?? null,
        selectedTimeframe: context.chart?.selectedTimeframe ?? null,
        symbol: context.chart?.currentSymbol ?? null,
      },
      message: assistantText,
      ok: true,
      provider: providerMode,
      structured: response,
      toolName,
      toolResult,
    };
  }

  return {
    chat,
    status,
  };
}
