import { createAgentArtifact } from "./agentArtifacts.js";
import { mergeProgress } from "./agentProgress.js";
import { composeAgentMarkdown, composeEmailDraft, composeTelegramDraft, rowsToCsv } from "./agentReportComposer.js";
import { normalizeResearchRows, summarizeIntegrity } from "./agentResultIntegrity.js";
import { runResearchWorkflow } from "../research/researchEngine.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeMetrics(result = {}) {
  const metrics = result.metrics ?? {};
  return {
    candlesUsed: result.candlesUsed ?? 0,
    maxDrawdown: metrics.maxDrawdown ?? 0,
    netProfit: metrics.netProfit ?? 0,
    profitFactor: metrics.profitFactor ?? 0,
    totalTrades: metrics.totalTrades ?? 0,
    winRate: metrics.winRate ?? 0,
  };
}

function reportArtifacts({ output, plan, run }) {
  const markdown = composeAgentMarkdown({ output, plan, run });
  const rows = output.rankedResults ?? output.rows ?? [];
  const artifacts = [
    createAgentArtifact({
      content: markdown,
      format: "md",
      name: "agent-report",
      type: "markdown-report",
    }),
    createAgentArtifact({
      content: JSON.stringify({ output, plan, runId: run.id }, null, 2),
      format: "json",
      name: "agent-result",
      type: "json-report",
    }),
  ];

  if (rows.length) {
    artifacts.push(createAgentArtifact({
      content: rowsToCsv(rows),
      format: "csv",
      name: "agent-ranking",
      type: "csv-ranking",
    }));
  }

  if (plan.artifacts?.emailDraft) {
    artifacts.push(createAgentArtifact({
      content: JSON.stringify(composeEmailDraft({ markdown, plan }), null, 2),
      format: "json",
      name: "email-draft",
      type: "email-draft",
    }));
  }

  if (plan.artifacts?.telegramDraft) {
    artifacts.push(createAgentArtifact({
      content: JSON.stringify(composeTelegramDraft({ markdown }), null, 2),
      format: "json",
      name: "telegram-draft",
      type: "telegram-draft",
    }));
  }

  return artifacts;
}

