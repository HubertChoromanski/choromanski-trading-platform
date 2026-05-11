import { runBacktest } from "../../../hubert-platform/frontend/src/backtest/backtestEngine.js";
import { fetchCandles } from "../strategy/strategyRunner.js";
import { createAiLibraryTools } from "./aiLibraryTools.js";
import { createAiPlatformAccess } from "./aiPlatformAccess.js";
import { backtestConclusion, buildBacktestSummaryReport, buildSweepReport } from "./aiReportBuilder.js";

const DEFAULT_STRATEGY = {
  atrLength: 14,
  atrMultiplier: 1.2,
  bandwidth: 8,
  envelopeMultiplier: 3,
  maxSameSideFailures: 2,
  strategySource: "pine-ha",
};

const DEFAULT_MM = {
  mode: "run",
  positionPercent: 10,
  oneSlPercent: 1,
};

function normalizeRange({ from, lastDays = 31, to } = {}) {
  const toDate = to ? new Date(to) : new Date();
  const fromDate = from
    ? new Date(from)
    : new Date(toDate.getTime() - Math.max(1, Number(lastDays) || 31) * 24 * 60 * 60 * 1000);

  return {
    from: fromDate.toISOString(),
    to: toDate.toISOString(),
  };
}

function intervalMinutes(interval = "15m") {
  if (interval.endsWith("m")) return Number(interval.replace("m", ""));
  if (interval.endsWith("h")) return Number(interval.replace("h", "")) * 60;
  return 15;
}

function strategySettings(deck = {}, overrides = {}) {
  return {
    ...DEFAULT_STRATEGY,
    ...deck,
    ...overrides,
    atrLength: Number(overrides.atrLength ?? deck.atrLength ?? DEFAULT_STRATEGY.atrLength),
    atrMultiplier: Number(overrides.atrMultiplier ?? deck.atrMultiplier ?? DEFAULT_STRATEGY.atrMultiplier),
    bandwidth: Number(overrides.bandwidth ?? deck.bandwidth ?? DEFAULT_STRATEGY.bandwidth),
    envelopeMultiplier: Number(overrides.envelopeMultiplier ?? deck.envelopeMultiplier ?? DEFAULT_STRATEGY.envelopeMultiplier),
    maxSameSideFailures: Number(overrides.maxSameSideFailures ?? deck.maxSameSideFailures ?? DEFAULT_STRATEGY.maxSameSideFailures),
    strategySource: overrides.strategySource ?? deck.strategySource ?? DEFAULT_STRATEGY.strategySource,
  };
}

function selectedDecks(store, input = {}) {
  const strategyDecks = store.getCollection("strategyDecks") ?? [];
  const mmDecks = store.getCollection("mmDecks") ?? [];
  const battleDecks = store.getCollection("battleDecks") ?? [];
  const executionConfig = store.getExecutionConfig();
  const battleDeck =
    battleDecks.find((deck) => deck.id === input.battleDeckId) ??
    battleDecks.find((deck) => deck.id === executionConfig.activeBattleDeckId) ??
    battleDecks.at(-1) ??
    null;
  const strategyDeck =
    strategyDecks.find((deck) => deck.id === input.strategyDeckId) ??
    strategyDecks.find((deck) => deck.id === battleDeck?.strategyDeckId) ??
    battleDeck?.strategySnapshot ??
    strategyDecks.at(-1) ??
    DEFAULT_STRATEGY;
  const mmDeck =
    mmDecks.find((deck) => deck.id === input.mmDeckId) ??
    mmDecks.find((deck) => deck.id === battleDeck?.mmDeckId) ??
    battleDeck?.mmSnapshot ??
    mmDecks.at(-1) ??
    DEFAULT_MM;

  return { battleDeck, mmDeck, strategyDeck };
}

function sidePnl(trades = [], side) {
  return trades
    .filter((trade) => trade.direction === side)
    .reduce((sum, trade) => sum + Number(trade.netPnl ?? trade.pnl ?? 0), 0);
}

