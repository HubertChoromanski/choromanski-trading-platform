import { sectionsToMarkdown, structuredResponse } from "./aiPromptTemplates.js";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";
const DEFAULT_MAX_TOKENS = 900;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CONTEXT_CHARS = 80_000;
const MAX_PROMPT_CHARS = 100_000;

function configuredModel() {
  return process.env.OPENAI_MODEL || process.env.AI_MODEL || DEFAULT_OPENAI_MODEL;
}

function configuredMaxTokens() {
  return Math.max(128, Math.min(Number(process.env.AI_MAX_TOKENS || DEFAULT_MAX_TOKENS), 4000));
}

function configuredTemperature() {
  return Math.max(0, Math.min(Number(process.env.AI_TEMPERATURE ?? DEFAULT_TEMPERATURE), 1));
}

function normalizeProvider(provider) {
  const mode = String(provider || "mock").toLowerCase();
  if (["mock", "disabled", "local-placeholder", "openai"].includes(mode)) return mode;
  return "mock";
}

function providerErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("401")) return "OpenAI rejected the API key. Check OPENAI_API_KEY on the backend.";
  if (message.includes("404")) return "OpenAI could not find that model. Check OPENAI_MODEL on the backend.";
  if (message.includes("429")) return "OpenAI rate limit reached. Wait a moment and try again.";
  if (message.includes("timeout") || message.includes("AbortError")) return "OpenAI request timed out. Try again with less context.";
  return message || "OpenAI provider error.";
}

function extractOpenAiText(payload = {}) {
  if (payload.output_text) return payload.output_text;
  const parts = [];

  (payload.output ?? []).forEach((item) => {
    (item.content ?? []).forEach((content) => {
      if (content.text) parts.push(content.text);
    });
  });

  return parts.join("\n").trim();
}

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
  const providerMode = normalizeProvider(provider);
  let lastError = "";
  let lastProviderOkAt = null;

  function status() {
    const openAiConfigured = Boolean(process.env.OPENAI_API_KEY);
    const connected = providerMode === "openai" ? openAiConfigured && !lastError : providerMode !== "disabled";

    return {
      connected,
      configured: providerMode === "openai" ? openAiConfigured : false,
      lastError: lastError || "",
      message:
        providerMode === "disabled"
          ? "AI provider is disabled. The Workbench tools still run locally."
          : providerMode === "openai"
            ? openAiConfigured
              ? lastError
                ? `OpenAI configured, but the last request failed: ${lastError}`
                : "AI Analyst Workbench is connected to OpenAI through the backend."
              : "OpenAI provider selected, but OPENAI_API_KEY is missing on the backend."
            : "AI Analyst Workbench is in mock mode. Add an external provider later for conversational reasoning.",
      mockFallback: providerMode !== "openai",
      model: providerMode === "openai" ? configuredModel() : "not connected",
      ok: providerMode === "openai" ? openAiConfigured && !lastError : true,
      provider: providerMode,
      providerOkAt: lastProviderOkAt,
      tradingEnabled: false,
    };
  }

  async function callOpenAi({ context, message, toolName, toolResult }) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is missing on the backend.");
    }

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), DEFAULT_TIMEOUT_MS);
    const safeContext = JSON.stringify(context).slice(0, MAX_CONTEXT_CHARS);
    const safeToolResult = JSON.stringify(toolResult ?? {}).slice(0, 20_000);
    const prompt = [
      "You are the AI Analyst inside Choromański Trading Platform.",
      "Act like a senior quantitative research analyst: critical, evidence-led, precise, and comfortable saying when a result is weak.",
      "You analyze only. You must not place orders, modify execution, modify code, or tell the user that a trade is guaranteed.",
      "Use simple operator language. If data is stale, incomplete, low-sample, regime-dependent, or suspicious, say so clearly.",
      "Do not repeat metrics without interpretation. Explain why a config ranked well, what contradicts the ranking, what worries you, and what should be tested next.",
      "Mention confidence, uncertainty, overfit risk, fill-mode sensitivity, period consistency, and sample quality whenever the data supports it.",
      "Prefer robustness-adjusted reasoning over raw PnL. Warn when high PnL may be misleading.",
      "Never request or reveal secrets.",
      "Return sections with these headings: Answer, Evidence/Data Used, Calculations/Stats, Recommendation, Risks/Warnings, Next Action.",
      "",
      `Backend-controlled tool selected: ${toolName}`,
      `Tool result summary JSON:\n${safeToolResult}`,
      `Safe platform context JSON:\n${safeContext}`,
      "",
      `User question:\n${message}`,
    ].join("\n").slice(0, MAX_PROMPT_CHARS);

    try {
      const response = await fetch(OPENAI_RESPONSES_URL, {
        body: JSON.stringify({
          input: prompt,
          max_output_tokens: configuredMaxTokens(),
          model: configuredModel(),
          temperature: configuredTemperature(),
        }),
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        method: "POST",
        signal: abortController.signal,
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(`OpenAI HTTP ${response.status}: ${payload.error?.message || "provider error"}`);
      }

      const text = extractOpenAiText(payload);
      if (!text) {
        throw new Error("OpenAI returned an empty response.");
      }

      lastError = "";
      lastProviderOkAt = new Date().toISOString();
      return text;
    } finally {
      clearTimeout(timeout);
    }
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
    let structuredPayload = response;
    let assistantText = sectionsToMarkdown(response);
    let providerError = "";

    if (providerMode === "openai") {
      try {
        assistantText = await callOpenAi({
          context,
          message,
          toolName,
          toolResult,
        });
        structuredPayload = structuredResponse({
          answer: assistantText,
          calculations: toolEvidence(toolName, toolResult),
          evidence: [
            "OpenAI provider response.",
            `Backend-controlled tool selected: ${toolName}`,
          ],
          nextAction: "Verify the recommendation in the platform before changing any live configuration.",
          recommendation: "Use this as analysis only. AI cannot place trades or modify execution.",
          risks: ["Live data freshness and sample size still matter."],
        });
      } catch (error) {
        providerError = providerErrorMessage(error);
        lastError = providerError;
        structuredPayload = structuredResponse({
          answer: providerError,
          calculations: toolEvidence(toolName, toolResult),
          evidence: [
            "OpenAI provider selected.",
            `Backend-controlled tool selected: ${toolName}`,
          ],
          nextAction: "Check backend AI_PROVIDER, OPENAI_API_KEY, OPENAI_MODEL, rate limits, then retry.",
          recommendation: "Use mock quick tools for local analysis until provider health is restored.",
          risks: ["The failed provider request did not expose API keys to the frontend."],
        });
        assistantText = sectionsToMarkdown(structuredPayload);
      }
    }

    await memory.appendSessionMessage({ role: "user", text: message });
    await memory.appendSessionMessage({ provider: providerMode, role: "assistant", text: assistantText, toolName });

    return {
      contextSummary: {
        latestBacktest: context.latestBacktest?.name ?? null,
        selectedTimeframe: context.chart?.selectedTimeframe ?? null,
        symbol: context.chart?.currentSymbol ?? null,
      },
      message: assistantText,
      ok: providerMode === "openai" ? !providerError : true,
      providerError,
      provider: providerMode,
      structured: structuredPayload,
      toolName,
      toolResult,
    };
  }

  return {
    chat,
    status,
  };
}
