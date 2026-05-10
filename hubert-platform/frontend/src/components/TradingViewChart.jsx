import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  CrosshairMode,
  LineSeries,
  createChart,
  createSeriesMarkers,
} from "lightweight-charts";
import { createSolKlineSocket, fetchSolKlines } from "../api/binance";
import {
  STRATEGY_EVENT_TYPES,
  evaluateChoromanskiStrategy,
  filterStrategyEvents,
  toStrategyMarkers,
} from "../engine/strategyEngine";
import { toHeikenAshi } from "../indicators/heikenAshi";
import { calculateNadarayaEnvelope, toLineData } from "../indicators/nadaraya";
import ControlCenter from "./ControlCenter";
import {
  PLATFORM_STORAGE_KEY,
  readPlatformState,
  writeStoredJson,
} from "../utils/persistence";
import "../styles/chart.css";

const timeframes = [
  { label: "10m", interval: "10m" },
  { label: "15m", interval: "15m" },
  { label: "20m", interval: "20m" },
  { label: "30m", interval: "30m" },
  { label: "1H", interval: "1h" },
  { label: "4H", interval: "4h" },
];
const toolButtons = [
  "System",
  "Livestream",
  "Indicator",
  "Strategy Decks",
  "Backtests",
  "Compare",
  "MM Decks",
  "Decision",
  "Battle Decks",
  "Execution",
  "Crisis",
  "Analytics",
  "Communication",
  "AI",
  "Favorites",
];
const defaultSettings = {
  strategySource: "pine-ha",
  bandwidth: 8,
  envelopeMultiplier: 3,
  atrLength: 14,
  atrMultiplier: 1.2,
  maxSameSideFailures: 2,
  historyDays: 31,
  historyLimit: 3000,
  showBands: true,
  showEntries: true,
  showBenchmarks: false,
  showNegated: false,
  showSl: true,
  showTrigger: false,
};
const MAX_BACKTEST_CHART_MARKERS = 500;
const MAX_BACKTEST_DEBUG_MARKERS = 80;
const MAX_STRATEGY_LINE_EVENTS = 220;
const defaultBacktestOverlaySettings = {
  showDebug: false,
  showExits: true,
  showPnlLabels: true,
  showSlTp: true,
  showTrades: true,
};

function formatMeasurementValue(value) {
  const prefix = value > 0 ? "+" : "";

  return `${prefix}${value.toFixed(2)}`;
}

function getBarIndex(time, candles) {
  if (time === null) {
    return null;
  }

  return candles.findIndex((candle) => candle.time === time);
}

function formatChartPrice(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : "--";
}

function formatChartPnl(value) {
  if (!Number.isFinite(Number(value))) return "";
  const prefix = Number(value) > 0 ? "+" : "";

  return `${prefix}${Number(value).toFixed(2)}`;
}

function formatChartTime(value) {
  if (!value) return "--";

  return new Date(Number(value) * 1000).toLocaleString();
}

function compactReason(reason = "") {
  const normalized = String(reason).toLowerCase();

  if (normalized.includes("limiter")) return "SL limiter";
  if (normalized.includes("ha")) return "HA missing";
  if (normalized.includes("position")) return "In position";
  if (normalized.includes("sizing") || normalized.includes("mm")) return "MM invalid";
  if (normalized.includes("history")) return "Missing data";
  if (normalized.includes("band")) return "Band missing";

  return "Candidate";
}

function rangeFromCandles(candles = []) {
  return {
    from: candles[0]?.time ?? null,
    to: candles.at(-1)?.time ?? null,
  };
}

function filterCandlesByRange(candles = [], range = {}) {
  if (!range.from && !range.to) return candles;

  return candles.filter((candle) => {
    const afterStart = !range.from || candle.time >= range.from;
    const beforeEnd = !range.to || candle.time <= range.to;

    return afterStart && beforeEnd;
  });
}

function candleTimeSet(candles = []) {
  return new Set(candles.map((candle) => candle.time));
}

function isRenderableTrade(trade, times) {
  return Boolean(trade?.entryTime && (!times || times.has(trade.entryTime)));
}

function renderedTradeCount(result, candles = [], overlaySettings = defaultBacktestOverlaySettings) {
  if (!result || !overlaySettings.showTrades) return 0;
  const times = candles.length ? candleTimeSet(candles) : null;

  return (result.trades ?? [])
    .slice(-MAX_BACKTEST_CHART_MARKERS)
    .filter((trade) => isRenderableTrade(trade, times))
    .length;
}