function summarizeBacktestResult(result, candles, range, provider, timeframe, symbol, settings) {
  return {
    ambiguity: result.ambiguity,
    ambiguousCandlesCount: result.ambiguousCandlesCount ?? result.ambiguity?.ambiguousCandlesCount ?? 0,
    candlesUsed: candles.length,
    conservativeAdjustedTrades: result.conservativeAdjustedTrades ?? result.ambiguity?.conservativeAdjustedTrades ?? 0,
    conservativeSkippedEntries: result.conservativeSkippedEntries ?? result.ambiguity?.conservativeSkippedEntries ?? 0,
    conclusion: backtestConclusion(result.metrics),
    diagnostics: {
      evaluatedSetupCount: result.diagnosticSummary?.evaluatedCandles ?? result.diagnosticSummary?.totalEvaluatedCandles ?? candles.length,
      setupCount: result.setupAudits?.length ?? result.setupAuditCount ?? 0,
    },
    longResult: sidePnl(result.trades, "LONG"),
    metrics: result.metrics,
    fillMode: result.fillMode ?? "legacy",
    provider,
    range,
    settings,
    shortResult: sidePnl(result.trades, "SHORT"),
    symbol,
    timeframe,
    trades: result.trades.slice(0, 100),
  };
}

function parseList(value, fallback, { integer = false, positive = false } = {}) {
  const source = Array.isArray(value) ? value : String(value ?? "").split(",");
  const parsed = source
    .map((item) => Number(String(item).trim()))
    .filter((item) => Number.isFinite(item))
    .map((item) => (integer ? Math.round(item) : item))
    .filter((item) => (!positive || item > 0));
  return parsed.length ? parsed : fallback;
}

function sweepScore(metrics, startingBalance) {
  const netPercent = startingBalance > 0 ? Number(metrics.netProfit ?? 0) / startingBalance * 100 : 0;
  const tradeBonus = Math.min(Number(metrics.totalTrades ?? 0), 40) * 0.04;
  const pfBonus = Math.min(Number(metrics.profitFactor ?? 0), 5);
  return netPercent - Number(metrics.maxDrawdown ?? 0) + tradeBonus + pfBonus;
}

