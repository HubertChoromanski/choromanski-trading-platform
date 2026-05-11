import { createAgentExecutor } from "./agentExecutor.js";
import { createAgentJobQueue } from "./agentJobQueue.js";
import { createAgentPlan } from "./agentPlanner.js";
import { createAgentRunStore } from "./agentRunStore.js";
import { checkAgentPlanSafety } from "./agentRiskGuard.js";
import { createAgentToolRegistry } from "./agentToolRegistry.js";
import { composeAgentMarkdown, rowsToCsv } from "./agentReportComposer.js";
import { metricDiff as diffMetrics, normalizeResearchResult, summarizeIntegrity } from "./agentResultIntegrity.js";
import { buildReasoningResponse } from "../reasoning/reasoningEngine.js";

export function createAgentOrchestrator({ store, tools }) {
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
    jobQueue.enqueue(run.id);

    return {
      ok: true,
      run,
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

  async function chat(body = {}) {
    const message = String(body.message ?? "").trim();
    if (!message) {
      return { ok: false, message: "Ask a follow-up first.", statusCode: 400 };
    }
    const run = body.runId ? runStore.get(body.runId) : runStore.list().find((item) => item.status === "completed");
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
    const evidence = [
      `Run: ${run.id}`,
      `Intent: ${run.parsedIntent}`,
      `Range: ${run.plan?.range?.from} to ${run.plan?.range?.to}`,
      `Provider: ${run.plan?.provider}`,
      normalizedRow ? `Selected row: rank ${normalizedRow.rank ?? rowIndex + 1}` : "No ranked row available.",
      ...(reasoning.evidence ?? []),
    ];
    const answer = reasoning.answer ?? run.resultSummary?.message ?? "This run completed, but no compact summary is available.";
    const responseRow = compactRow(reasoning.row ?? normalizedRow);
    const responseVerifiedFrom = verifiedFrom(run, reasoning.row ?? normalizedRow);

    const nextMessages = [
      ...(run.messages ?? []),
      {
        context: {
          rowId: row?.id ?? null,
          rowRank: normalizedRow?.rank ?? null,
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
        row: responseRow,
        verifiedFrom: responseVerifiedFrom,
      },
    ].slice(-40);
    await runStore.update(run.id, { messages: nextMessages });

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
        verifiedFrom: responseVerifiedFrom,
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
    verifyIntegrity,
  };
}
