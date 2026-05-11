import { Worker } from "node:worker_threads";

function parseList(value, fallback, { integer = false, positive = false } = {}) {
  const source = Array.isArray(value) ? value : String(value ?? "").split(",");
  const parsed = source
    .map((item) => String(item).trim())
    .filter((item) => item !== "")
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item))
    .map((item) => (integer ? Math.round(item) : item))
    .filter((item) => (!positive || item > 0));
  return parsed.length ? parsed : fallback;
}

function scoreResult(metrics = {}, startingBalance = 10000) {
  const netProfit = Number(metrics.netProfit ?? 0);
  const netPercent = startingBalance > 0 ? (netProfit / startingBalance) * 100 : 0;
  const profitFactor = Math.min(Number(metrics.profitFactor ?? 0), 5);
  const drawdown = Math.max(0, Number(metrics.maxDrawdown ?? 0));
  const trades = Number(metrics.totalTrades ?? 0);
  const tradeQuality = trades < 12 ? -8 : Math.min(trades, 80) * 0.035;
  return netPercent + profitFactor * 1.5 + tradeQuality - drawdown * 0.75;
}

function constraintStatus(row = {}, constraints = {}) {
  const metrics = row.metrics ?? row;
  const failures = [];
  const pf = Number(metrics.profitFactor ?? row.profitFactor ?? 0);
  const dd = Number(metrics.maxDrawdown ?? row.maxDrawdown ?? 0);
  const trades = Number(metrics.totalTrades ?? row.totalTrades ?? 0);
  if (constraints.minProfitFactor !== undefined && pf < Number(constraints.minProfitFactor)) {
    failures.push(`PF ${pf} below minimum ${constraints.minProfitFactor}`);
  }
  if (constraints.maxDrawdown !== undefined && dd > Number(constraints.maxDrawdown)) {
    failures.push(`DD ${dd} above maximum ${constraints.maxDrawdown}`);
  }
  if (constraints.minTrades !== undefined && trades < Number(constraints.minTrades)) {
    failures.push(`Trades ${trades} below minimum ${constraints.minTrades}`);
  }
  return {
    failures,
    passed: failures.length === 0,
  };
}

function constraintSummary(rows = [], constraints = {}) {
  if (!constraints || !Object.keys(constraints).length) {
    return { active: false, passed: rows.length, rejected: 0, total: rows.length };
  }
  const statuses = rows.map((row) => constraintStatus(row, constraints));
  return {
    active: true,
    constraints,
    passed: statuses.filter((status) => status.passed).length,
    rejected: statuses.filter((status) => !status.passed).length,
    total: rows.length,
  };
}

function sideValue(result, side) {
  return side === "LONG" ? result.longResult ?? 0 : result.shortResult ?? 0;
}

function cacheKey(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}

function clone(value) {
  return value ? structuredClone(value) : value;
}

function uniqueNumbers(values = [], { integer = false, positive = false } = {}) {
  return [...new Set(values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .map((value) => (integer ? Math.round(value) : Number(value.toFixed(8))))
    .filter((value) => (!positive || value > 0)))]
    .sort((left, right) => left - right);
}