export function createAgentExecutor({ runStore, toolRegistry }) {
  async function isCancelled(runId) {
    return Boolean(runStore.get(runId)?.cancelRequested);
  }

  async function updateProgress(runId, progress, currentStep = "Working") {
    const run = runStore.get(runId);
    const completed = Number(progress.completed ?? run?.progress?.completed ?? 0);
    const startedAt = Date.parse(run?.startedAt ?? run?.queuedAt ?? new Date().toISOString());
    const elapsedSeconds = Math.max(1, (Date.now() - startedAt) / 1000);
    const combinationsPerSecond = completed / elapsedSeconds;
    await runStore.heartbeat(runId, {
      cacheStats: progress.cacheStats ?? run?.cacheStats ?? {},
      currentStep,
      partialResults: progress.topRows ?? run?.partialResults ?? [],
      progress: {
        ...mergeProgress(run?.progress, progress),
        activeWorkers: progress.activeWorkers,
        cacheHitRate: progress.cacheStats?.total
          ? Math.round((progress.cacheStats.hits / progress.cacheStats.total) * 100)
          : run?.progress?.cacheHitRate,
        combinationsPerSecond: Number.isFinite(combinationsPerSecond) ? Number(combinationsPerSecond.toFixed(2)) : 0,
        etaSeconds: progress.remainingSeconds ?? run?.progress?.etaSeconds,
        stage: currentStep,
        stageProgress: progress.stageProgress ?? progress.percent ?? run?.progress?.stageProgress,
        worker: progress.worker ?? run?.progress?.worker,
      },
    });
  }

  async function executeSweep(run) {
    const result = await toolRegistry.runLargeSweepBatched({
      isCancelled: () => isCancelled(run.id),
      jobId: run.id,
      onProgress: (progress) => updateProgress(run.id, progress, "Running batched sweep"),
      plan: run.plan,
    });

    const output = {
      ...result,
      best: result.rankedResults?.[0] ?? null,
      nextTests: [
        "Re-test the top rows on a separate period.",
        "Compare the top row in legacy and conservative fill mode.",
        "Run a narrower sweep around neighboring settings.",
      ],
      recommendation: result.rankedResults?.[0]
        ? "Use the top ranked row as a research candidate, not a live deployment."
        : "No candidate was strong enough to recommend.",
      robustnessNotes: "The score rewards return quality, drawdown control, profit factor, and enough trades. It does not choose raw PnL only.",
      summary: result.cancelled
        ? `Sweep cancelled after ${result.processedCombinations ?? result.testedCombinations} processed configs.`
        : `Sweep completed ${result.processedCombinations ?? result.testedCombinations} processed configs and ranked the strongest compact results.`,
      toolsUsed: ["runHistoricalBacktest", "runLargeSweepBatched", "rankSweepResults"],
      warnings: [
        ...(run.warnings ?? []),
        result.requestedCombinations > result.totalCombinations
          ? `Requested ${result.requestedCombinations} combinations and tested ${result.totalCombinations} by safety cap.`
          : "",
        result.generatedCombinations > result.totalCombinations
          ? `Parameter grid had ${result.generatedCombinations} possible combinations; this run planned ${result.totalCombinations}.`
          : "",
        result.failedCombinationsCount
          ? `${result.failedCombinationsCount} combinations failed or timed out and were skipped.`
          : "",
      ].filter(Boolean),
    };

    return output;
  }

  async function executeBacktest(run) {
    await updateProgress(run.id, { completed: 0, percent: 10, total: 1 }, "Running historical backtest");
    const result = await toolRegistry.runBacktest(run.plan);
    await updateProgress(run.id, { completed: 1, percent: 100, total: 1 }, "Backtest complete");

    return {
      candlesUsed: result.candlesUsed,
      rows: [{ ...summarizeMetrics(result), fillMode: result.fillMode, rank: 1, score: result.metrics?.netProfit ?? 0, timeframe: result.timeframe }],
      summary: `Backtest completed with ${result.metrics?.totalTrades ?? 0} trades.`,
      toolsUsed: ["runHistoricalBacktest"],
      ...summarizeMetrics(result),
    };
  }

  async function executeCompareFillModes(run) {
    const rows = [];
    const total = (run.plan.timeframes ?? [run.plan.timeframe]).length * 2;
    let completed = 0;

    for (const timeframe of run.plan.timeframes ?? [run.plan.timeframe]) {
      const legacy = await toolRegistry.runBacktest({ ...run.plan, fillMode: "legacy", timeframe }, { fillMode: "legacy", timeframe });
      completed += 1;
      await updateProgress(run.id, { completed, percent: Math.round((completed / total) * 100), total }, `Legacy ${timeframe}`);

      const conservative = await toolRegistry.runBacktest({ ...run.plan, fillMode: "conservative", timeframe }, { fillMode: "conservative", timeframe });
      completed += 1;
      await updateProgress(run.id, { completed, percent: Math.round((completed / total) * 100), total }, `Conservative ${timeframe}`);

      rows.push({
        conservative: summarizeMetrics(conservative),
        legacy: summarizeMetrics(legacy),
        maxDrawdown: conservative.metrics?.maxDrawdown ?? 0,
        metrics: conservative.metrics ?? {},
        netProfit: conservative.metrics?.netProfit ?? 0,
        profitFactor: conservative.metrics?.profitFactor ?? 0,
        score: Number(conservative.metrics?.netProfit ?? 0) - Number(conservative.metrics?.maxDrawdown ?? 0),
        timeframe,
        totalTrades: conservative.metrics?.totalTrades ?? 0,
        winRate: conservative.metrics?.winRate ?? 0,
      });

      if (await isCancelled(run.id)) break;
    }

    return {
      rows,
      summary: "Compared legacy and conservative fill behavior. Conservative results show pessimistic same-candle handling.",
      toolsUsed: ["runHistoricalBacktest", "compareFillModes"],
      warnings: ["Large differences between fill modes mean intrabar sequencing matters for this setup."],
    };
  }

  async function executeCompareTimeframes(run) {
    const rows = [];
    const timeframes = run.plan.timeframes ?? [run.plan.timeframe];

    for (const [index, timeframe] of timeframes.entries()) {
      if (await isCancelled(run.id)) break;
      const result = await toolRegistry.runBacktest(run.plan, { timeframe });
      rows.push({
        ...summarizeMetrics(result),
        metrics: result.metrics ?? {},
        rank: index + 1,
        score: Number(result.metrics?.netProfit ?? 0) - Number(result.metrics?.maxDrawdown ?? 0),
        timeframe,
      });
      await updateProgress(run.id, {
        completed: index + 1,
        percent: Math.round(((index + 1) / timeframes.length) * 100),
        total: timeframes.length,
      }, `Testing ${timeframe}`);
    }

    rows.sort((left, right) => Number(right.score ?? 0) - Number(left.score ?? 0));
    rows.forEach((row, index) => {
      row.rank = index + 1;
    });

    return {
      best: rows[0] ?? null,
      rows,
      summary: rows[0] ? `${rows[0].timeframe} ranked strongest in this comparison.` : "No timeframe results were produced.",
      toolsUsed: ["runHistoricalBacktest", "groupResultsByTimeframe"],
      warnings: ["Timeframe rankings can change by market regime. Retest separate periods."],
    };
  }

  async function executeDiagnose(run) {
    await updateProgress(run.id, { completed: 0, percent: 25, total: 1 }, "Reading platform status");
    const status = await toolRegistry.getPlatformStatus();
    const issue = await toolRegistry.diagnoseIssue({ question: run.prompt });
    await updateProgress(run.id, { completed: 1, percent: 100, total: 1 }, "Diagnosis complete");

    return {
      rows: [],
      summary: issue.likelyCause ?? "No clear issue was found in the latest backend status.",
      toolsUsed: ["getPlatformStatus", "diagnoseIssue"],
      warnings: status.status?.state?.lastError ? [status.status.state.lastError] : [],
    };
  }

  async function executeResearch(run) {
    return runResearchWorkflow({
      isCancelled: () => isCancelled(run.id),
      onProgress: (progress, step) => updateProgress(run.id, progress, step),
      plan: { ...run.plan, jobId: run.id },
      toolRegistry,
    });
  }

  async function execute(runId) {
    const initialRun = runStore.get(runId);
    if (!initialRun) return null;

    try {
      await runStore.update(runId, {
        currentStep: "Starting",
        heartbeatAt: new Date().toISOString(),
        startedAt: initialRun.startedAt ?? new Date().toISOString(),
        status: "running",
      });
      await sleep(0);

      const run = runStore.get(runId);
      let output;

      if (run.plan.kind === "research") {
        output = await executeResearch(run);
      } else if (run.plan.kind === "sweep" || run.plan.kind === "report") {
        output = await executeSweep(run);
      } else if (run.plan.kind === "compare_fill_modes") {
        output = await executeCompareFillModes(run);
      } else if (run.plan.kind === "compare_timeframes") {
        output = await executeCompareTimeframes(run);
      } else if (run.plan.kind === "diagnose") {
        output = await executeDiagnose(run);
      } else {
        output = await executeBacktest(run);
      }

      const latest = runStore.get(runId);
      const status = latest.cancelRequested || output.cancelled ? "cancelled" : "completed";
      const rawRows = output.rankedResults ?? output.rows ?? [];
      const normalizedRows = normalizeResearchRows(rawRows, { output, plan: latest.plan, run: latest });
      const integrity = summarizeIntegrity(normalizedRows, output);
      const normalizedOutput = {
        ...output,
        best: normalizedRows[0] ?? output.best ?? null,
        integrity,
        rankedResults: output.rankedResults ? normalizedRows : undefined,
        rows: output.rows && !output.rankedResults ? normalizedRows : normalizedRows,
        warnings: [
          ...(output.warnings ?? []),
          ...integrity.warnings.map((warning) => `Integrity: ${warning}`),
        ],
      };
      const artifacts = reportArtifacts({ output: normalizedOutput, plan: latest.plan, run: latest });
      const resultSummary = {
        best: normalizedRows[0] ?? null,
        cacheStats: normalizedOutput.cacheStats ?? latest.cacheStats ?? {},
        executedCombinations: normalizedOutput.processedCombinations ?? normalizedOutput.testedCombinations ?? normalizedOutput.totalCombinations ?? latest.progress?.completed ?? 0,
        failedCombinations: normalizedOutput.failedCombinationsCount ?? 0,
        generatedCombinations: normalizedOutput.generatedCombinations,
        integrity,
        message: normalizedOutput.summary,
        plannedCombinations: latest.plan?.plannedCombinations ?? latest.plan?.maxCombinations,
        requestedCombinations: latest.plan?.requestedCombinations ?? latest.plan?.maxCombinations,
        requestedRange: latest.plan?.range,
        topRows: normalizedRows.slice(0, 10),
      };

      return runStore.update(runId, {
        artifacts,
        currentStep: status === "cancelled" ? "Cancelled" : "Completed",
        finishedAt: new Date().toISOString(),
        progress: { ...latest.progress, percent: status === "cancelled" ? latest.progress?.percent ?? 0 : 100 },
        resultSummary,
        status,
        warnings: [...(latest.warnings ?? []), ...(normalizedOutput.warnings ?? [])],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return runStore.update(runId, {
        currentStep: "Failed",
        errors: [...(runStore.get(runId)?.errors ?? []), message],
        finishedAt: new Date().toISOString(),
        status: "failed",
      });
    }
  }

  return { execute };
}