function toBacktestAnalysisMarkers(result, overlaySettings = defaultBacktestOverlaySettings, candles = []) {
  if (!result) return [];
  const times = candles.length ? candleTimeSet(candles) : null;

  const tradeMarkers = overlaySettings.showTrades
    ? (result.trades ?? [])
      .slice(-MAX_BACKTEST_CHART_MARKERS)
      .filter((trade) => isRenderableTrade(trade, times))
      .flatMap((trade, index) => {
        const side = trade.direction === "LONG" ? "LONG" : "SHORT";
        const entryText = overlaySettings.showPnlLabels
          ? `${side} ${formatChartPrice(trade.entryPrice)}`
          : side;
        const exitReason = trade.exitReason ?? "EXIT";
        const exitText = overlaySettings.showPnlLabels
          ? `${exitReason} ${formatChartPnl(trade.netPnl)}`
          : exitReason;
        const markers = [
          {
            color: trade.direction === "LONG" ? "#f5f5f5" : "#050505",
            id: `analysis-entry-${trade.setupId ?? index}`,
            position: trade.direction === "LONG" ? "belowBar" : "aboveBar",
            shape: trade.direction === "LONG" ? "arrowUp" : "arrowDown",
            size: 1.12,
            text: entryText,
            time: trade.entryTime,
          },
        ];

        if (overlaySettings.showExits) {
          markers.push({
            color: "rgba(110, 20, 20, 0.78)",
            id: `analysis-exit-${trade.setupId ?? index}`,
            position: trade.direction === "LONG" ? "aboveBar" : "belowBar",
            shape: "square",
            size: 0.72,
            text: exitText,
            time: trade.exitTime,
          });
        }

        return markers;
      })
    : [];

  if (!overlaySettings.showDebug) {
    return tradeMarkers;
  }

  const debugMarkers = (result.diagnosticEvents ?? [])
    .filter((event) => !event.tradeOpened && event.reason && (event.bandTouchCondition || event.setupId))
    .slice(-MAX_BACKTEST_DEBUG_MARKERS)
    .map((event, index) => ({
      color: "rgba(44, 44, 44, 0.5)",
      id: `analysis-debug-${event.setupId ?? event.index}-${index}`,
      position: "inBar",
      shape: "circle",
      size: 0.36,
      text: compactReason(event.reason),
      time: event.candleTime,
    }));

  return [...debugMarkers, ...tradeMarkers];
}

function historyDaysToLimit(interval, days) {
  const minutesByInterval = {
    "10m": 10,
    "15m": 15,
    "20m": 20,
    "30m": 30,
    "1h": 60,
    "4h": 240,
  };
  const minutes = minutesByInterval[interval] ?? 15;
  const requested = Math.ceil(Number(days || 31) * 1440 / minutes);
  const maxLimit = interval === "4h" ? 5000 : 10000;

  return Math.max(100, Math.min(maxLimit, requested));
}

function toIncrementalHeikenAshi(rawCandle, previousHa) {
  const close = (rawCandle.open + rawCandle.high + rawCandle.low + rawCandle.close) / 4;
  const open = previousHa
    ? (previousHa.open + previousHa.close) / 2
    : (rawCandle.open + rawCandle.close) / 2;

  return {
    close,
    high: Math.max(rawCandle.high, open, close),
    low: Math.min(rawCandle.low, open, close),
    open,
    time: rawCandle.time,
  };
}