function baselineNeighbors(value, { integer = false, min = 0, step = 1 } = {}) {
  const base = Number(value);
  if (!Number.isFinite(base)) return [];
  const values = integer
    ? [base - step, base, base + step]
    : [base - step, base, base + step];
  return uniqueNumbers(values.map((item) => Math.max(min, item)), { integer, positive: min > 0 });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function memorySnapshot() {
  const memory = process.memoryUsage();
  return {
    heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
    rssMb: Math.round(memory.rss / 1024 / 1024),
  };
}

function runPreparedBacktestInWorker(prepared, { label, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const workerStartedAt = new Date().toISOString();
    const worker = new Worker(new URL("./agentBacktestWorker.js", import.meta.url), {
      workerData: {
        label,
        prepared,
      },
    });
    let settled = false;
    let timeoutId;

    function settle(callback) {
      if (settled) return;
      settled = true;
      if (timeoutId) clearTimeout(timeoutId);
      callback();
    }

    timeoutId = setTimeout(() => {
      settle(() => {
        worker.terminate().catch(() => {});
        reject(new Error(`${label} worker timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);

    worker.once("message", (message) => {
      settle(() => {
        if (message?.ok) {
          resolve({
            ...message.result,
            workerDiagnostics: {
              ...(message.diagnostics ?? {}),
              finishedAt: new Date().toISOString(),
              startedAt: workerStartedAt,
              timeout: false,
            },
          });
          return;
        }

        const error = new Error(message?.error?.message ?? `${label} worker failed`);
        error.stack = message?.error?.stack || error.stack;
        reject(error);
      });
    });

    worker.once("error", (error) => {
      settle(() => {
        reject(error);
      });
    });

    worker.once("exit", (code) => {
      if (settled) return;
      settle(() => {
        if (code === 0) {
          reject(new Error(`${label} worker exited without a result`));
        } else {
          reject(new Error(`${label} worker exited with code ${code}`));
        }
      });
    });
  });
}

export function buildSweepCombinations(plan) {
  const parameters = plan.parameters ?? {};
  const sizingMode = plan.sizingMode ?? "position-percent";
  const baseline = plan.baselineParams ?? {};
  const bandwidths = parseList(parameters.bandwidthValues, baseline.bandwidth ? baselineNeighbors(baseline.bandwidth, { min: 0.1, step: 1 }) : [6, 7, 8, 9, 10], { positive: true });
  const envelopes = parseList(parameters.envelopeMultiplierValues, baseline.envelopeMultiplier ? baselineNeighbors(baseline.envelopeMultiplier, { min: 0.1, step: 0.3 }) : [2, 2.5, 3, 3.5, 4], { positive: true });
  const atrLengths = parseList(parameters.atrLengthValues, baseline.atrLength ? baselineNeighbors(baseline.atrLength, { integer: true, min: 1, step: 2 }) : [10, 14], { integer: true, positive: true });
  const atrMultipliers = parseList(parameters.atrMultiplierValues, baseline.atrMultiplier ? baselineNeighbors(baseline.atrMultiplier, { min: 0.1, step: 0.2 }) : [0.8, 1, 1.2, 1.4, 1.6], { positive: true });
  const maxFailures = parseList(parameters.maxSameSideFailuresValues, baseline.maxSameSideFailures !== undefined ? baselineNeighbors(baseline.maxSameSideFailures, { integer: true, min: 0, step: 1 }) : [1, 2, 3], { integer: true });
  const sizingValues = parseList(parameters.sizingValues, baseline.sizingValue ? baselineNeighbors(baseline.sizingValue, { min: 0.01, step: sizingMode === "fixed-risk" ? 0.25 : 10 }) : (sizingMode === "fixed-risk" ? [0.5, 1, 2] : [5, 10]), { positive: true });
  const combos = [];

  bandwidths.forEach((bandwidth) => {
    envelopes.forEach((envelopeMultiplier) => {
      atrLengths.forEach((atrLength) => {
        atrMultipliers.forEach((atrMultiplier) => {
          maxFailures.forEach((maxSameSideFailures) => {
            sizingValues.forEach((sizingValue) => {
              combos.push({
                atrLength,
                atrMultiplier,
                bandwidth,
                envelopeMultiplier,
                maxSameSideFailures,
                sizingValue,
              });
            });
          });
        });
      });
    });
  });

  if (baseline.bandwidth && baseline.envelopeMultiplier && baseline.atrLength && baseline.atrMultiplier && baseline.maxSameSideFailures !== undefined) {
    combos.unshift({
      atrLength: baseline.atrLength,
      atrMultiplier: baseline.atrMultiplier,
      bandwidth: baseline.bandwidth,
      envelopeMultiplier: baseline.envelopeMultiplier,
      maxSameSideFailures: baseline.maxSameSideFailures,
      sizingValue: baseline.sizingValue ?? sizingValues[0],
      source: "baseline",
    });
  }

  const seen = new Set();
  return combos.filter((combo) => {
    const key = cacheKey({
      atrLength: combo.atrLength,
      atrMultiplier: combo.atrMultiplier,
      bandwidth: combo.bandwidth,
      envelopeMultiplier: combo.envelopeMultiplier,
      maxSameSideFailures: combo.maxSameSideFailures,
      sizingValue: combo.sizingValue,
    });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function createAgentToolRegistry({ tools }) {
  const backtestCache = new Map();
  const maxCacheEntries = Number(process.env.AI_AGENT_BACKTEST_CACHE_SIZE ?? 2500);
  const concurrency = Math.max(1, Math.min(Number(process.env.AI_AGENT_SWEEP_CONCURRENCY ?? process.env.AI_AGENT_CONCURRENCY ?? 3), 6));
  const batchSize = Math.max(1, Math.min(Number(process.env.AI_AGENT_BATCH_SIZE ?? 10), 25));
  const combinationTimeoutMs = Math.max(5000, Number(process.env.AI_AGENT_COMBINATION_TIMEOUT_MS ?? 45000));
  const batchTimeoutMs = Math.max(combinationTimeoutMs, Number(process.env.AI_AGENT_BATCH_TIMEOUT_MS ?? combinationTimeoutMs * Math.max(2, batchSize)));
  const isolateBacktests = process.env.AI_AGENT_ISOLATE_BACKTESTS !== "false";

  function paramsFromBacktestDetail(detail = {}) {
    const strategy = detail.strategyParams ?? {};
    return {
      atrLength: strategy.atrLength,
      atrMultiplier: strategy.atrMultiplier,
      bandwidth: strategy.bandwidth,
      envelopeMultiplier: strategy.envelopeMultiplier,
      maxSameSideFailures: strategy.maxSameSideFailures,
      sizingMode: detail.sizingMode,
      sizingValue: detail.sizingValue,
    };
  }

  async function hydrateBaseline(plan = {}) {
    if (!plan.baselineQuery || typeof tools.getBacktestDetail !== "function") return plan;
    const detail = await tools.getBacktestDetail(plan.baselineQuery);
    if (!detail?.ok) {
      return {
        ...plan,
        baselineWarning: detail?.message ?? `Could not resolve baseline "${plan.baselineQuery}".`,
      };
    }
    const baselineParams = paramsFromBacktestDetail(detail);
    return {
      ...plan,
      baselineDetail: {
        id: detail.id,
        metrics: detail.metrics,
        name: detail.name,
        provenance: detail.provenance,
        range: detail.range,
        resolved: detail.resolved,
        strategyParams: detail.strategyParams,
      },
      baselineParams,
      sizingMode: plan.sizingModeExplicit ? (plan.sizingMode ?? "position-percent") : (detail.sizingMode ?? plan.sizingMode ?? "position-percent"),
    };
  }

  async function runBacktest(plan, overrides = {}, meta = {}) {
    const input = {
      fillMode: plan.fillMode ?? "legacy",
      from: plan.range?.from,
      maxCombinations: plan.maxCombinations,
      provider: plan.provider ?? "binance-futures",
      sizingMode: plan.sizingMode ?? "position-percent",
      startingBalance: Number(plan.startingBalance ?? 10000),
      symbol: plan.symbol ?? "SOLUSDT",
      timeframe: overrides.timeframe ?? plan.timeframe ?? "15m",
      to: plan.range?.to,
      ...overrides,
    };
    const key = cacheKey(input);

    if (backtestCache.has(key)) {
      return {
        ...clone(backtestCache.get(key)),
        cacheHit: true,
        workerDiagnostics: {
          cacheHit: true,
          isolated: isolateBacktests,
        },
      };
    }

    const result = isolateBacktests && typeof tools.prepareHistoricalBacktest === "function"
      ? await runPreparedBacktestInWorker(
        await tools.prepareHistoricalBacktest(input),
        {
          label: `AI combination ${meta.index ?? "?"}/${meta.total ?? "?"}`,
          timeoutMs: meta.timeoutMs ?? combinationTimeoutMs,
        },
      )
      : await tools.runHistoricalBacktest(input);
    const enriched = {
      ...result,
      cacheHit: false,
      workerDiagnostics: {
        ...(result.workerDiagnostics ?? {}),
        isolated: isolateBacktests && typeof tools.prepareHistoricalBacktest === "function",
      },
      provenance: {
        candlesUsed: result.candlesUsed,
        commissionPercent: input.commissionPercent ?? 0.04,
        fillMode: input.fillMode ?? "legacy",
        from: input.from,
        mmDeckId: input.mmDeckId ?? null,
        pfFormula: "grossProfit / abs(grossLoss)",
        provider: input.provider ?? "binance-futures",
        sizingMode: input.sizingMode ?? "position-percent",
        slippagePercent: input.slippagePercent ?? 0,
        startingBalance: input.startingBalance ?? 10000,
        strategyDeckId: input.strategyDeckId ?? null,
        symbol: input.symbol ?? "SOLUSDT",
        timeframe: input.timeframe ?? "15m",
        to: input.to,
      },
    };

    backtestCache.set(key, clone(enriched));
    if (backtestCache.size > maxCacheEntries) {
      backtestCache.delete(backtestCache.keys().next().value);
    }

    return enriched;
  }

  async function runLargeSweepBatched({ isCancelled, jobId = "agent-job", onProgress, plan }) {
    const hydratedPlan = await hydrateBaseline(plan);
    const allCombinations = buildSweepCombinations(hydratedPlan);
    const combinations = allCombinations.slice(0, Number(hydratedPlan.maxCombinations ?? 1000));
    const total = combinations.length;
    const rows = [];
    const startingBalance = Number(plan.startingBalance ?? 10000);
    const startedAt = Date.now();
    const cacheStats = { hits: 0, misses: 0, total: 0 };
    const failedCombinations = [];

    let completed = 0;
    let activePromiseCount = 0;
    let lastCompletedIndex = 0;
    let lastCompletedConfig = null;
    let lastError = "";
    let progressWrite = Promise.resolve();

    function logWorker(message, extra = {}) {
      const compact = {
        activePromiseCount,
        completed,
        jobId,
        memory: memorySnapshot(),
        total,
        ...extra,
      };
      console.info(`[ai-agent-worker] ${message} ${JSON.stringify(compact)}`);
    }

    async function writeProgress(worker = {}) {
      const elapsedSeconds = Math.max(1, (Date.now() - startedAt) / 1000);
      const rate = completed / elapsedSeconds;
      const payload = {
        activeWorkers: activePromiseCount,
        cacheStats: { ...cacheStats },
        completed,
        percent: Math.round((completed / Math.max(1, total)) * 100),
        remainingSeconds: Math.round((total - completed) / Math.max(rate, 0.1)),
        topRows: rankSweepResults(rows, hydratedPlan).slice(0, 5),
        total,
        worker: {
          activePromiseCount,
          failedCombinations: failedCombinations.length,
          lastCompletedConfig,
          lastCompletedIndex,
          lastError,
          memory: memorySnapshot(),
          ...worker,
        },
      };
      progressWrite = progressWrite
        .then(() => onProgress(payload))
        .catch((error) => {
          console.warn(`[ai-agent-worker] progress write failed for ${jobId}: ${compactError(error)}`);
        });
      return progressWrite;
    }

    async function processCombination(combo, index, batchInfo, workerIndex = 0) {
      const combinationStartedAt = Date.now();
      const oneBasedIndex = index + 1;
      const sizingMode = hydratedPlan.sizingMode ?? "position-percent";
      const workerId = `${jobId}:batch-${batchInfo.batchNumber}:worker-${workerIndex}`;
      activePromiseCount += 1;
      logWorker("combination:start", {
        batch: batchInfo.batchNumber,
        combo,
        index: oneBasedIndex,
        promiseState: "pending",
        timeoutState: "armed",
        workerId,
      });
      await writeProgress({
        batchEndIndex: batchInfo.end + 1,
        batchId: batchInfo.batchNumber,
        batchStartIndex: batchInfo.start + 1,
        currentCombinationIndex: oneBasedIndex,
        currentConfig: combo,
        lastMessage: `Started config ${oneBasedIndex}/${total}`,
        promiseState: "pending",
        timeoutState: "armed",
        workerId,
      });

      try {
        if (await isCancelled()) {
          return { cancelled: true, index };
        }

        const resultPromise = runBacktest(
          hydratedPlan,
          {
            ...combo,
            positionPercent: sizingMode === "position-percent" ? combo.sizingValue : undefined,
            riskPercent: sizingMode === "fixed-risk" ? combo.sizingValue : undefined,
            sizingMode,
          },
          {
            combo,
            index: oneBasedIndex,
            jobId,
            timeoutMs: combinationTimeoutMs,
            total,
            workerId,
          },
        );
        const result = isolateBacktests
          ? await resultPromise
          : await withTimeout(resultPromise, combinationTimeoutMs, `AI combination ${oneBasedIndex}/${total}`);
        cacheStats.total += 1;
        if (result.cacheHit) cacheStats.hits += 1;
        else cacheStats.misses += 1;
        const row = {
          candlesUsed: result.candlesUsed,
          fillMode: result.fillMode ?? hydratedPlan.fillMode ?? "legacy",
          id: `agent-sweep-row-${Date.now()}-${index}`,
          longResult: sideValue(result, "LONG"),
          metrics: result.metrics ?? {},
          params: {
            ...combo,
            fillMode: result.fillMode ?? hydratedPlan.fillMode ?? "legacy",
            sizingMode,
          },
          provenance: {
            ...result.provenance,
            exactParameters: combo,
            grossLoss: result.metrics?.grossLoss ?? 0,
            grossProfit: result.metrics?.grossProfit ?? 0,
            netProfit: result.metrics?.netProfit ?? 0,
            profitFactor: result.metrics?.profitFactor ?? 0,
            robustnessFormula: "net% + capped PF + trade quality - drawdown penalty - validation penalties",
            strategySettings: result.settings ?? null,
            winRate: result.metrics?.winRate ?? 0,
          },
          score: scoreResult(result.metrics, startingBalance),
          settings: result.settings ?? null,
          shortResult: sideValue(result, "SHORT"),
          symbol: result.symbol,
          timeframe: result.timeframe,
        };
        rows.push(row);
        completed += 1;
        lastCompletedIndex = oneBasedIndex;
        lastCompletedConfig = combo;
        lastError = "";
        const durationMs = Date.now() - combinationStartedAt;
        logWorker("combination:complete", {
          batch: batchInfo.batchNumber,
          cacheHit: Boolean(result.cacheHit),
          durationMs,
          index: oneBasedIndex,
          promiseState: "fulfilled",
          timeoutState: result.workerDiagnostics?.timeout ? "timed-out" : "clear",
          workerDiagnostics: result.workerDiagnostics ?? null,
          workerId,
        });
        await writeProgress({
          batchEndIndex: batchInfo.end + 1,
          batchId: batchInfo.batchNumber,
          batchStartIndex: batchInfo.start + 1,
          currentCombinationIndex: null,
          currentConfig: null,
          durationMs,
          lastMessage: `Completed config ${oneBasedIndex}/${total} in ${durationMs}ms`,
          promiseState: "fulfilled",
          timeoutState: "clear",
          workerId,
        });
        return { index, row };
      } catch (error) {
        const durationMs = Date.now() - combinationStartedAt;
        const message = compactError(error);
        failedCombinations.push({
          combo,
          durationMs,
          index: oneBasedIndex,
          message,
        });
        completed += 1;
        lastCompletedIndex = oneBasedIndex;
        lastCompletedConfig = combo;
        lastError = message;
        logWorker("combination:failed", {
          batch: batchInfo.batchNumber,
          durationMs,
          error: message,
          index: oneBasedIndex,
          promiseState: "rejected",
          timeoutState: message.includes("timed out") ? "timed-out" : "clear",
          workerId,
        });
        await writeProgress({
          batchEndIndex: batchInfo.end + 1,
          batchId: batchInfo.batchNumber,
          batchStartIndex: batchInfo.start + 1,
          currentCombinationIndex: null,
          currentConfig: null,
          durationMs,
          lastMessage: `Failed config ${oneBasedIndex}/${total}; continuing`,
          promiseState: "rejected",
          timeoutState: message.includes("timed out") ? "timed-out" : "clear",
          workerId,
        });
        return { error: message, index };
      } finally {
        activePromiseCount = Math.max(0, activePromiseCount - 1);
      }
    }

    for (let start = 0, batchNumber = 1; start < total; start += batchSize, batchNumber += 1) {
      if (await isCancelled()) break;
      const end = Math.min(total, start + batchSize) - 1;
      const batch = combinations.slice(start, end + 1);
      const batchStartedAt = Date.now();
      const batchInfo = { batchNumber, end, start };
      logWorker("batch:start", {
        batchNumber,
        batchSize: batch.length,
        endIndex: end + 1,
        startIndex: start + 1,
      });
      await writeProgress({
        batchEndIndex: end + 1,
        batchStartIndex: start + 1,
        lastMessage: `Starting batch ${batchNumber}: configs ${start + 1}-${end + 1}`,
      });

      const workers = Array.from({ length: Math.min(concurrency, batch.length) }, async (_, workerIndex) => {
        for (let offset = workerIndex; offset < batch.length; offset += concurrency) {
          if (await isCancelled()) return;
          await processCombination(batch[offset], start + offset, batchInfo, workerIndex + 1);
          await sleep(0);
        }
      });

      const settled = await withTimeout(
        Promise.allSettled(workers),
        batchTimeoutMs,
        `AI batch ${batchNumber} (${start + 1}-${end + 1})`,
      ).catch(async (error) => {
        const message = compactError(error);
        lastError = message;
        logWorker("batch:failed", {
          batchNumber,
          durationMs: Date.now() - batchStartedAt,
          error: message,
          startIndex: start + 1,
        });
        await writeProgress({
          batchEndIndex: end + 1,
          batchStartIndex: start + 1,
          durationMs: Date.now() - batchStartedAt,
          lastMessage: `Batch ${batchNumber} failed; moving to next batch`,
        });
        return [];
      });

      const rejected = settled.filter((item) => item.status === "rejected");
      if (rejected.length) {
        lastError = compactError(rejected[0].reason);
        logWorker("batch:rejections", {
          batchNumber,
          rejected: rejected.length,
          lastError,
        });
      }
      logWorker("batch:end", {
        batchNumber,
        durationMs: Date.now() - batchStartedAt,
        endIndex: end + 1,
        failedCombinations: failedCombinations.length,
        startIndex: start + 1,
      });
      await writeProgress({
        batchEndIndex: end + 1,
        batchStartIndex: start + 1,
        durationMs: Date.now() - batchStartedAt,
        lastMessage: `Finished batch ${batchNumber}: ${start + 1}-${end + 1}`,
      });
    }
    await progressWrite;

    if (await isCancelled()) {
        return {
          cacheStats,
          cancelled: true,
          failedCombinations: failedCombinations.slice(-100),
          failedCombinationsCount: failedCombinations.length,
          generatedCombinations: allCombinations.length,
          constraintSummary: constraintSummary(rows, hydratedPlan.constraints),
          rankedResults: rankSweepResults(rows, hydratedPlan),
          baseline: hydratedPlan.baselineDetail ?? null,
          baselineWarning: hydratedPlan.baselineWarning,
          requestedCombinations: hydratedPlan.requestedCombinations ?? hydratedPlan.maxCombinations ?? total,
          processedCombinations: completed,
          testedCombinations: rows.length,
          totalCombinations: total,
        };
    }

    return {
      cacheStats,
      cancelled: false,
      failedCombinations: failedCombinations.slice(-100),
      failedCombinationsCount: failedCombinations.length,
      generatedCombinations: allCombinations.length,
      constraintSummary: constraintSummary(rows, hydratedPlan.constraints),
      rankedResults: rankSweepResults(rows, hydratedPlan),
      baseline: hydratedPlan.baselineDetail ?? null,
      baselineComparison: hydratedPlan.baselineDetail ? rankSweepResults(rows, hydratedPlan).slice(0, 5).map((row) => ({
        aiConfigId: row.id,
        aiRank: row.rank,
        baselineBacktestId: hydratedPlan.baselineDetail.id,
        baselineName: hydratedPlan.baselineDetail.name,
        maxDrawdownDelta: Number(row.metrics?.maxDrawdown ?? 0) - Number(hydratedPlan.baselineDetail.metrics?.maxDrawdown ?? 0),
        netProfitDelta: Number(row.metrics?.netProfit ?? 0) - Number(hydratedPlan.baselineDetail.metrics?.netProfit ?? 0),
        profitFactorDelta: Number(row.metrics?.profitFactor ?? 0) - Number(hydratedPlan.baselineDetail.metrics?.profitFactor ?? 0),
        tradesDelta: Number(row.metrics?.totalTrades ?? 0) - Number(hydratedPlan.baselineDetail.metrics?.totalTrades ?? 0),
      })) : [],
      baselineWarning: hydratedPlan.baselineWarning,
      requestedCombinations: hydratedPlan.requestedCombinations ?? hydratedPlan.maxCombinations ?? total,
      processedCombinations: completed,
      testedCombinations: rows.length,
      totalCombinations: total,
    };
  }

  function rankSweepResults(rows = [], plan = {}) {
    const constraints = plan.constraints ?? {};
    return rows
      .map((row) => ({
        ...row,
        constraintStatus: constraintStatus(row, constraints),
      }))
      .sort((left, right) => {
        const leftPassed = left.constraintStatus?.passed ? 1 : 0;
        const rightPassed = right.constraintStatus?.passed ? 1 : 0;
        if (leftPassed !== rightPassed) return rightPassed - leftPassed;
        return Number(right.score ?? 0) - Number(left.score ?? 0);
      })
      .slice(0, 100)
      .map((row, index) => ({
        ...row,
        maxDrawdown: row.metrics?.maxDrawdown ?? 0,
        netProfit: row.metrics?.netProfit ?? 0,
        profitFactor: row.metrics?.profitFactor ?? 0,
        rank: index + 1,
        totalTrades: row.metrics?.totalTrades ?? 0,
        winRate: row.metrics?.winRate ?? 0,
      }));
  }

  return {
    compareBacktests: tools.compareBacktests,
    createAlertDraft: tools.createAlertDraft,
    diagnoseIssue: tools.diagnoseIssue,
    explainCurrentSetup: tools.explainCurrentSetup,
    exportReport: tools.exportReport,
    getBacktestDetail: tools.getBacktestDetail,
    getPlatformStatus: tools.getPlatformStatus,
    rankSweepResults,
    runBacktest,
    runLargeSweepBatched,
    runHistoricalBacktest: tools.runHistoricalBacktest,
    runSweepAnalysis: tools.runSweepAnalysis,
    resolveLibraryItem: tools.resolveLibraryItem,
  };
}