export function createAiTools({
  buildAiContext,
  buildLivestreamPayload,
  calculateAnalytics,
  dataAvailability,
  memory,
  publicApiProfiles,
  publicStatusPayload,
  store,
}) {
  const libraryTools = createAiLibraryTools({ store });
  const platformTools = createAiPlatformAccess({
    buildLivestreamPayload,
    dataAvailability,
    publicApiProfiles,
    publicStatusPayload,
    store,
  });
  const candleCache = new Map();
  const maxCandleCacheEntries = Number(process.env.AI_CANDLE_CACHE_SIZE ?? 30);

  async function cachedCandles(input) {
    const key = JSON.stringify(input);
    if (candleCache.has(key)) {
      const cached = candleCache.get(key);
      candleCache.delete(key);
      candleCache.set(key, cached);
      return structuredClone(cached);
    }

    const candles = await fetchCandles(input);
    candleCache.set(key, structuredClone(candles));
    if (candleCache.size > maxCandleCacheEntries) {
      candleCache.delete(candleCache.keys().next().value);
    }
    return candles;
  }

  async function prepareHistoricalBacktest(input = {}) {
    const { mmDeck, strategyDeck } = selectedDecks(store, input);
    const symbol = String(input.symbol ?? strategyDeck.symbol ?? "SOLUSDT").toUpperCase();
    const timeframe = input.timeframe ?? strategyDeck.timeframe ?? "15m";
    const provider = input.provider ?? "binance-futures";
    const range = normalizeRange(input);
    const minutes = intervalMinutes(timeframe);
    const maxCandles = Math.min(90000, Math.max(600, Math.ceil((Date.parse(range.to) - Date.parse(range.from)) / (minutes * 60_000)) + 8));
    const candleRequest = {
      from: Math.floor(Date.parse(range.from) / 1000),
      limit: maxCandles,
      provider,
      symbol,
      timeframe,
      to: Math.floor(Date.parse(range.to) / 1000),
    };
    const candles = await cachedCandles(candleRequest);
    const settings = strategySettings(strategyDeck, input);
    const sizingMode = input.sizingMode ?? strategyDeck.sizingMode ?? (strategyDeck.atrPositionSizing ? "fixed-risk" : "position-percent");
    const fillMode = input.fillMode === "conservative" ? "conservative" : "legacy";
    const backtestConfig = {
      atrPositionSizing: sizingMode === "fixed-risk",
      commissionPercent: Number(input.commissionPercent ?? 0.04),
      fillMode,
      mmDeck: {
        ...DEFAULT_MM,
        ...mmDeck,
        ...(input.positionPercent ? { positionPercent: Number(input.positionPercent) } : {}),
        ...(input.riskPercent ? { oneSlPercent: Number(input.riskPercent) } : {}),
      },
      sizingMode,
      slippagePercent: Number(input.slippagePercent ?? 0),
      startingBalance: Number(input.startingBalance ?? 10000),
    };

    return {
      backtestConfig,
      candles,
      provider,
      range,
      settings,
      symbol,
      timeframe,
    };
  }

  async function runHistoricalBacktest(input = {}) {
    const {
      backtestConfig,
      candles,
      provider,
      range,
      settings,
      symbol,
      timeframe,
    } = await prepareHistoricalBacktest(input);
    const result = runBacktest({
      backtestConfig,
      rawCandles: candles,
      settings,
    });

    return summarizeBacktestResult(result, candles, range, provider, timeframe, symbol, settings);
  }

  async function runSweepAnalysis(input = {}) {
    const maxCombinations = Math.min(Number(input.maxCombinations ?? 100), 500);
    const bandwidths = parseList(input.bandwidthValues ?? input.bandwidths, [8], { positive: true });
    const nwes = parseList(input.envelopeMultiplierValues ?? input.nweValues, [3], { positive: true });
    const atrMultipliers = parseList(input.atrMultiplierValues ?? input.atrMultipliers, [1.2], { positive: true });
    const maxFailures = parseList(input.maxSameSideFailuresValues ?? input.maxFailures, [2], { integer: true });
    const sizingValues = parseList(input.sizingValues, [input.sizingMode === "fixed-risk" ? 1 : 10], { positive: true });
    const combos = [];

    bandwidths.forEach((bandwidth) => {
      nwes.forEach((envelopeMultiplier) => {
        atrMultipliers.forEach((atrMultiplier) => {
          maxFailures.forEach((maxSameSideFailures) => {
            sizingValues.forEach((sizeValue) => {
              combos.push({ atrMultiplier, bandwidth, envelopeMultiplier, maxSameSideFailures, sizeValue });
            });
          });
        });
      });
    });

    if (combos.length > maxCombinations) {
      return {
        ok: false,
        message: `${combos.length} combinations requested. Reduce ranges or raise maxCombinations up to 500.`,
        requestedCombinations: combos.length,
      };
    }

    const rows = [];
    for (const [index, combo] of combos.entries()) {
      const sizingMode = input.sizingMode ?? "position-percent";
      const result = await runHistoricalBacktest({
        ...input,
        ...combo,
        positionPercent: sizingMode === "position-percent" ? combo.sizeValue : undefined,
        riskPercent: sizingMode === "fixed-risk" ? combo.sizeValue : undefined,
        sizingMode,
      });
      rows.push({
        id: `ai-sweep-${Date.now()}-${index}`,
        fillMode: result.fillMode ?? "legacy",
        metrics: result.metrics,
        params: {
          ...combo,
          fillMode: result.fillMode ?? "legacy",
          sizingMode,
        },
        score: sweepScore(result.metrics, Number(input.startingBalance ?? 10000)),
      });
    }

    rows.sort((left, right) => right.score - left.score);
    return {
      best: rows[0] ?? null,
      rankedResults: rows.slice(0, 20).map((row, index) => ({ ...row, rank: index + 1 })),
      totalCombinations: combos.length,
    };
  }

  return {
    async analyzePeriods(input = {}) {
      const periods = input.periods?.length
        ? input.periods
        : [
            { label: "recent", ...normalizeRange(input) },
          ];
      const results = [];

      for (const period of periods.slice(0, 12)) {
        results.push({
          label: period.label ?? `${period.from} to ${period.to}`,
          result: await runHistoricalBacktest({ ...input, from: period.from, to: period.to }),
        });
      }

      return {
        periods: results,
        summary: "Period analysis uses the existing backtest engine for each period and does not change strategy logic.",
      };
    },

    async analyzeTimeframes(input = {}) {
      const timeframes = input.timeframes ?? ["10m", "15m", "20m", "30m", "1h", "4h"];
      const results = [];

      for (const timeframe of timeframes.slice(0, 6)) {
        results.push({
          timeframe,
          result: await runHistoricalBacktest({ ...input, timeframe }),
        });
      }

      const best = results
        .slice()
        .sort((left, right) => Number(right.result.metrics?.netProfit ?? 0) - Number(left.result.metrics?.netProfit ?? 0))[0];

      return {
        bestTimeframe: best?.timeframe ?? null,
        results,
        warning: "Timeframe recommendations depend heavily on the selected period and sample size.",
      };
    },

    async compareBacktests(input = {}) {
      const ids = input.ids ?? input.names ?? [];
      const resolved = ids.length
        ? ids
            .map((idOrName) => libraryTools.getBacktestDetail(idOrName))
            .filter((item) => item.ok)
        : (store.getCollection("backtests") ?? []).slice(-4).map((item) => libraryTools.getBacktestDetail(item.id)).filter((item) => item.ok);
      const source = resolved.map((detail) => ({
        id: detail.id,
        metrics: detail.metrics,
        name: detail.name,
        trades: detail.trades,
      }));
      const rows = source.map((item) => ({
        id: item.id,
        maxDrawdown: item.metrics?.maxDrawdown ?? 0,
        name: item.name,
        netProfit: item.metrics?.netProfit ?? 0,
        profitFactor: item.metrics?.profitFactor ?? 0,
        totalTrades: item.metrics?.totalTrades ?? item.trades?.length ?? 0,
        winRate: item.metrics?.winRate ?? 0,
      }));

      return {
        bestByDrawdown: rows.slice().sort((left, right) => left.maxDrawdown - right.maxDrawdown)[0] ?? null,
        bestByNetProfit: rows.slice().sort((left, right) => right.netProfit - left.netProfit)[0] ?? null,
        bestByWinRate: rows.slice().sort((left, right) => right.winRate - left.winRate)[0] ?? null,
        rows,
      };
    },

    async createAlertDraft(input = {}) {
      return memory.saveAlertDraft({
        condition: input.condition ?? "live data stale over 60 seconds",
        name: input.name ?? `AI Alert Draft ${new Date().toLocaleString()}`,
        source: input.source ?? "live data",
        symbol: input.symbol ?? "SOLUSDT",
        timeframe: input.timeframe ?? "15m",
      });
    },

    async diagnoseIssue(input = {}) {
      const logs = store.getLogs().slice(-40);
      const status = publicStatusPayload();
      return {
        affectedFiles: [
          "backend/src/index.js",
          "hubert-platform/frontend/src/components/ControlCenter.jsx",
        ],
        likelyCause: status.state?.lastError || logs.at(-1)?.message || "No active backend error is recorded.",
        nextSteps: [
          "Refresh System status.",
          "Check recent logs for the first error before repeated follow-up errors.",
          "Verify data provider diagnostics before changing strategy settings.",
        ],
        question: input.question ?? "",
        recentLogs: logs,
      };
    },

    async explainCurrentSetup() {
      const context = await buildAiContext({ includeBacktests: true, includeDecks: true, includeLivePositions: true, includeSystemStatus: true });
      return {
        selectedSetup: context.selectedSetup,
        summary: "Current setup combines the selected Strategy Deck, MM Deck, Battle Deck, data provider, and live account status. It is analysis-only here.",
      };
    },

    async exportReport(input = {}) {
      const type = input.type ?? "backtest";
      const latestBacktest = (store.getCollection("backtests") ?? []).at(-1);
      const report = type === "sweep"
        ? buildSweepReport(input.rows ?? [])
        : buildBacktestSummaryReport(input.result ?? latestBacktest ?? {});
      const saved = await memory.saveReport({
        ...report,
        format: input.format ?? "json",
        name: input.name ?? report.title,
      });

      return {
        format: input.format ?? "json",
        report: saved,
      };
    },

    async getPlatformStatus() {
      const profiles = await publicApiProfiles().catch(() => []);
      return {
        availability: await dataAvailability().catch(() => []),
        live: buildLivestreamPayload(profiles),
        status: publicStatusPayload(),
      };
    },

    getBacktestDetail: libraryTools.getBacktestDetail,
    getLibraryItemDetail: libraryTools.getLibraryItemDetail,
    ...platformTools,

    prepareHistoricalBacktest,
    resolveLibraryItem: libraryTools.resolveLibraryItem,
    runHistoricalBacktest,
    runSweepAnalysis,

    async optimizeSettings(input = {}) {
      const sweep = await runSweepAnalysis({
        ...input,
        maxCombinations: Math.min(Number(input.maxCombinations ?? 100), 200),
      });
      return {
        objective: input.objective ?? "drawdown-adjusted return",
        overfittingWarning: "Optimization can overfit. Re-test the selected row on different dates and neighboring settings.",
        recommendation: sweep.best,
        rankedAlternatives: sweep.rankedResults ?? [],
      };
    },

    async summarizeBacktest(input = {}) {
      const result = input.result ?? (store.getCollection("backtests") ?? []).at(-1);
      return buildBacktestSummaryReport(result ?? {});
    },
  };
}