export default function TradingViewChart() {
  const [persistedState] = useState(readPlatformState);
  const chartContainerRef = useRef(null);
  const importInputRef = useRef(null);
  const chartRef = useRef(null);
  const candleSeriesRef = useRef(null);
  const upperSeriesRef = useRef(null);
  const lowerSeriesRef = useRef(null);
  const realPriceSeriesRef = useRef(null);
  const strategyMarkersRef = useRef(null);
  const strategyLineSeriesRef = useRef([]);
  const strategyCacheRef = useRef({ key: "", events: [] });
  const heikenAshiCacheRef = useRef([]);
  const pendingLiveCandlesRef = useRef(null);
  const liveRenderFrameRef = useRef(0);
  const analysisModeRef = useRef(false);
  const rawCandlesRef = useRef([]);
  const fitAfterRenderRef = useRef(false);
  const requestIdRef = useRef(0);
  const [selectedInterval, setSelectedInterval] = useState(
    persistedState.chartTimeframe ?? "15m",
  );
  const [rawCandles, setRawCandlesState] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [settings, setSettings] = useState({
    ...defaultSettings,
    ...(persistedState.indicatorSettings ?? {}),
  });
  const [settingsPanel, setSettingsPanel] = useState(null);
  const [activeBacktestSession, setActiveBacktestSession] = useState(null);
  const [backtestAnalysisActive, setBacktestAnalysisActive] = useState(false);
  const [backtestOverlaySettings, setBacktestOverlaySettings] = useState(defaultBacktestOverlaySettings);
  const [saveStatus, setSaveStatus] = useState({
    state: "Saved",
    lastSavedAt: persistedState.lastSavedAt ?? null,
  });
  const [measurementActive, setMeasurementActive] = useState(false);
  const [measurement, setMeasurement] = useState({
    start: null,
    end: null,
  });
  const [measurementView, setMeasurementView] = useState(null);
  const historyLimit = useMemo(
    () => historyDaysToLimit(selectedInterval, settings.historyDays ?? settings.historyLimit),
    [selectedInterval, settings.historyDays, settings.historyLimit],
  );
  const activeAnalysisSession = backtestAnalysisActive ? activeBacktestSession : null;

  useEffect(() => {
    analysisModeRef.current = Boolean(activeAnalysisSession);
  }, [activeAnalysisSession]);

  const projectMeasurementPoint = useCallback((point) => {
    if (!point || !chartRef.current || !realPriceSeriesRef.current) {
      return null;
    }

    const x = chartRef.current.timeScale().timeToCoordinate(point.time);
    const y = realPriceSeriesRef.current.priceToCoordinate(point.price);

    if (x === null || y === null) {
      return null;
    }

    return {
      ...point,
      x,
      y,
    };
  }, []);

  const refreshMeasurementView = useCallback(
    (nextMeasurement = measurement) => {
      const start = projectMeasurementPoint(nextMeasurement.start);
      const end = projectMeasurementPoint(nextMeasurement.end);

      if (!start) {
        setMeasurementView(null);
        return;
      }

      setMeasurementView({
        start,
        end,
      });
    },
    [measurement, projectMeasurementPoint],
  );

  function resetMeasurement() {
    setMeasurement({
      start: null,
      end: null,
    });
    setMeasurementView(null);
  }

  function toggleMeasurementTool(event) {
    event.stopPropagation();
    setMeasurementActive((currentValue) => {
      if (currentValue) {
        resetMeasurement();
        return false;
      }

      resetMeasurement();
      return true;
    });
  }

  function handleChartClick(event) {
    if (!measurementActive || !chartRef.current || !realPriceSeriesRef.current) {
      return;
    }

    const bounds = chartContainerRef.current?.getBoundingClientRect();

    if (!bounds) {
      return;
    }

    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    const price = realPriceSeriesRef.current.coordinateToPrice(y);
    const time = chartRef.current.timeScale().coordinateToTime(x);

    if (price === null || time === null) {
      return;
    }

    const point = {
      price: Number(price),
      time,
      index: getBarIndex(time, rawCandlesRef.current),
    };

    setMeasurement((currentMeasurement) => {
      const nextMeasurement =
        !currentMeasurement.start || currentMeasurement.end
          ? { start: point, end: null }
          : { start: currentMeasurement.start, end: point };

      refreshMeasurementView(nextMeasurement);
      return nextMeasurement;
    });
  }

  function updateSetting(key, value) {
    setSaveStatus((currentStatus) => ({
      ...currentStatus,
      state: "Unsaved changes",
    }));
    setSettings((currentSettings) => ({
      ...currentSettings,
      [key]: value,
    }));
  }

  function updateSelectedInterval(interval) {
    setSaveStatus((currentStatus) => ({
      ...currentStatus,
      state: "Unsaved changes",
    }));
    setSelectedInterval(interval);
  }

  function handleBacktestResult(result, context = {}) {
    if (!result) {
      setActiveBacktestSession(null);
      setBacktestAnalysisActive(false);
      fitAfterRenderRef.current = true;
      return;
    }

    const analysisCandles = context.candles?.length
      ? context.candles
      : filterCandlesByRange(rawCandlesRef.current, result.analysisRange);
    const session = {
      candles: analysisCandles,
      createdAt: new Date().toISOString(),
      id: result.id ?? `analysis-${Date.now()}`,
      mmDeckName: context.mmDeckName ?? result.mmDeckName ?? "No MM deck",
      range: context.range ?? result.analysisRange ?? rangeFromCandles(analysisCandles),
      result,
      settings: context.settings ?? result.analysisSettings ?? settings,
      strategyDeckName: context.strategyDeckName ?? result.strategyDeckName ?? "Strategy Deck",
      timeframe: context.timeframe ?? result.timeframe ?? selectedInterval,
    };

    setActiveBacktestSession(session);
    setBacktestAnalysisActive(true);
    fitAfterRenderRef.current = true;
  }

  function analyzeBacktestOnChart() {
    if (!activeBacktestSession) return;
    setBacktestAnalysisActive(true);
    fitAfterRenderRef.current = true;
  }

  function exitBacktestAnalysis() {
    setActiveBacktestSession(null);
    setBacktestAnalysisActive(false);
    fitAfterRenderRef.current = true;
    clearStrategyLines();
  }

  function buildExportState() {
    return {
      chartTimeframe: selectedInterval,
      exportedAt: new Date().toISOString(),
      indicatorSettings: settings,
      lastSavedAt: saveStatus.lastSavedAt,
      version: 1,
    };
  }

  function exportConfig() {
    const blob = new Blob([JSON.stringify(buildExportState(), null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `choromanski-config-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function importConfig(event) {
    const [file] = event.target.files ?? [];

    if (!file) {
      return;
    }

    const imported = JSON.parse(await file.text());

    if (imported.chartTimeframe) setSelectedInterval(imported.chartTimeframe);
    if (imported.indicatorSettings) {
      setSettings({ ...defaultSettings, ...imported.indicatorSettings });
    }
    setSaveStatus({ state: "Unsaved changes", lastSavedAt: saveStatus.lastSavedAt });
    event.target.value = "";
  }

  function applyStrategyConfigToChart(config) {
    setSettings((currentSettings) => ({
      ...currentSettings,
      atrLength: config.atrLength ?? currentSettings.atrLength,
      atrMultiplier: config.atrMultiplier ?? currentSettings.atrMultiplier,
      bandwidth: config.bandwidth ?? currentSettings.bandwidth,
      envelopeMultiplier: config.envelopeMultiplier ?? currentSettings.envelopeMultiplier,
      maxSameSideFailures: config.maxSameSideFailures ?? currentSettings.maxSameSideFailures,
      strategySource: config.strategySource ?? currentSettings.strategySource,
    }));
  }

  function resetChartView() {
    chartRef.current?.priceScale("right").applyOptions({
      scaleMargins: {
        top: 0.08,
        bottom: 0.08,
      },
    });
    chartRef.current?.timeScale().scrollToRealTime();
    chartRef.current?.timeScale().fitContent();
    resetMeasurement();
  }

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const lastSavedAt = new Date().toISOString();
      writeStoredJson(PLATFORM_STORAGE_KEY, {
        chartTimeframe: selectedInterval,
        indicatorSettings: settings,
        lastSavedAt,
        version: 1,
      });
      setSaveStatus({ state: "Saved", lastSavedAt });
    }, 350);

    return () => window.clearTimeout(timeoutId);
  }, [selectedInterval, settings]);

  const clearStrategyLines = useCallback(() => {
    if (!chartRef.current) {
      strategyLineSeriesRef.current = [];
      return;
    }

    strategyLineSeriesRef.current.forEach((series) => {
      chartRef.current?.removeSeries(series);
    });
    strategyLineSeriesRef.current = [];
  }, []);

  const addStrategySegment = useCallback(({ color, lineStyle = 0, lineWidth = 1, value, startTime, endTime, showLabel }) => {
    if (!chartRef.current) {
      return;
    }

    const lineSeries = chartRef.current.addSeries(LineSeries, {
      color,
      lineWidth,
      lineStyle,
      priceLineVisible: false,
      lastValueVisible: showLabel,
      crosshairMarkerVisible: false,
      priceFormat: {
        type: "price",
        precision: 2,
        minMove: 0.01,
      },
    });

    lineSeries.setData([
      { time: startTime, value },
      { time: endTime, value },
    ]);
    strategyLineSeriesRef.current.push(lineSeries);
  }, []);

  const renderStrategyLines = useCallback(
    (events, candles) => {
      clearStrategyLines();

      if (!settings.showSl && !settings.showTrigger) {
        return;
      }

      events
        .filter(
          (event) =>
            event.type === STRATEGY_EVENT_TYPES.ENTRY_TRIGGERED ||
            (event.type === STRATEGY_EVENT_TYPES.SETUP_ACTIVE && settings.showBenchmarks) ||
            (event.type === STRATEGY_EVENT_TYPES.SETUP_INVALIDATED && settings.showNegated),
        )
        .slice(-MAX_STRATEGY_LINE_EVENTS)
        .forEach((event) => {
          if (!Number.isFinite(event.trigger) || !Number.isFinite(event.stopLoss)) {
            return;
          }

          const startIndex = event.benchmarkIndex ?? event.index;
          const triggerEndIndex = Math.min(startIndex + 6, candles.length - 1);
          const stopEndIndex = Math.min(startIndex + 8, candles.length - 1);
          const triggerEndTime = candles[triggerEndIndex]?.time ?? event.time;
          const stopEndTime = candles[stopEndIndex]?.time ?? event.time;
          const triggerColor = event.direction === "LONG" ? "#f5f5f5" : "#050505";
          const startTime = event.benchmarkTime ?? event.time;

          if (settings.showTrigger) {
            addStrategySegment({
              color: triggerColor,
              lineWidth: 1,
              value: event.trigger,
              startTime,
              endTime: triggerEndTime,
              showLabel: false,
            });
          }

          if (settings.showSl) {
            addStrategySegment({
              color: "rgba(120, 24, 24, 0.72)",
              lineStyle: 2,
              lineWidth: 1,
              value: event.stopLoss,
              startTime,
              endTime: stopEndTime,
              showLabel: true,
            });
          }
        });
    },
    [
      addStrategySegment,
      clearStrategyLines,
      settings.showSl,
      settings.showBenchmarks,
      settings.showNegated,
      settings.showTrigger,
    ],
  );

  const renderBacktestLines = useCallback(
    (result, overlaySettings) => {
      clearStrategyLines();

      if (!overlaySettings.showSlTp) {
        return;
      }

      (result?.trades ?? [])
        .filter((trade) => Number.isFinite(Number(trade.stopLoss)) || Number.isFinite(Number(trade.takeProfit)))
        .slice(-MAX_STRATEGY_LINE_EVENTS)
        .forEach((trade) => {
          const startTime = trade.entryTime;
          const endTime = trade.exitTime ?? trade.entryTime;

          if (Number.isFinite(Number(trade.stopLoss))) {
            addStrategySegment({
              color: "rgba(120, 24, 24, 0.72)",
              endTime,
              lineStyle: 2,
              lineWidth: 1,
              showLabel: true,
              startTime,
              value: Number(trade.stopLoss),
            });
          }

          if (Number.isFinite(Number(trade.takeProfit))) {
            addStrategySegment({
              color: "rgba(245, 245, 245, 0.78)",
              endTime,
              lineStyle: 2,
              lineWidth: 1,
              showLabel: true,
              startTime,
              value: Number(trade.takeProfit),
            });
          }
        });
    },
    [addStrategySegment, clearStrategyLines],
  );

  const renderMarket = useCallback(
    (candles, shouldFitContent = false, mode = {}) => {
      if (!candleSeriesRef.current || !realPriceSeriesRef.current) {
        return;
      }

      const renderSettings = mode.settings ?? settings;
      const heikenAshiCandles = toHeikenAshi(candles);
      const indicatorCandles =
        renderSettings.strategySource === "raw-exchange" ? candles : heikenAshiCandles;
      const envelope = calculateNadarayaEnvelope(indicatorCandles, {
        bandwidth: renderSettings.bandwidth,
        multiplier: renderSettings.envelopeMultiplier,
      });
      const realPriceLine = candles.map((candle) => ({
        time: candle.time,
        value: candle.close,
      }));

      heikenAshiCacheRef.current = heikenAshiCandles;
      candleSeriesRef.current.setData(heikenAshiCandles);
      upperSeriesRef.current?.setData(renderSettings.showBands ? toLineData(envelope, "upper") : []);
      lowerSeriesRef.current?.setData(renderSettings.showBands ? toLineData(envelope, "lower") : []);
      realPriceSeriesRef.current.setData(realPriceLine);

      if (mode.analysisResult) {
        strategyMarkersRef.current?.setMarkers(toBacktestAnalysisMarkers(mode.analysisResult, mode.overlaySettings, candles));
        renderBacktestLines(mode.analysisResult, mode.overlaySettings);
      } else {
        const closedCandles = candles.filter((candle) => candle.isClosed !== false);
        const closedHeikenAshiCandles = toHeikenAshi(closedCandles);
        const strategyCandles =
          renderSettings.strategySource === "raw-exchange" ? closedCandles : closedHeikenAshiCandles;
        const closedEnvelope = calculateNadarayaEnvelope(strategyCandles, {
          bandwidth: renderSettings.bandwidth,
          multiplier: renderSettings.envelopeMultiplier,
        });
        const lastClosedCandle = closedCandles[closedCandles.length - 1];
        const strategyKey = [
          closedCandles.length,
          lastClosedCandle?.time ?? 0,
          renderSettings.bandwidth,
          renderSettings.envelopeMultiplier,
          renderSettings.atrLength,
          renderSettings.atrMultiplier,
          renderSettings.maxSameSideFailures,
          renderSettings.strategySource,
        ].join(":");
        let strategyEvents = strategyCacheRef.current.events;

        if (strategyCacheRef.current.key !== strategyKey) {
          const strategyResult = evaluateChoromanskiStrategy({
            sourceCandles: strategyCandles,
            envelope: closedEnvelope,
            inputs: {
              atrLength: renderSettings.atrLength,
              atrMultiplier: renderSettings.atrMultiplier,
              maxSameSideFailures: renderSettings.maxSameSideFailures,
            },
          });
          strategyCacheRef.current = {
            key: strategyKey,
            events: strategyResult.events,
          };
          strategyEvents = strategyResult.events;
          globalThis.__CHOROMANSKI_DEBUG_EXPORT__ = strategyResult.debugRows;
          globalThis.__CHOROMANSKI_SETUP_AUDIT__ = strategyResult.setupAudits;
          console.debug("Choromanski debug export available at window.__CHOROMANSKI_DEBUG_EXPORT__");
          console.debug("Choromanski setup audit available at window.__CHOROMANSKI_SETUP_AUDIT__");
        }

        const markerEvents = filterStrategyEvents(strategyEvents, renderSettings);

        strategyMarkersRef.current?.setMarkers(toStrategyMarkers(markerEvents));
        renderStrategyLines(strategyEvents, closedCandles);
      }

      if (shouldFitContent) {
        chartRef.current?.timeScale().fitContent();
      }
    },
    [renderBacktestLines, renderStrategyLines, settings],
  );

  const scheduleLiveCandleUpdate = useCallback((candles) => {
    if (analysisModeRef.current) {
      return;
    }

    pendingLiveCandlesRef.current = candles;

    if (liveRenderFrameRef.current) {
      return;
    }

    liveRenderFrameRef.current = window.requestAnimationFrame(() => {
      liveRenderFrameRef.current = 0;
      const nextCandles = pendingLiveCandlesRef.current;
      const latestRaw = nextCandles?.[nextCandles.length - 1];

      if (!latestRaw || !candleSeriesRef.current || !realPriceSeriesRef.current) {
        return;
      }

      const haCache = heikenAshiCacheRef.current;
      const previousHa = haCache[haCache.length - 2];
      const latestHa = toIncrementalHeikenAshi(latestRaw, previousHa);

      if (haCache.length === nextCandles.length) {
        haCache[haCache.length - 1] = latestHa;
      }

      candleSeriesRef.current.update(latestHa);
      realPriceSeriesRef.current.update({
        time: latestRaw.time,
        value: latestRaw.close,
      });
    });
  }, []);

  useEffect(() => {
    const container = chartContainerRef.current;

    if (!container) {
      return undefined;
    }

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { color: "#bdbdbd" },
        textColor: "#151515",
        fontFamily:
          "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        fontSize: 12,
      },
      grid: {
        vertLines: { color: "rgba(0, 0, 0, 0.08)" },
        horzLines: { color: "rgba(0, 0, 0, 0.075)" },
      },
      localization: {
        priceFormatter: (price) => price.toFixed(2),
      },
      rightPriceScale: {
        visible: true,
        borderVisible: true,
        borderColor: "rgba(0, 0, 0, 0.28)",
        entireTextOnly: true,
        scaleMargins: {
          top: 0.08,
          bottom: 0.08,
        },
      },
      leftPriceScale: {
        visible: false,
      },
      timeScale: {
        borderVisible: true,
        borderColor: "rgba(0, 0, 0, 0.28)",
        rightOffset: 8,
        barSpacing: 8.5,
        minBarSpacing: 2,
        timeVisible: true,
        secondsVisible: false,
        shiftVisibleRangeOnNewBar: false,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: "rgba(0, 0, 0, 0.42)",
          labelBackgroundColor: "#111111",
          style: 3,
          width: 1,
        },
        horzLine: {
          color: "rgba(0, 0, 0, 0.42)",
          labelBackgroundColor: "#111111",
          style: 3,
          width: 1,
        },
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: {
          time: true,
          price: true,
        },
        axisDoubleClickReset: {
          time: true,
          price: true,
        },
      },
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#f4f4f4",
      downColor: "#050505",
      borderUpColor: "#f4f4f4",
      borderDownColor: "#050505",
      wickUpColor: "#f4f4f4",
      wickDownColor: "#050505",
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: {
        type: "price",
        precision: 2,
        minMove: 0.01,
      },
    });

    const upperSeries = chart.addSeries(LineSeries, {
      color: "#f5f5f5",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const lowerSeries = chart.addSeries(LineSeries, {
      color: "#080808",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const realPriceSeries = chart.addSeries(LineSeries, {
      color: "rgba(0, 0, 0, 0)",
      lineWidth: 1,
      priceLineVisible: true,
      priceLineColor: "rgba(0, 0, 0, 0.68)",
      priceLineWidth: 1,
      lastValueVisible: true,
      crosshairMarkerVisible: false,
      priceFormat: {
        type: "price",
        precision: 2,
        minMove: 0.01,
      },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    upperSeriesRef.current = upperSeries;
    lowerSeriesRef.current = lowerSeries;
    realPriceSeriesRef.current = realPriceSeries;
    strategyMarkersRef.current = createSeriesMarkers(candleSeries, [], {
      zOrder: "top",
    });

    return () => {
      if (liveRenderFrameRef.current) {
        window.cancelAnimationFrame(liveRenderFrameRef.current);
        liveRenderFrameRef.current = 0;
      }
      clearStrategyLines();
      chartRef.current = null;
      candleSeriesRef.current = null;
      upperSeriesRef.current = null;
      lowerSeriesRef.current = null;
      realPriceSeriesRef.current = null;
      strategyMarkersRef.current = null;
      chart.remove();
    };
  }, [clearStrategyLines]);

  useEffect(() => {
    if (!chartRef.current) {
      return undefined;
    }

    const handleVisibleRangeChange = () => {
      refreshMeasurementView();
    };

    chartRef.current.timeScale().subscribeVisibleTimeRangeChange(handleVisibleRangeChange);

    return () => {
      chartRef.current?.timeScale().unsubscribeVisibleTimeRangeChange(handleVisibleRangeChange);
    };
  }, [refreshMeasurementView]);

  useEffect(() => {
    if (!measurement.start) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      refreshMeasurementView();
    }, 250);

    return () => window.clearInterval(intervalId);
  }, [measurement, refreshMeasurementView]);

  useEffect(() => {
    let ignore = false;
    let closeSocket = null;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    function setRawCandles(candles, shouldFitContent = false) {
      rawCandlesRef.current = candles;
      fitAfterRenderRef.current = shouldFitContent;
      setRawCandlesState(candles);
    }

    function updateRawCandle(nextCandle) {
      const currentCandles = rawCandlesRef.current;
      const lastCandle = currentCandles[currentCandles.length - 1];
      let updatedCandles = currentCandles;

      if (!lastCandle || nextCandle.time > lastCandle.time) {
        updatedCandles = [...currentCandles, nextCandle].slice(-historyLimit);
      } else if (nextCandle.time === lastCandle.time) {
        updatedCandles = [...currentCandles.slice(0, -1), nextCandle];
      }

      if (updatedCandles === currentCandles) {
        return;
      }

      rawCandlesRef.current = updatedCandles;

      if (nextCandle.isClosed || nextCandle.time > lastCandle?.time) {
        setRawCandles(updatedCandles);
        return;
      }

      scheduleLiveCandleUpdate(updatedCandles);
    }

    async function loadMarketData() {
      setIsLoading(true);
      setError("");

      try {
        const candles = await fetchSolKlines(selectedInterval, historyLimit);

        if (ignore || requestIdRef.current !== requestId) {
          return;
        }

        setRawCandles(candles, true);
        closeSocket = createSolKlineSocket(selectedInterval, {
          onCandle: (candle) => {
            if (ignore || requestIdRef.current !== requestId) {
              return;
            }

            updateRawCandle(candle);
          },
          onError: (socketError) => {
            if (!ignore) {
              setError(
                socketError instanceof Error
                  ? socketError.message
                  : "Binance websocket connection error.",
              );
            }
          },
        });
      } catch (loadError) {
        if (!ignore) {
          setError(loadError instanceof Error ? loadError.message : "Unable to load SOLUSDT data.");
        }
      } finally {
        if (!ignore) {
          setIsLoading(false);
        }
      }
    }

    loadMarketData();

    return () => {
      ignore = true;
      closeSocket?.();
    };
  }, [historyLimit, scheduleLiveCandleUpdate, selectedInterval]);

  useEffect(() => {
    if (activeAnalysisSession) {
      const analysisCandles = activeAnalysisSession.candles?.length
        ? activeAnalysisSession.candles
        : filterCandlesByRange(rawCandles, activeAnalysisSession.range);

      if (analysisCandles.length > 0) {
        renderMarket(analysisCandles, fitAfterRenderRef.current, {
          analysisResult: activeAnalysisSession.result,
          overlaySettings: backtestOverlaySettings,
          settings: activeAnalysisSession.settings,
        });
        fitAfterRenderRef.current = false;
      }
      return;
    }

    if (rawCandles.length > 0) {
      renderMarket(rawCandles, fitAfterRenderRef.current);
      fitAfterRenderRef.current = false;
    }
  }, [activeAnalysisSession, backtestOverlaySettings, rawCandles, renderMarket]);

  return (
    <main className="hubert-dashboard">
      <header className="hubert-toolbar" aria-label="Trading controls">
        <div className="hubert-toolbar__group">
          <button className="hubert-button hubert-button--symbol" type="button">
            SOLUSDT
          </button>

          {timeframes.map((timeframe) => (
            <button
              aria-pressed={selectedInterval === timeframe.interval}
              className="hubert-button"
              data-active={selectedInterval === timeframe.interval}
              key={timeframe.interval}
              onClick={() => updateSelectedInterval(timeframe.interval)}
              type="button"
            >
              {timeframe.label}
            </button>
          ))}
        </div>

        <div className="hubert-toolbar__group hubert-toolbar__group--tools">
          {toolButtons.map((label) => (
            <button
              className="hubert-button"
              data-active={settingsPanel === label}
              key={label}
              onClick={() => {
                setSettingsPanel((currentPanel) => (currentPanel === label ? null : label));
              }}
              type="button"
            >
              {label}
            </button>
          ))}
          <button className="hubert-button" onClick={exportConfig} type="button">
            Export
          </button>
          <button className="hubert-button" onClick={() => importInputRef.current?.click()} type="button">
            Import
          </button>
          <input
            accept="application/json"
            className="hubert-hidden-input"
            onChange={importConfig}
            ref={importInputRef}
            type="file"
          />
        </div>
      </header>

      <div className="hubert-save-status">
        <strong>{saveStatus.state}</strong>
        <span>{saveStatus.lastSavedAt ? `Last saved at ${new Date(saveStatus.lastSavedAt).toLocaleString()}` : "Autosave ready"}</span>
      </div>

      {settingsPanel && (
        <ControlCenter
          activePanel={settingsPanel}
          activeBacktestSession={activeBacktestSession}
          backtestAnalysisActive={backtestAnalysisActive}
          onApplyChart={applyStrategyConfigToChart}
          onAnalyzeBacktest={analyzeBacktestOnChart}
          onBacktestResult={handleBacktestResult}
          onClearBacktest={exitBacktestAnalysis}
          onClose={() => setSettingsPanel(null)}
          onExitBacktestAnalysis={exitBacktestAnalysis}
          rawCandles={rawCandles}
          selectedInterval={selectedInterval}
          setActivePanel={setSettingsPanel}
          setSelectedInterval={updateSelectedInterval}
          settings={settings}
          updateSetting={updateSetting}
        />
      )}

      <section className="hubert-brand" aria-label="Choromanski Trading Platform">
        <h1>Choromański</h1>
        <p>TRADING PLATFORM</p>
      </section>

      {activeAnalysisSession && (
        <BacktestAnalysisBanner
          overlaySettings={backtestOverlaySettings}
          session={activeAnalysisSession}
          onAnalyze={analyzeBacktestOnChart}
          onExit={exitBacktestAnalysis}
          onToggle={(key, value) =>
            setBacktestOverlaySettings((current) => ({
              ...current,
              [key]: value,
            }))
          }
        />
      )}

      <div className="hubert-chart" onClick={handleChartClick} ref={chartContainerRef} />

      {measurementView?.start && (
        <MeasurementOverlay measurementView={measurementView} />
      )}

      <button
        aria-pressed={measurementActive}
        className="hubert-ruler-tool"
        data-active={measurementActive}
        onClick={toggleMeasurementTool}
        type="button"
        aria-label="Ruler percent tool"
      >
        %
      </button>

      <button
        className="hubert-reset-tool"
        onClick={resetChartView}
        type="button"
        aria-label="Reset chart view"
      >
        R
      </button>

      {(isLoading || error) && (
        <div className="hubert-chart-state" role="status">
          {error || "Loading SOLUSDT Binance data"}
        </div>
      )}
    </main>
  );
}

function BacktestAnalysisBanner({ overlaySettings, session, onAnalyze, onExit, onToggle }) {
  const range = session.range ?? rangeFromCandles(session.candles);
  const tradeCount = session.result?.trades?.length ?? 0;
  const renderedCount = renderedTradeCount(session.result, session.candles, overlaySettings);
  const hasMismatch = overlaySettings.showTrades && renderedCount !== tradeCount;

  return (
    <aside className="hubert-backtest-banner" aria-label="Backtest Analysis Mode">
      <div className="hubert-backtest-banner__head">
        <div>
          <strong>Backtest Analysis Mode</strong>
          <span>
            {session.strategyDeckName} · {session.mmDeckName} · {session.timeframe} · {tradeCount} trades
          </span>
          <span>{formatChartTime(range.from)} → {formatChartTime(range.to)}</span>
          <span className={hasMismatch ? "hubert-backtest-banner__warning" : ""}>
            Trades in table: {tradeCount} · rendered on chart: {renderedCount}
          </span>
        </div>
        <div className="hubert-backtest-banner__actions">
          <button type="button" onClick={onAnalyze}>Analyze on Chart</button>
          <button type="button" onClick={onExit}>Exit Backtest Analysis</button>
        </div>
      </div>
      <div className="hubert-backtest-banner__toggles">
        {[
          ["showTrades", "Show trades"],
          ["showSlTp", "Show SL/TP"],
          ["showExits", "Show exits"],
          ["showDebug", "Show skipped setups/debug"],
          ["showPnlLabels", "Show PnL labels"],
        ].map(([key, label]) => (
          <label key={key}>
            <input
              checked={Boolean(overlaySettings[key])}
              type="checkbox"
              onChange={(event) => onToggle(key, event.target.checked)}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>
      {hasMismatch && (
        <div className="hubert-backtest-banner__warning">
          Chart markers are capped to keep zoom and pan responsive. The table remains the full record.
        </div>
      )}
      {overlaySettings.showDebug && (
        <div className="hubert-backtest-legend">
          <span><b />HA missing = Heikin Ashi confirmation missing</span>
          <span><b />Candidate = setup candidate checked</span>
          <span><b />In position = already in a trade/setup</span>
          <span><b />SL limiter = blocked by same-side SL limit</span>
          <span><b />MM invalid = sizing/money management invalid</span>
        </div>
      )}
    </aside>
  );
}

function MeasurementOverlay({ measurementView }) {
  const { start, end } = measurementView;
  const activeEnd = end ?? start;
  const delta = activeEnd.price - start.price;
  const percent = start.price === 0 ? 0 : (delta / start.price) * 100;
  const bars =
    start.index !== null && activeEnd.index !== null
      ? Math.abs(activeEnd.index - start.index)
      : null;
  const isRaise = delta >= 0;
  const color = isRaise ? "#f5f5f5" : "#050505";
  const labelX = Math.min(Math.max(activeEnd.x + 12, 12), window.innerWidth - 170);
  const labelY = Math.min(Math.max(activeEnd.y - 44, 12), window.innerHeight - 72);

  return (
    <svg className="hubert-measurement-overlay" aria-hidden="true">
      <line
        className="hubert-measurement-guide"
        x1={start.x}
        y1={start.y}
        x2={activeEnd.x}
        y2={start.y}
      />
      <line
        className="hubert-measurement-guide"
        x1={activeEnd.x}
        y1={start.y}
        x2={activeEnd.x}
        y2={activeEnd.y}
      />
      {end && (
        <line
          className="hubert-measurement-line"
          stroke={color}
          x1={start.x}
          y1={start.y}
          x2={end.x}
          y2={end.y}
        />
      )}
      <circle className="hubert-measurement-point" cx={start.x} cy={start.y} r="4" />
      {end && (
        <circle
          className="hubert-measurement-point"
          cx={end.x}
          cy={end.y}
          r="4"
          fill={color}
        />
      )}
      {end && (
        <foreignObject x={labelX} y={labelY} width="158" height="62">
          <div className="hubert-measurement-label">
            <strong>{formatMeasurementValue(delta)}</strong>
            <span>{formatMeasurementValue(percent)}%</span>
            <span>{bars === null ? "--" : `${bars} bars`}</span>
          </div>
        </foreignObject>
      )}
    </svg>
  );
}
