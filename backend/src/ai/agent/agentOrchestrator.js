import { createAgentExecutor } from "./agentExecutor.js";
import { createAgentJobQueue } from "./agentJobQueue.js";
import { createAgentPlan } from "./agentPlanner.js";
import { createAgentRunStore } from "./agentRunStore.js";
import { checkAgentPlanSafety } from "./agentRiskGuard.js";
import { createAgentToolRegistry } from "./agentToolRegistry.js";
import { composeAgentMarkdown, rowsToCsv } from "./agentReportComposer.js";
import { metricDiff as diffMetrics, normalizeResearchResult, summarizeIntegrity } from "./agentResultIntegrity.js";
import { buildReasoningResponse } from "../reasoning/reasoningEngine.js";

function isPolishQuestion(value = "") {
  const normalized = String(value)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  return /(^|\s)(co|czemu|dlaczego|jak|gdzie|porownaj|wynik|dziala|nadal|robi|robia|ustawienia|blad|gorszy|lepszy)(\s|$)/u.test(normalized);
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
      /\b(?:worse|better|gorszy|gorsze|lepszy|lepsze)\s+(?:than|niz|niż)\s+["“]?([a-z0-9][a-z0-9 _.-]{1,60})["”]?/i,
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
    const wantsPlatformEvidence = (
      mode === "platform-diagnosis" ||
      mode === "code-evidence" ||
      mode === "platform" ||
      body.evidenceMode === true
    );

    if (wantsPlatformEvidence && typeof tools.answerFromPlatformEvidence === "function") {
      const platformEvidence = await tools.answerFromPlatformEvidence({
        mode,
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
        intent: "platform-evidence",
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
        intent: reasoning.intent,
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
