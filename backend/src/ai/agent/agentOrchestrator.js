import { createAgentExecutor } from "./agentExecutor.js";
import { createAgentJobQueue } from "./agentJobQueue.js";
import { createAgentPlan } from "./agentPlanner.js";
import { createAgentRunStore } from "./agentRunStore.js";
import { checkAgentPlanSafety } from "./agentRiskGuard.js";
import { createAgentToolRegistry } from "./agentToolRegistry.js";
import {
  clarificationForIntent,
  isResearchPlanningMessage,
  researchIntentToPlanOptions,
  updateResearchIntent,
} from "./conversationResearchIntent.js";
import { composeAgentMarkdown, rowsToCsv } from "./agentReportComposer.js";
import { metricDiff as diffMetrics, normalizeResearchResult, summarizeIntegrity } from "./agentResultIntegrity.js";
import { buildReasoningResponse } from "../reasoning/reasoningEngine.js";

function isPolishQuestion(value = "") {
  const normalized = String(value)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  return /(^|\s)(czy|co|czemu|dlaczego|jak|gdzie|ile|pokaz|porownaj|wynik|dziala|nadal|robi|robia|ustawienia|blad|gorszy|lepszy|optymalnie|analiz)(\s|$)/u.test(normalized);
}

function normalizeCommandText(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function detectLiveExecutionIntent(message = "") {
  const normalized = normalizeCommandText(message);
  const priceMatch = normalized.match(/(?:na|to|=)\s*([0-9]+(?:[.,][0-9]+)?)/i) ?? normalized.match(/\b([0-9]+(?:[.,][0-9]+)?)\b/);
  const price = priceMatch?.[1] ? Number(priceMatch[1].replace(",", ".")) : null;

  if (/(zmien|ustaw|przesun|move|set|change).*\bsl\b|\bsl\b.*(zmien|ustaw|przesun|move|set|change)/i.test(normalized)) {
    return { action: "MOVE_SL", label: "Move SL", price };
  }
  if (/(zmien|ustaw|przesun|move|set|change).*\btp\b|\btp\b.*(zmien|ustaw|przesun|move|set|change)/i.test(normalized)) {
    return { action: "MOVE_TP", label: "Move TP", price };
  }
  if (/(zamknij|close).*(pozyc|position)|\bclose position\b/i.test(normalized)) {
    return { action: "CLOSE_POSITION", label: "Close Position", price: null };
  }
  if (/(cancel|anuluj|skasuj).*(orders|order|zlecen|protection)|cancel orders/i.test(normalized)) {
    return { action: "CANCEL_ATTACHED_ORDERS", label: "Cancel Protection/Orders", price: null };
  }
  return null;
}

function inferCopilotIntent(message = "", mode = "research") {
  const normalized = normalizeCommandText(message);
  const asksAboutButtons = /(przycisk|przyciski|button|buttons|verify integrity|re[- ]?run|rerun|open backtest|show metric diff)/i.test(normalized);
  const asksLimits = /(czego ai nie moze|czego ai nie może|what can.?t ai|what cannot ai|limitations|ograniczenia|nie moze jeszcze|nie może jeszcze)/i.test(normalized);
  const asksFailure = /(czemu|dlaczego|why|nie dziala|nie działa|failed|failure|error|blad|błąd|problem|unreachable|stale|lag)/i.test(normalized);
  const asksCode = /(kod|code|trace|sciezka|ścieżka|route|endpoint|function|plik|file|gdzie jest|where is)/i.test(normalized);
  const asksResearchRun = /(run|uruchom|odpal|zrob|zrób|sweep|kombinacj|combination|znajdz najlepsze|znajdź najlepsze|optimi[sz]e|optymaln|szukasz|backtestuj|przetestuj|ustawien)/i.test(normalized) ||
    isResearchPlanningMessage(message);
  const asksBaselineDefinition = /(co to|czym jest|what is).*(baseline|hubert)|baseline hubert.*(co to|czym jest|what is)/i.test(normalized);
  const asksResult = /(config|konfig|ranking|rank|wynik|result|pf|profit factor|drawdown|dd|hubert|baseline|backtest|lepszy|gorszy|better|worse|porownaj|porównaj|compare|pelna analiz|pełna analiz|deep analysis|full analysis)/i.test(normalized);
  const asksChart = /(chart|wykres|candle|swiec|świec|timeframe|zakres|range|equity|drawdown)/i.test(normalized);

  if (asksAboutButtons || asksLimits) return "general-platform-question";
  if (asksBaselineDefinition) return "general-platform-question";
  if (asksCode) return "code-platform-diagnosis";
  if (asksResearchRun) return "research-request";
  if (asksResult) return "current-research-result";
  if (asksFailure) return "platform-diagnosis";
  if (asksChart) return "chart-backtest-question";
  if (mode === "platform-diagnosis" || mode === "code-evidence" || mode === "platform") return "platform-diagnosis";
  return "general-platform-question";
}

function compactPositionForAnswer(position = {}) {
  if (!position) return null;
  return {
    apiProfile: position.apiProfile ?? position.profile ?? null,
    currentPrice: position.currentPrice ?? position.markPrice ?? null,
    positionId: position.positionId ?? position.positionID ?? position.id ?? null,
    positionSide: position.positionSide ?? position.side ?? null,
    quantity: position.quantity ?? position.qty ?? null,
    stopLoss: position.stopLoss ?? null,
    symbol: position.symbol ?? null,
    takeProfit: position.takeProfit ?? null,
  };
}

function recentResearchPrompt(memory = {}) {
  const candidates = (memory?.conversationSummary ?? []).filter((entry) => {
    const normalized = normalizeCommandText(entry.message ?? "");
    const looksLikeResearch = /(najlepsze|ustawienia|sweep|research|badanie|backtest|settings|znajdz|znajdź)/i.test(normalized);
    const looksLikePlanningAdvice = /(ile|optymalnie|how many).*(kombinacj|combination|test)/i.test(normalized);
    return looksLikeResearch && !looksLikePlanningAdvice;
  });
  return candidates.find((entry) => /\b[A-Z]{2,12}USDT\b/i.test(entry.message ?? "") || /\d{4}[.-]\d{1,2}[.-]\d{1,2}/.test(entry.message ?? ""))?.message ??
    candidates[0]?.message ??
    "";
}

function isCombinationAdviceQuestion(message = "") {
  const normalized = normalizeCommandText(message);
  return /(ile|jaka|jakie|how many|optymalnie|optimal).*(kombinacj|combination|test)/i.test(normalized) ||
    /(kombinacj|combination).*(ile|optymalnie|optimal)/i.test(normalized);
}

function isResearchMethodQuestion(message = "") {
  const normalized = normalizeCommandText(message);
  return /(w jaki sposob|w jaki sposób|jak pracujesz|how do you work|search strategy|szukasz optymaln|optymalnych ustawien|optymalnych ustawień|optymalne ustawien)/i.test(normalized);
}

function isResearchConfirmationMessage(message = "") {
  const normalized = normalizeCommandText(message);
  return /(zrob|zrób|odpal|uruchom|run|start|potwierdzam|confirm)\b/i.test(normalized) ||
    /^\s*\d{2,5}\s*(kombinacj|combination|test)?/i.test(normalized);
}

function isResearchContinuationCommand(message = "") {
  const normalized = normalizeCommandText(message);
  return /(zawez|zawęź|narrow|wokol|wokół|sprawdz|sprawdź|przetestuj|testuj|conservative|legacy|dla 1h|dla 30m)/i.test(normalized);
}

function rangeLabel(range = {}) {
  if (!range?.from || !range?.to) return "latest available range";
  return `${range.from.slice(0, 10)} → ${range.to.slice(0, 10)}`;
}

function estimateDurationLabel(combinations = 0) {
  const count = Number(combinations) || 0;
  if (count <= 100) return "about 1-3 minutes";
  if (count <= 200) return "about 3-8 minutes";
  if (count <= 500) return "about 8-18 minutes";
  if (count <= 1000) return "about 15-35 minutes";
  return "long run; likely 35+ minutes depending on cache and provider speed";
}

function buildPendingResearchOperation({ memory = {}, message = "", options = {}, researchIntent = null, workspaceContext = {} }) {
  const previous = recentResearchPrompt(memory);
  const combinedPrompt = previous && isResearchConfirmationMessage(message)
    ? `${previous}\n${message}`
    : message;
  const intent = researchIntent ?? memory.researchIntent ?? updateResearchIntent({
    message,
    previous: memory.researchIntent,
    workspaceContext,
  });
  const planOptions = researchIntentToPlanOptions(intent, options, workspaceContext);
  const plan = createAgentPlan({
    options: planOptions,
    prompt: combinedPrompt,
  });
  const baseline = plan.baselineQuery || (/(hubert|baseline)/i.test(combinedPrompt) ? "hubert" : "");
  const operation = {
    id: `ah-op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    estimatedDuration: estimateDurationLabel(plan.maxCombinations),
    name: `AH research ${plan.symbol} ${plan.timeframe} ${rangeLabel(plan.range)}`,
    params: {
      options: {
        ...planOptions,
        confirmLargeJob: plan.maxCombinations > 1000 || Boolean(options.confirmLargeJob),
        maxCombinations: plan.maxCombinations,
        workspaceContext,
      },
      prompt: combinedPrompt,
      workspaceContext,
    },
    plan,
    riskNotes: [
      "This queues analysis only. It cannot place trades.",
      "More combinations improve search coverage but do not guarantee the grid contains the best region.",
      ...(plan.maxCombinations > 1000 ? ["Large run: confirm that runtime cost is acceptable."] : []),
    ],
    summary: [
      `${plan.symbol} ${plan.timeframe}`,
      `${rangeLabel(plan.range)}`,
      `${plan.maxCombinations} combinations`,
      `${plan.provider}`,
      `fill ${plan.fillMode}`,
      `sizing ${plan.sizingMode}`,
      `method ${plan.methodology}`,
      baseline ? `baseline ${baseline}` : "no explicit baseline",
    ].join(" · "),
    type: "research-job",
  };
  return operation;
}

export function createAgentOrchestrator({ copilotMemory, store, tools }) {
  const runStore = createAgentRunStore({ store });
  const toolRegistry = createAgentToolRegistry({ tools });
  const executor = createAgentExecutor({ runStore, toolRegistry });
  const jobQueue = createAgentJobQueue({ executor, runStore });

  jobQueue.start().catch((error) => {
    console.warn(`[ai-agent] queue startup failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  async function startRun(body = {}) {
    const prompt = String(body.prompt ?? "").trim();
    if (!prompt) {
      return {
        ok: false,
        message: "Tell the agent what to analyze first.",
        statusCode: 400,
      };
    }

    const memory = copilotMemory?.summary?.() ?? null;
    const workspaceContext = body.workspaceContext ?? body.options?.workspaceContext ?? null;
    const plan = createAgentPlan({ options: body.options ?? {}, prompt });
    const safety = checkAgentPlanSafety(plan, body.options ?? {});

    if (!safety.ok) {
      return {
        ok: false,
        ...safety,
        plan,
        statusCode: safety.needsConfirmation ? 409 : 400,
      };
    }

    const run = await runStore.create({
      name: body.name ?? body.options?.operationName ?? "",
      plan,
      prompt,
      warnings: safety.warnings,
    });
    await runStore.update(run.id, {
      copilotMemory: memory,
      workspaceContext,
    });
    await copilotMemory?.rememberInteraction?.({
      message: prompt,
      response: { answer: "Research job queued." },
      run: { ...run, plan, prompt, status: "queued" },
      workspaceContext,
    });
    jobQueue.enqueue(run.id);

    return {
      ok: true,
      run: runStore.get(run.id) ? runStore.publicRun(runStore.get(run.id)) : run,
    };
  }

  async function cancelRun(id) {
    const run = await runStore.cancel(id);
    if (!run) {
      return {
        ok: false,
        message: "That agent run was not found.",
        statusCode: 404,
      };
    }

    return {
      ok: true,
      run,
    };
  }

  async function restartRun(id) {
    const run = runStore.get(id);
    if (!run) {
      return {
        ok: false,
        message: "That agent run was not found.",
        statusCode: 404,
      };
    }

    return startRun({
      options: {
        confirmLargeJob: true,
        fillMode: run.plan?.fillMode,
        maxCombinations: run.plan?.requestedCombinations ?? run.plan?.maxCombinations,
        objective: run.plan?.objective,
        provider: run.plan?.provider,
        sizingMode: run.plan?.sizingMode,
        startingBalance: run.plan?.startingBalance,
        timeframe: run.plan?.timeframe,
      },
      prompt: run.prompt,
    });
  }

  function exportRun(id, body = {}) {
    const run = runStore.get(id);
    if (!run) {
      return {
        ok: false,
        message: "That agent run was not found.",
        statusCode: 404,
      };
    }

    const format = body.format === "csv" ? "csv" : body.format === "json" ? "json" : "md";
    const rows = (run.resultSummary?.topRows ?? []).map((row, index) => normalizeResearchResult(row, {
      index,
      output: run.resultSummary,
      plan: run.plan,
      run,
    }));
    const exportIntegrity = run.resultSummary?.integrity ?? summarizeIntegrity(rows, run.resultSummary ?? {});
    if (rows.length || run.resultSummary) {
      if (format === "csv") {
        return {
          content: rowsToCsv(rows),
          fileName: "agent-ranking.csv",
          format,
          mime: "text/csv",
          ok: true,
        };
      }
      if (format === "json") {
        return {
          content: JSON.stringify({
            integrity: exportIntegrity,
            plan: run.plan,
            resultSummary: {
              ...run.resultSummary,
              best: rows[0] ?? run.resultSummary?.best ?? null,
              integrity: exportIntegrity,
              topRows: rows,
            },
            runId: run.id,
          }, null, 2),
          fileName: "agent-result.json",
          format,
          mime: "application/json",
          ok: true,
        };
      }
      return {
        content: composeAgentMarkdown({
          output: {
            ...run.resultSummary,
            integrity: exportIntegrity,
            processedCombinations: run.resultSummary?.executedCombinations,
            rankedResults: rows,
            summary: run.resultSummary?.message,
            testedCombinations: run.resultSummary?.executedCombinations,
            totalCombinations: run.resultSummary?.plannedCombinations,
          },
          plan: run.plan,
          run,
        }),
        fileName: "agent-report.md",
        format,
        mime: "text/markdown",
        ok: true,
      };
    }
    const artifact =
      (run.artifacts ?? []).find((item) => item.id === body.artifactId) ??
      (run.artifacts ?? []).find((item) => item.format === format) ??
      run.artifacts?.[0];

    if (!artifact) {
      return {
        ok: false,
        message: "No export artifact is available for this run yet.",
        statusCode: 400,
      };
    }

    return {
      content: artifact.content,
      fileName: artifact.fileName,
      format: artifact.format,
      mime: artifact.mime,
      ok: true,
    };
  }

  function rowsForRun(run) {
    return [
      ...(run.resultSummary?.topRows ?? []),
      ...(run.partialResults ?? []),
    ].filter(Boolean);
  }

  function resolveRow(run, body = {}) {
    const rows = rowsForRun(run);
    if (body.rowId) return rows.find((row) => row.id === body.rowId) ?? null;
    const index = Math.max(0, Number(body.rowIndex ?? body.configIndex ?? 0));
    return rows[index] ?? rows[0] ?? null;
  }

  function compactRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      canonical: row.canonical,
      dataCompleteness: row.dataCompleteness,
      integrity: row.integrity,
      metrics: row.metrics,
      params: row.params,
      provenance: row.provenance,
      rank: row.rank,
      research: row.research,
      score: row.score,
      symbol: row.symbol,
      timeframe: row.timeframe,
    };
  }

  function extractBaselineName(message = "") {
    const source = String(message);
    const patterns = [
      /\b(?:compare|porownaj|porównaj)\b.*?\b(?:with|to|z|do)\s+["“]?([a-z0-9][a-z0-9 _.-]{1,60})["”]?/i,
      /\b(?:compare|porownaj|porównaj)\s+(?:config\s*#?\s*\d+\s+)?(?:with|to|z|do)\s+["“]?([a-z0-9][a-z0-9 _.-]{1,60})["”]?/i,
      /\b(?:worse|better|gorszy|gorsze|lepszy|lepsze)\s+(?:than|niz|niż|od)\s+["“]?([a-z0-9][a-z0-9 _.-]{1,60})["”]?/i,
      /\b(?:baseline|baz[ae]|punkt odniesienia)\s*[:=]?\s*["“]?([a-z0-9][a-z0-9 _.-]{1,60})["”]?/i,
    ];
    for (const pattern of patterns) {
      const match = source.match(pattern);
      if (match?.[1]) {
        return match[1]
          .replace(/\b(?:and|oraz|i|please|prosze|proszę|why|czemu|dlaczego)\b.*$/i, "")
          .trim();
      }
    }
    return "";
  }

  function inferBaselineName(message = "", memory = null) {
    const explicit = extractBaselineName(message);
    if (explicit) return explicit;
    if (!/(baseline|hubert|porownaj|porównaj|compare|gorszy|worse|lepszy|better)/i.test(String(message))) return "";
    if (/hubert/i.test(String(message))) return "hubert";
    return memory?.baselines?.[0]?.name ?? "";
  }

  function comparableValue(value) {
    if (value === undefined || value === null || value === "") return null;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
    return String(value);
  }

  function metricComparison(aiRow = {}, baseline = {}) {
    const normalized = aiRow.canonical ? aiRow : normalizeResearchResult(aiRow);
    const metrics = baseline.metrics ?? {};
    const pairs = {
      maxDrawdown: [normalized.canonical?.metrics?.maxDrawdown, metrics.maxDrawdown],
      netProfit: [normalized.canonical?.metrics?.netPnl, metrics.netProfit],
      profitFactor: [normalized.canonical?.metrics?.profitFactor, metrics.profitFactor],
      trades: [normalized.canonical?.metrics?.trades, metrics.totalTrades],
      winRate: [normalized.canonical?.metrics?.winRate, metrics.winRate],
      expectancy: [normalized.canonical?.metrics?.expectancy, metrics.expectancy],
    };
    return Object.fromEntries(Object.entries(pairs).map(([key, [ai, saved]]) => [
      key,
      {
        ai: comparableValue(ai),
        delta: Number.isFinite(Number(ai)) && Number.isFinite(Number(saved)) ? Number((Number(ai) - Number(saved)).toFixed(8)) : null,
        match: Number.isFinite(Number(ai)) && Number.isFinite(Number(saved)) ? Math.abs(Number(ai) - Number(saved)) < 0.000001 : ai === saved,
        saved: comparableValue(saved),
      },
    ]));
  }

  function fieldComparison(aiValue, savedValue) {
    const left = comparableValue(aiValue);
    const right = comparableValue(savedValue);
    return {
      ai: left,
      match: left === right || (Number.isFinite(Number(left)) && Number.isFinite(Number(right)) && Math.abs(Number(left) - Number(right)) < 0.000001),
      saved: right,
    };
  }

  function explainBacktestDiff({ baseline, contextDiff, metricDiff, row }) {
    const blockers = Object.entries(contextDiff).filter(([, value]) => !value.match).map(([key]) => key);
    const aiNet = metricDiff.netProfit.ai;
    const savedNet = metricDiff.netProfit.saved;
    const aiPf = metricDiff.profitFactor.ai;
    const savedPf = metricDiff.profitFactor.saved;
    const verdict = blockers.length
      ? `This is not an exact apples-to-apples comparison because ${blockers.join(", ")} differ.`
      : "This is an apples-to-apples comparison by stored context fields.";
    const performance = Number(aiNet) < Number(savedNet)
      ? `The AI config is weaker on net PnL (${aiNet} vs ${savedNet}) and should admit that against this baseline.`
      : Number(aiNet) > Number(savedNet)
        ? `The AI config is stronger on net PnL (${aiNet} vs ${savedNet}), but PF/DD still need review.`
        : "Net PnL is equal or unavailable between the two records.";

    return [
      verdict,
      performance,
      `PF comparison: AI ${aiPf ?? "unavailable"} vs ${savedPf ?? "unavailable"}.`,
      row?.integrity?.warnings?.length ? `AI row integrity notes: ${row.integrity.warnings.slice(0, 3).join("; ")}` : "",
      baseline.dataCompleteness?.missing?.length ? `Saved backtest is missing: ${baseline.dataCompleteness.missing.join(", ")}.` : "",
    ].filter(Boolean).join(" ");
  }

  function verifiedFrom(run, row) {
    if (!row) {
      return {
        missing: ["No ranked config row was selected for this answer."],
        runId: run?.id ?? null,
        verified: false,
      };
    }

    const normalized = row.canonical ? row : normalizeResearchResult(row, { run, plan: run?.plan });
    return {
      drawdown: normalized.canonical?.metrics?.maxDrawdown ?? null,
      fillMode: normalized.canonical?.fillMode ?? "legacy",
      integrityScore: normalized.integrity?.score ?? null,
      integrityStatus: normalized.integrity?.status ?? "unknown",
      integrityWarnings: normalized.integrity?.warnings ?? [],
      net: normalized.canonical?.metrics?.netPnl ?? null,
      provider: normalized.canonical?.provider ?? "binance-futures",
      rank: normalized.rank ?? null,
      range: normalized.canonical?.range ?? { from: null, to: null },
      runId: run?.id ?? null,
      sizingMode: normalized.canonical?.sizingMode ?? "position-percent",
      symbol: normalized.canonical?.symbol ?? "SOLUSDT",
      timeframe: normalized.canonical?.timeframe ?? null,
      trades: normalized.canonical?.metrics?.trades ?? null,
      profitFactor: normalized.canonical?.metrics?.profitFactor ?? null,
      verified: true,
    };
  }

  function memorySnapshot() {
    const memory = process.memoryUsage();
    return {
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      rssMb: Math.round(memory.rss / 1024 / 1024),
    };
  }

  async function rerunExact(id, body = {}) {
    const run = runStore.get(id);
    if (!run) {
      return { ok: false, message: "That agent run was not found.", statusCode: 404 };
    }
    const row = resolveRow(run, body);
    if (!row?.params) {
      return { ok: false, message: "This run does not include an exact parameter row to re-run.", statusCode: 400 };
    }
    const sizingMode = row.params.sizingMode ?? run.plan.sizingMode ?? "position-percent";
    const result = await toolRegistry.runBacktest(run.plan, {
      ...row.params,
      fillMode: body.fillMode ?? row.params.fillMode ?? run.plan.fillMode ?? "legacy",
      positionPercent: sizingMode === "position-percent" ? row.params.sizingValue : undefined,
      riskPercent: sizingMode === "fixed-risk" ? row.params.sizingValue : undefined,
      sizingMode,
      timeframe: body.timeframe ?? row.timeframe ?? run.plan.timeframe,
    });
    const normalizedAiRow = normalizeResearchResult(row, { run, plan: run.plan });
    const normalizedRerunRow = normalizeResearchResult({
      candlesUsed: result.candlesUsed,
      fillMode: result.fillMode,
      metrics: result.metrics ?? {},
      params: row.params,
      provenance: result.provenance,
      rank: row.rank,
      symbol: result.symbol,
      timeframe: result.timeframe,
    }, { run, plan: run.plan });
    const metricDiff = {
      ...diffMetrics(normalizedAiRow, normalizedRerunRow),
      aiNetProfit: normalizedAiRow.canonical.metrics.netPnl,
      aiProfitFactor: normalizedAiRow.canonical.metrics.profitFactor,
      aiTrades: normalizedAiRow.canonical.metrics.trades,
      rerunNetProfit: normalizedRerunRow.canonical.metrics.netPnl,
      rerunProfitFactor: normalizedRerunRow.canonical.metrics.profitFactor,
      rerunTrades: normalizedRerunRow.canonical.metrics.trades,
      sameCandles: Number(row.candlesUsed ?? 0) === Number(result.candlesUsed ?? 0),
      sameFillMode: (row.params?.fillMode ?? run.plan.fillMode ?? "legacy") === (result.fillMode ?? "legacy"),
      sameSizingMode: (row.params?.sizingMode ?? run.plan.sizingMode ?? "position-percent") === (result.provenance?.sizingMode ?? run.plan.sizingMode ?? "position-percent"),
    };
    const diffValues = Object.values(metricDiff).filter((item) => item && typeof item === "object" && "match" in item);
    const parityPassed = diffValues.length > 0 && diffValues.every((item) => item.match) && metricDiff.sameCandles && metricDiff.sameFillMode && metricDiff.sameSizingMode;
    const integrityPassed = parityPassed && normalizedAiRow.canonical.status === "complete" && normalizedRerunRow.canonical.status === "complete";
    const integrityWarnings = [
      ...(parityPassed ? [] : ["AI result and exact rerun are not fully identical."]),
      ...(normalizedAiRow.integrity?.warnings ?? []).map((warning) => `AI row: ${warning}`),
      ...(normalizedRerunRow.integrity?.warnings ?? []).map((warning) => `Rerun: ${warning}`),
    ];

    return {
      cacheHit: Boolean(result.cacheHit),
      exactConfig: row.params,
      integrity: {
        ai: normalizedAiRow.integrity,
        metricDiff,
        passed: integrityPassed,
        parityPassed,
        rerun: normalizedRerunRow.integrity,
        warnings: [...new Set(integrityWarnings)],
      },
      metricDiff,
      ok: true,
      provenance: result.provenance,
      result,
      row: normalizedAiRow,
      rerunRow: normalizedRerunRow,
    };
  }

  async function compareAgentResultToBacktest(id, body = {}) {
    const run = runStore.get(id);
    if (!run) {
      return { ok: false, message: "That agent run was not found.", statusCode: 404 };
    }
    const row = resolveRow(run, body);
    if (!row) {
      return { ok: false, message: "Choose an AI result row to compare first.", statusCode: 400 };
    }
    const backtestNameOrId = String(body.backtestNameOrId ?? body.query ?? "").trim();
    if (!backtestNameOrId) {
      return { ok: false, message: "Enter a saved backtest name or id, for example hubert.", statusCode: 400 };
    }
    if (typeof toolRegistry.getBacktestDetail !== "function") {
      return { ok: false, message: "Saved backtest detail tool is not available.", statusCode: 500 };
    }

    const baseline = await toolRegistry.getBacktestDetail(backtestNameOrId, { tradeLimit: body.tradeLimit ?? 500 });
    if (!baseline?.ok) {
      return { ok: false, message: baseline?.message ?? "Saved backtest could not be resolved.", resolution: baseline, statusCode: 404 };
    }

    const normalizedRow = normalizeResearchResult(row, {
      output: run.resultSummary ?? {},
      plan: run.plan,
      run,
    });
    const contextDiff = {
      atrLength: fieldComparison(normalizedRow.params?.atrLength, baseline.strategyParams?.atrLength),
      atrMultiplier: fieldComparison(normalizedRow.params?.atrMultiplier, baseline.strategyParams?.atrMultiplier),
      bandwidth: fieldComparison(normalizedRow.params?.bandwidth, baseline.strategyParams?.bandwidth),
      candlesUsed: fieldComparison(normalizedRow.canonical?.candlesUsed, baseline.provenance?.candlesUsed),
      envelopeMultiplier: fieldComparison(normalizedRow.params?.envelopeMultiplier, baseline.strategyParams?.envelopeMultiplier),
      fillMode: fieldComparison(normalizedRow.canonical?.fillMode, baseline.fillMode),
      maxSameSideFailures: fieldComparison(normalizedRow.params?.maxSameSideFailures, baseline.strategyParams?.maxSameSideFailures),
      provider: fieldComparison(normalizedRow.canonical?.provider, baseline.provenance?.provider),
      rangeFrom: fieldComparison(normalizedRow.canonical?.range?.from, baseline.range?.from),
      rangeTo: fieldComparison(normalizedRow.canonical?.range?.to, baseline.range?.to),
      sizingMode: fieldComparison(normalizedRow.canonical?.sizingMode, baseline.sizingMode),
      timeframe: fieldComparison(normalizedRow.canonical?.timeframe, baseline.timeframe),
    };
    const metricDiff = metricComparison(normalizedRow, baseline);
    const allContextMatch = Object.values(contextDiff).every((item) => item.match);
    const allMetricMatch = Object.values(metricDiff).every((item) => item.match || item.ai === null || item.saved === null);

    return {
      baseline,
      contextDiff,
      explanation: explainBacktestDiff({ baseline, contextDiff, metricDiff, row: normalizedRow }),
      metricDiff,
      ok: true,
      parity: {
        allContextMatch,
        allMetricMatch,
        exactExperiment: allContextMatch,
        warnings: [
          ...(!allContextMatch ? ["Context differs. Do not treat metrics as exact parity."] : []),
          ...(!allMetricMatch ? ["Metrics differ between AI row and saved backtest."] : []),
          ...(baseline.dataCompleteness?.missing?.length ? [`Saved baseline missing ${baseline.dataCompleteness.missing.join(", ")}.`] : []),
        ],
      },
      row: compactRow(normalizedRow),
      runId: run.id,
      savedBacktestNameOrId: backtestNameOrId,
    };
  }

  async function chat(body = {}) {
    const message = String(body.message ?? "").trim();
    if (!message) {
      return { ok: false, message: "Ask a follow-up first.", statusCode: 400 };
    }
    const mode = String(body.mode ?? body.copilotMode ?? "research").toLowerCase();
    const run = body.runId ? runStore.get(body.runId) : runStore.list().find((item) => item.status === "completed");
    const memory = copilotMemory?.summary?.() ?? null;
    const workspaceContext = body.workspaceContext ?? null;
    const liveIntent = detectLiveExecutionIntent(message);
    const inferredIntent = inferCopilotIntent(message, mode);
    const updatedResearchIntent = isResearchPlanningMessage(message)
      ? updateResearchIntent({
        message,
        previous: memory?.researchIntent,
        workspaceContext,
      })
      : memory?.researchIntent ?? null;
    const effectiveMemory = updatedResearchIntent
      ? { ...(memory ?? {}), researchIntent: updatedResearchIntent }
      : memory;

    if (liveIntent) {
      const freshState = typeof tools.getCurrentManualPositionState === "function"
        ? await tools.getCurrentManualPositionState({ fresh: true, workspaceContext }).catch(() => null)
        : null;
      const position =
        compactPositionForAnswer(workspaceContext?.live?.positions?.[0]) ??
        compactPositionForAnswer(freshState?.positions?.[0]) ??
        null;
      const polish = isPolishQuestion(message) || /[ąćęłńóśźż]/i.test(message);
      const positionText = position?.symbol
        ? `${position.symbol} ${position.positionSide ?? ""}${position.quantity ? ` qty ${position.quantity}` : ""}${position.positionId ? ` positionId ${position.positionId}` : ""}`
        : null;
      const targetText = liveIntent.price ? ` ${liveIntent.price}` : "";
      const answer = polish
        ? [
            `Rozpoznałem to jako komendę live execution: ${liveIntent.label}${targetText}.`,
            "Nie mogę samodzielnie wykonać tej akcji z czatu bez potwierdzenia.",
            positionText ? `Aktualnie wykryta pozycja: ${positionText}.` : "Nie widzę pewnej aktywnej pozycji w kontekście czatu.",
            "Ta funkcja nie jest jeszcze podłączona do czatu jako bezpieczny pending action.",
            liveIntent.action === "MOVE_SL"
              ? "Użyj panelu Crisis i przycisku Move SL bezpośrednio w karcie pozycji. Tam payload bierze positionId, positionSide, quantity i profil z tej konkretnej karty."
              : "Użyj panelu Crisis i przycisku tej akcji bezpośrednio w karcie pozycji.",
          ].join(" ")
        : [
            `I recognized this as a live execution command: ${liveIntent.label}${targetText}.`,
            "I cannot execute it from chat without explicit confirmation.",
            positionText ? `Current detected position: ${positionText}.` : "I cannot see a certain active position in chat context.",
            "This chat-to-pending-action flow is not wired yet.",
            "Use the Crisis panel position-card button for this exact position.",
          ].join(" ");
      const response = {
        answer,
        confidence: {
          label: position ? "high" : "medium",
          reason: "Live command was intercepted before research-result reasoning.",
          score: position ? 86 : 62,
        },
        evidence: [
          "Detected live execution intent before research reasoning.",
          positionText ? `Detected position: ${positionText}` : "No active position was available in workspace context.",
          "AI chat is analysis-only and cannot place orders or modify SL/TP automatically.",
        ],
        intent: "unsafe-live-action",
        nextAction: "Open Crisis and use the position-card control with explicit confirmation.",
        recommendation: "Use direct position-card controls; do not trust chat as an execution surface yet.",
        risk: {
          label: "high",
          reasons: ["Live exchange action requires explicit UI confirmation.", "Chat pending-action execution is not implemented."],
        },
        sections: [
          {
            title: polish ? "Co zrobić teraz" : "What to do now",
            bullets: polish
              ? ["Otwórz Crisis.", "Znajdź kartę pozycji SOLUSDT LONG/SHORT.", "Wpisz cenę w polu SL/TP.", "Kliknij Move SL/Move TP na tej samej karcie pozycji."]
              : ["Open Crisis.", "Find the SOLUSDT LONG/SHORT position card.", "Type the SL/TP price.", "Click Move SL/Move TP on that same position card."],
          },
        ],
        verifiedFrom: position
          ? {
              fillMode: null,
              provider: "BingX live state",
              runId: null,
              symbol: position.symbol,
              timeframe: null,
              trades: null,
              verified: true,
            }
          : null,
      };

      if (run) {
        await runStore.update(run.id, {
          messages: [
            ...(run.messages ?? []),
            { role: "user", text: message, time: new Date().toISOString() },
            {
              evidence: response.evidence,
              confidence: response.confidence,
              role: "assistant",
              sections: response.sections,
              text: response.answer,
              time: new Date().toISOString(),
            },
          ].slice(-40),
        });
      }
      await copilotMemory?.rememberInteraction?.({ message, response, run, workspaceContext });

      return { ok: true, response };
    }

    if (inferredIntent === "research-request") {
      const polish = isPolishQuestion(message) || /[ąćęłńóśźż]/i.test(message);
      if (updatedResearchIntent) {
        await copilotMemory?.rememberResearchIntent?.(updatedResearchIntent);
      }
      if (isResearchMethodQuestion(message)) {
        const response = {
          answer: polish
            ? "Pracuję teraz głównie jak kontrolowany research runner: biorę zakres, symbol, timeframe i parametry, buduję siatkę kombinacji, uruchamiam istniejący backtest dla każdej kombinacji, a potem sortuję wyniki przez score uwzględniający profit, drawdown, trade count i stabilność. To nie jest jeszcze inteligentne zawężanie zakresów w stylu Bayesian optimization. Jeśli mam baseline, np. hubert, mogę używać go jako punktu odniesienia i porównywać wyniki. Ograniczenie jest takie, że obecnie najpierw testuję przygotowaną siatkę, a dopiero potem oceniam, co wygląda stabilnie. Mądrzejszy tryb wymagałby iteracyjnego procesu: najpierw szeroki sweep, potem wykrycie obiecującego klastra, potem sąsiednie parametry, walidacja miesięczna, Legacy vs Conservative i dopiero rekomendacja."
            : "Right now I work mostly as a controlled research runner: I take range, symbol, timeframe, and parameters, build a parameter grid, run the existing backtest for each combination, then rank results with a score that considers profit, drawdown, trade count, and stability. This is not yet Bayesian or fully adaptive range narrowing. With a baseline such as hubert, I can use it as a comparison point. The current limitation is that I test a prepared grid first and interpret stability afterward. Smarter iterative search would need broad exploration, cluster detection, neighboring-parameter validation, monthly checks, Legacy vs Conservative checks, and only then a recommendation.",
          confidence: { label: "high", reason: "Answer describes current AH research architecture and its limitations.", score: 88 },
          evidence: [
            "AH uses existing sweep/backtest tools, not a separate strategy engine.",
            "Current search is grid/batched execution first, interpretation second.",
            "Baseline comparison and robustness checks exist, but adaptive optimization is still limited.",
          ],
          intent: "chat-explanation",
          nextAction: polish ? "Jeśli chcesz, poproś AH o przygotowanie 500 albo 1000 kombinacji dla konkretnego zakresu." : "Ask AH to prepare 500 or 1000 combinations for a concrete range if you want to proceed.",
          recommendation: polish ? "Najbardziej sensowny praktyczny flow: 500 szeroko, potem 1000 wokół najlepszych regionów." : "Practical flow: 500 broad tests first, then 1000 around the best regions.",
          risk: { label: "low", reasons: ["Explanation only; no job was queued."] },
          sections: [
            {
              title: polish ? "Co wymaga ulepszenia" : "What would make it smarter",
              bullets: polish
                ? ["automatyczne zawężanie zakresów", "test sąsiednich parametrów", "walidacja miesięczna/kwartalna", "porównanie Legacy vs Conservative", "odrzucanie konfiguracji z małą próbką"]
                : ["adaptive range narrowing", "neighboring-parameter tests", "monthly/quarterly validation", "Legacy vs Conservative comparison", "rejecting low-sample configs"],
            },
          ],
        };
        await copilotMemory?.rememberInteraction?.({ message, response, run, workspaceContext });
        return { ok: true, response };
      }
      if (isCombinationAdviceQuestion(message)) {
        const response = {
          answer: polish
            ? "Dla jednego symbolu i jednego interwału wybrałbym 500 jako rozsądny pierwszy research. 50-100 to tylko szybki smoke test. 200 daje lekki obraz, ale może ominąć dobre okolice parametrów. 500 zwykle jest sensownym kompromisem. 1000 ma więcej sensu, jeśli szukasz poważnego kandydata do walidacji i możesz poczekać dłużej. 2000+ zostawiłbym dopiero na deep run po znalezieniu obiecującego regionu."
            : "For one symbol and one timeframe, I would start with 500 combinations. 50-100 is only a smoke test. 200 is lightweight exploration. 500 is the best first-pass compromise. 1000 is better when you want a serious validation candidate and can wait longer. 2000+ should come after a promising region is found.",
          confidence: { label: "high", reason: "General AH research planning guidance.", score: 86 },
          evidence: [
            "50-100: smoke/quick check.",
            "200: lightweight exploration.",
            "500: solid first research pass.",
            "1000: stronger search and better confidence.",
            "2000+: deep run after narrowing the search space.",
          ],
          intent: inferredIntent,
          nextAction: polish ? "Powiedz „zrób 500” albo „zrób 1000”, a AH przygotuje kartę potwierdzenia." : "Say “run 500” or “run 1000” and AH will prepare a confirmation card.",
          recommendation: polish ? "Na start: 500. Dla poważniejszego kandydata: 1000." : "Start with 500. Use 1000 for a more serious candidate.",
          risk: { label: "low", reasons: ["Planning only; no job has been queued."] },
        };
        await copilotMemory?.rememberInteraction?.({ message, response, run, workspaceContext });
        return { ok: true, response };
      }
      const pendingOperation = buildPendingResearchOperation({
        memory: effectiveMemory,
        message,
        options: body.options ?? {},
        researchIntent: updatedResearchIntent,
        workspaceContext,
      });
      const shouldPrepare = pendingOperation.plan.requestedCombinationsExplicit ||
        isResearchConfirmationMessage(message) ||
        (Boolean(updatedResearchIntent?.combinations) && isResearchContinuationCommand(message));
      const clarification = clarificationForIntent(updatedResearchIntent ?? pendingOperation.plan.researchIntent, { polish });
      if (clarification) {
        const response = {
          answer: [
            polish ? "Zapisałem dotychczasowe założenia badania." : "I saved the current research assumptions.",
            updatedResearchIntent?.symbol && updatedResearchIntent?.timeframe
              ? (polish
                  ? `Na razie używam ${updatedResearchIntent.symbol} ${updatedResearchIntent.timeframe}.`
                  : `For now I am using ${updatedResearchIntent.symbol} ${updatedResearchIntent.timeframe}.`)
              : "",
            updatedResearchIntent?.baselineQuery
              ? (polish
                  ? `Baseline: ${updatedResearchIntent.baselineQuery}.`
                  : `Baseline: ${updatedResearchIntent.baselineQuery}.`)
              : "",
            clarification,
          ].filter(Boolean).join(" "),
          confidence: { label: "high", reason: "AH extracted a research intent but needs one missing execution detail before creating a pending job.", score: 82 },
          evidence: [
            `Intent objective: ${updatedResearchIntent?.objective ?? "unknown"}`,
            `Range: ${updatedResearchIntent?.range?.from ?? "missing"} to ${updatedResearchIntent?.range?.to ?? "missing"}`,
            `Constraints: ${JSON.stringify(updatedResearchIntent?.constraints ?? {})}`,
            `Parameter ranges: ${JSON.stringify(updatedResearchIntent?.parameterRanges ?? {})}`,
          ],
          intent: "research-planning",
          nextAction: clarification,
          recommendation: polish ? "Doprecyzuj tylko brakujący element; resztę zachowuję w planie rozmowy." : "Clarify only the missing item; I am keeping the rest in the conversation plan.",
          risk: { label: "low", reasons: ["No job was queued."] },
          sections: [
            {
              title: polish ? "Wyłapany plan" : "Extracted plan",
              bullets: [
                `Symbol/timeframe: ${updatedResearchIntent?.symbol ?? "--"} ${updatedResearchIntent?.timeframe ?? "--"}`,
                `Range: ${updatedResearchIntent?.range?.label ?? "--"}`,
                `Baseline: ${updatedResearchIntent?.baselineQuery || "none"}`,
                `Methodology: ${updatedResearchIntent?.methodology ?? "--"}`,
              ],
            },
          ],
        };
        await copilotMemory?.rememberInteraction?.({ message, response, run, workspaceContext });
        return { ok: true, response };
      }
      if (shouldPrepare) {
        const response = {
          answer: polish
            ? [
            "OK. Przygotowałem zadanie badawcze, ale go jeszcze nie uruchamiam.",
                `Cel: ${pendingOperation.plan.objective}.`,
                `Zakres: ${rangeLabel(pendingOperation.plan.range)}.`,
                `Rynek: ${pendingOperation.plan.symbol} ${pendingOperation.plan.timeframe}.`,
                `Kombinacje: ${pendingOperation.plan.maxCombinations}.`,
                `Metoda: ${pendingOperation.plan.methodology}.`,
                pendingOperation.plan.baselineQuery ? `Użyję zapisanego backtestu „${pendingOperation.plan.baselineQuery}” jako baseline.` : "Nie widzę jawnego baseline; możesz dopisać hubert, jeśli ma być punktem odniesienia.",
                pendingOperation.plan.constraints?.minProfitFactor ? `Filtr: PF minimum ${pendingOperation.plan.constraints.minProfitFactor}.` : "",
                pendingOperation.plan.constraints?.maxDrawdown ? `Filtr: DD max ${pendingOperation.plan.constraints.maxDrawdown}.` : "",
                pendingOperation.plan.constraints?.minTrades ? `Filtr: minimum ${pendingOperation.plan.constraints.minTrades} transakcji.` : "",
                "Nadaj nazwę badania i kliknij Zatwierdź, jeśli mam je wrzucić do kolejki.",
              ].join(" ")
            : [
                "OK. I prepared a research job, but I have not started it yet.",
                `Objective: ${pendingOperation.plan.objective}.`,
                `Range: ${rangeLabel(pendingOperation.plan.range)}.`,
                `Market: ${pendingOperation.plan.symbol} ${pendingOperation.plan.timeframe}.`,
                `Combinations: ${pendingOperation.plan.maxCombinations}.`,
                `Method: ${pendingOperation.plan.methodology}.`,
                pendingOperation.plan.baselineQuery ? `I will use saved backtest “${pendingOperation.plan.baselineQuery}” as baseline.` : "No explicit baseline was found; add hubert if it should be used.",
                "Name it and confirm if you want me to queue it.",
              ].join(" "),
          confidence: { label: "high", reason: "AH prepared a pending research operation instead of launching a job silently.", score: 88 },
          evidence: [
            `Symbol: ${pendingOperation.plan.symbol}`,
            `Timeframe: ${pendingOperation.plan.timeframe}`,
            `Range: ${rangeLabel(pendingOperation.plan.range)}`,
            `Combinations: requested ${pendingOperation.plan.requestedCombinations}, planned ${pendingOperation.plan.plannedCombinations}`,
            `Provider: ${pendingOperation.plan.provider}`,
            `Methodology: ${pendingOperation.plan.methodology}`,
            `Constraints: ${JSON.stringify(pendingOperation.plan.constraints ?? {})}`,
            `Parameter ranges: ${JSON.stringify(pendingOperation.plan.parameters ?? {})}`,
          ],
          intent: "research-confirmation",
          nextAction: polish ? "Sprawdź kartę pending operation i kliknij Zatwierdź." : "Review the pending operation card and click Confirm.",
          pendingOperation,
          recommendation: polish ? "Najpierw potwierdź zakres i liczbę kombinacji." : "Confirm the range and combination count first.",
          risk: { label: pendingOperation.plan.maxCombinations > 1000 ? "moderate" : "low", reasons: pendingOperation.riskNotes },
        };
        await copilotMemory?.rememberInteraction?.({ message, response, run, workspaceContext });
        return { ok: true, response };
      }
      const response = {
        answer: polish
          ? "Mogę to zrobić. Najpierw wybierzmy rozmiar badania: 50-100 to szybki smoke test, 200 lekka eksploracja, 500 rozsądny pierwszy research, 1000 mocniejszy search do poważniejszej walidacji. Dla jednego symbolu i interwału polecam 500 na start albo 1000, jeśli chcesz mocniejszy kandydat i możesz poczekać."
          : "I can do that. First choose the research size: 50-100 is a smoke test, 200 is lightweight exploration, 500 is a solid first research pass, and 1000 is a stronger search for a serious validation candidate. For one symbol/timeframe, I recommend 500 first or 1000 if you can wait longer.",
        confidence: { label: "high", reason: "Research-run intent detected before result reasoning.", score: 84 },
        evidence: ["Detected research/backtest/sweep planning intent.", "No job has been queued because AH requires confirmation first."],
        intent: inferredIntent,
        nextAction: polish ? "Napisz „zrób 500” albo „zrób 1000”, a AH przygotuje kartę potwierdzenia." : "Say “run 500” or “run 1000” and AH will prepare a confirmation card.",
        recommendation: polish ? "Dla pierwszego przejścia: 500. Dla mocniejszego kandydata: 1000." : "First pass: 500. Stronger candidate search: 1000.",
        risk: { label: "moderate", reasons: ["Large jobs should be explicit and cancellable."] },
        sections: [
          {
            title: polish ? "Co doprecyzować" : "What to clarify",
            bullets: polish
              ? ["symbol", "timeframe", "zakres dat", "fill mode", "sizing mode", "liczba kombinacji"]
              : ["symbol", "timeframe", "date range", "fill mode", "sizing mode", "combination count"],
          },
        ],
      };
      await copilotMemory?.rememberInteraction?.({ message, response, run, workspaceContext });
      return { ok: true, response };
    }

    const wantsPlatformEvidence = (
      inferredIntent !== "current-research-result" ||
      mode === "platform-diagnosis" ||
      mode === "code-evidence" ||
      mode === "platform" ||
      body.evidenceMode === true
    );

    if (wantsPlatformEvidence && typeof tools.answerFromPlatformEvidence === "function") {
      const platformEvidence = await tools.answerFromPlatformEvidence({
        mode: inferredIntent === "code-platform-diagnosis" ? "code-evidence" : inferredIntent,
        question: message,
        runId: run?.id ?? null,
        workspaceContext,
      });
      const confidenceLabel = platformEvidence.confidence ?? "medium";
      const response = {
        answer: platformEvidence.answer,
        confidence: {
          label: confidenceLabel,
          reason: "Answer generated from backend code/runtime evidence tools.",
          score: confidenceLabel === "high" ? 82 : confidenceLabel === "medium" ? 62 : 38,
        },
        evidence: [
          ...(platformEvidence.inspected ?? []).map((item) => `Inspected: ${item}`),
          ...(platformEvidence.evidence ?? []),
        ].slice(0, 36),
        intent: inferredIntent,
        nextAction: platformEvidence.suggestedVerification?.[0] ?? "Verify the traced path in the relevant platform panel.",
        recommendation: "Use this as read-only platform diagnosis. AI cannot place orders or modify execution.",
        risk: {
          label: platformEvidence.confidence === "high" ? "low" : "moderate",
          reasons: platformEvidence.unknown ?? [],
        },
        sections: [
          {
            title: "Files/functions/routes inspected",
            bullets: platformEvidence.inspected ?? [],
          },
          {
            title: "What is unknown",
            bullets: platformEvidence.unknown ?? [],
          },
          {
            title: "Suggested verification",
            bullets: platformEvidence.suggestedVerification ?? [],
          },
        ],
        platformEvidence,
        memory,
        runId: run?.id ?? null,
      };

      if (run) {
        await runStore.update(run.id, {
          messages: [
            ...(run.messages ?? []),
            {
              role: "user",
              text: message,
              time: new Date().toISOString(),
            },
            {
              evidence: response.evidence,
              confidence: response.confidence,
              role: "assistant",
              sections: response.sections,
              text: response.answer,
              time: new Date().toISOString(),
              platformEvidence,
            },
          ].slice(-40),
        });
      }
      await copilotMemory?.rememberInteraction?.({
        message,
        response,
        run,
        workspaceContext,
      });

      return {
        ok: true,
        response,
      };
    }

    if (!run) {
      return {
        ok: true,
        response: {
          answer: "I do not have a completed run to reference yet. Start a research or sweep run first.",
          evidence: [],
          intent: inferredIntent,
          nextAction: "Run a small research prompt, then ask a follow-up about the result.",
        },
      };
    }
    const rows = rowsForRun(run);
    const configMatch = message.match(/config\s*#?\s*(\d+)/i);
    const rowIndex = configMatch ? Math.max(0, Number(configMatch[1]) - 1) : 0;
    const explicitRow = body.rowId || body.rowIndex !== undefined || body.configIndex !== undefined
      ? resolveRow(run, body)
      : null;
    const row = explicitRow ?? rows[rowIndex] ?? rows[0];
    const normalizedRows = rows.map((item, index) => normalizeResearchResult(item, {
      index,
      output: run.resultSummary ?? {},
      plan: run.plan,
      run,
    }));
    const normalizedRow = row
      ? normalizeResearchResult(row, {
        index: rowIndex,
        output: run.resultSummary ?? {},
        plan: run.plan,
        run,
      })
      : null;
    const reasoning = buildReasoningResponse({ question: message, row: normalizedRow, rows: normalizedRows, run });
    const baselineName = inferBaselineName(message, memory);
    const baselineComparison = baselineName
      ? await compareAgentResultToBacktest(run.id, { backtestNameOrId: baselineName, rowId: row?.id, rowIndex })
      : null;
    const evidence = [
      `Run: ${run.id}`,
      `Intent: ${run.parsedIntent}`,
      `Range: ${run.plan?.range?.from} to ${run.plan?.range?.to}`,
      `Provider: ${run.plan?.provider}`,
      ...(memory?.preferences?.metrics?.length ? [`Remembered preferred metrics: ${memory.preferences.metrics.join(", ")}`] : []),
      ...(memory?.baselines?.length ? [`Remembered baseline: ${memory.baselines[0].name}`] : []),
      normalizedRow ? `Selected row: rank ${normalizedRow.rank ?? rowIndex + 1}` : "No ranked row available.",
      ...(baselineComparison?.ok ? [
        `Compared with saved backtest: ${baselineComparison.baseline?.name}`,
        `Baseline PF: ${baselineComparison.metricDiff?.profitFactor?.saved}`,
        `AI PF: ${baselineComparison.metricDiff?.profitFactor?.ai}`,
      ] : baselineComparison ? [`Baseline comparison failed: ${baselineComparison.message}`] : []),
      ...(reasoning.evidence ?? []),
    ];
    const polish = isPolishQuestion(message);
    const asksPolishDeepAnalysis = polish && /(pelna analiz|pełna analiz|pokaz|pokaż)/i.test(message);
    const answer = baselineComparison?.ok
      ? polish
        ? [
            `Porównałem wybrany wynik AI z zapisanym backtestem „${baselineComparison.baseline?.name}”.`,
            `AI: net ${baselineComparison.metricDiff?.netProfit?.ai ?? "n/a"}, PF ${baselineComparison.metricDiff?.profitFactor?.ai ?? "n/a"}, trades ${baselineComparison.metricDiff?.trades?.ai ?? "n/a"}.`,
            `Hubert: net ${baselineComparison.metricDiff?.netProfit?.saved ?? "n/a"}, PF ${baselineComparison.metricDiff?.profitFactor?.saved ?? "n/a"}, trades ${baselineComparison.metricDiff?.trades?.saved ?? "n/a"}.`,
            baselineComparison.parity?.allContextMatch
              ? "Kontekst testu wygląda zgodnie, więc metryki można porównać bezpośrednio."
              : "Kontekst nie jest identyczny, więc nie wolno traktować różnicy metryk jako czystej przewagi jednej konfiguracji.",
            (() => {
              const different = Object.entries(baselineComparison.contextDiff ?? {})
                .filter(([, value]) => value && value.match === false)
                .map(([key]) => key)
                .slice(0, 8);
              return different.length ? `Różnice kontekstu: ${different.join(", ")}.` : "";
            })(),
            Number(baselineComparison.metricDiff?.netProfit?.ai ?? 0) < Number(baselineComparison.metricDiff?.netProfit?.saved ?? 0)
              ? "Wynik AI jest słabszy od hubert pod względem net PnL i musi to jasno przyznać."
              : "Wynik AI ma wyższy net PnL niż hubert w zapisanych metrykach, ale nadal trzeba sprawdzić zgodność kontekstu.",
            `PF: AI ${baselineComparison.metricDiff?.profitFactor?.ai ?? "n/a"} vs hubert ${baselineComparison.metricDiff?.profitFactor?.saved ?? "n/a"}.`,
            baselineComparison.parity?.warnings?.length ? `Ostrzeżenia: ${baselineComparison.parity.warnings.join(" ")}` : "",
          ].join(" ")
        : `${baselineComparison.explanation} ${reasoning.answer ?? ""}`.trim()
      : asksPolishDeepAnalysis && normalizedRow
        ? [
            `Pełna analiza aktualnego wyniku: konfiguracja ma net ${normalizedRow.canonical?.metrics?.netPnl ?? "n/a"} USDT, PF ${normalizedRow.canonical?.metrics?.profitFactor ?? "n/a"}, drawdown ${normalizedRow.canonical?.metrics?.maxDrawdown ?? "n/a"} i ${normalizedRow.canonical?.metrics?.trades ?? "n/a"} transakcji.`,
            `Zakres: ${normalizedRow.canonical?.range?.from ?? run.plan?.range?.from} → ${normalizedRow.canonical?.range?.to ?? run.plan?.range?.to}, ${normalizedRow.canonical?.symbol ?? run.plan?.symbol} ${normalizedRow.canonical?.timeframe ?? run.plan?.timeframe}.`,
            `Wniosek: to nadal kandydat badawczy, nie gotowy sygnał do live. Najważniejsze ryzyko to jakość próbki i zgodność kontekstu z baseline.`,
            `Co sprawdzić dalej: Conservative fill, porównanie z hubert, test miesięczny/kwartalny oraz sąsiednie parametry wokół tej konfiguracji.`,
          ].join(" ")
      : reasoning.answer ?? run.resultSummary?.message ?? "This run completed, but no compact summary is available.";
    const responseRow = compactRow(reasoning.row ?? normalizedRow);
    const responseVerifiedFrom = verifiedFrom(run, reasoning.row ?? normalizedRow);
    if (baselineComparison?.ok) {
      await copilotMemory?.rememberBaseline?.({
        id: baselineComparison.baseline?.id,
        name: baselineComparison.baseline?.name ?? baselineName,
        source: "saved-backtest",
        summary: baselineComparison.explanation,
      });
    }

    const nextMessages = [
      ...(run.messages ?? []),
      {
        context: {
          rowId: row?.id ?? null,
          rowRank: normalizedRow?.rank ?? null,
          workspaceContext,
        },
        role: "user",
        text: message,
        time: new Date().toISOString(),
      },
      {
        evidence,
        confidence: reasoning.confidence,
        critique: reasoning.critique,
        risk: reasoning.risk,
        role: "assistant",
        sections: reasoning.sections,
        text: answer,
        time: new Date().toISOString(),
        baselineComparison: baselineComparison?.ok ? baselineComparison : null,
        row: responseRow,
        verifiedFrom: responseVerifiedFrom,
        memory,
      },
    ].slice(-40);
    await runStore.update(run.id, { messages: nextMessages });
    await copilotMemory?.rememberInteraction?.({
      message,
      response: {
        answer,
        runId: run.id,
      },
      row: reasoning.row ?? normalizedRow,
      run,
      workspaceContext,
    });

    return {
      ok: true,
      response: {
        answer,
        confidence: reasoning.confidence,
        critique: reasoning.critique,
        evidence,
        intent: baselineComparison?.ok ? "current-research-result" : reasoning.intent ?? inferredIntent,
        nextAction: reasoning.nextAction ?? "Use Re-run exact config if you want a manual backtest check against this AI row.",
        recommendation: reasoning.recommendation,
        risk: reasoning.risk,
        row: responseRow,
        runId: run.id,
        sections: reasoning.sections,
        baselineComparison: baselineComparison?.ok ? baselineComparison : null,
        verifiedFrom: responseVerifiedFrom,
        memory: copilotMemory?.summary?.() ?? memory,
      },
    };
  }

  async function verifyIntegrity(id, body = {}) {
    const run = runStore.get(id);
    if (!run) {
      return { ok: false, message: "That agent run was not found.", statusCode: 404 };
    }
    const row = resolveRow(run, body);
    if (!row?.params) {
      return {
        ok: false,
        message: "This run does not include an exact config row to verify.",
        statusCode: 400,
      };
    }

    const rerun = await rerunExact(id, { ...body, rowId: row.id });
    if (!rerun.ok) return rerun;

    return {
      ok: true,
      result: {
        ai: {
          canonical: rerun.row?.canonical,
          integrity: rerun.integrity?.ai,
        },
        diff: rerun.metricDiff,
        passed: Boolean(rerun.integrity?.passed),
        rerun: {
          canonical: rerun.rerunRow?.canonical,
          integrity: rerun.integrity?.rerun,
        },
        warnings: rerun.integrity?.warnings ?? [],
      },
    };
  }

  return {
    cancelRun,
    chat,
    exportRun,
    getArtifacts(id) {
      const run = runStore.get(id);
      return run
        ? { artifacts: (run.artifacts ?? []).map(({ content, ...artifact }) => artifact), ok: true }
        : { message: "That agent run was not found.", ok: false, statusCode: 404 };
    },
    getRun(id) {
      const run = runStore.get(id);
      return run
        ? { ok: true, run: runStore.publicRun(run) }
        : { message: "That agent run was not found.", ok: false, statusCode: 404 };
    },
    getRunDebug(id) {
      const run = runStore.get(id);
      if (!run) {
        return { message: "That agent run was not found.", ok: false, statusCode: 404 };
      }
      const heartbeatMs = run.heartbeatAt ? Date.now() - Date.parse(run.heartbeatAt) : null;
      return {
        debug: {
          cacheStats: run.cacheStats ?? {},
          currentStage: run.currentStep,
          errors: run.errors ?? [],
          heartbeatAgeSeconds: Number.isFinite(heartbeatMs) ? Math.round(heartbeatMs / 1000) : null,
          heartbeatAt: run.heartbeatAt,
          id: run.id,
          lastUnresolvedTask: {
            config: run.progress?.worker?.currentConfig ?? null,
            index: run.progress?.worker?.currentCombinationIndex ?? null,
            message: run.progress?.worker?.lastMessage ?? "",
            promiseState: run.progress?.worker?.promiseState ?? "",
            timeoutState: run.progress?.worker?.timeoutState ?? "",
            workerId: run.progress?.worker?.workerId ?? "",
          },
          memory: memorySnapshot(),
          progress: run.progress,
          status: run.status,
          warnings: run.warnings ?? [],
          worker: run.progress?.worker ?? {},
          workerId: run.workerId,
        },
        ok: true,
      };
    },
    listRuns() {
      return {
        ok: true,
        queue: jobQueue.status(),
        runs: runStore.list(),
      };
    },
    rerunExact,
    restartRun,
    startRun,
    compareAgentResultToBacktest,
    verifyIntegrity,
  };
}
