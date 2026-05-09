import { useEffect, useMemo, useState } from "react";
import { defaultBacktestConfig, runBacktest } from "../backtest/backtestEngine";
import { runOptimization } from "../backtest/optimizer";
import {
  readStrategyLabState,
  writeStoredJson,
  STRATEGY_LAB_STORAGE_KEY,
} from "../utils/persistence";

const timeframeOptions = [
  ["10m", "10m"],
  ["15m", "15m"],
  ["20m", "20m"],
  ["30m", "30m"],
  ["1H", "1h"],
  ["4H", "4h"],
];

const presets = {
  baseline: {
    atrLength: 14,
    atrMultiplier: 1.2,
    bandwidth: 8,
    envelopeMultiplier: 3,
    maxSameSideFailures: 2,
  },
  smooth: {
    atrLength: 21,
    atrMultiplier: 1.4,
    bandwidth: 10,
    envelopeMultiplier: 3.2,
    maxSameSideFailures: 2,
  },
  responsive: {
    atrLength: 10,
    atrMultiplier: 1,
    bandwidth: 6,
    envelopeMultiplier: 2.6,
    maxSameSideFailures: 2,
  },
};

function formatNumber(value, digits = 2) {
  if (value === Infinity) return "inf";

  return Number(value || 0).toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function formatTime(time) {
  if (!time) return "--";

  return new Date(time * 1000).toLocaleString(undefined, {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
  });
}

function pickStrategyConfig(settings) {
  return {
    atrLength: settings.atrLength,
    atrMultiplier: settings.atrMultiplier,
    bandwidth: settings.bandwidth,
    envelopeMultiplier: settings.envelopeMultiplier,
    maxSameSideFailures: settings.maxSameSideFailures,
    strategySource: settings.strategySource,
  };
}

function MetricGrid({ metrics }) {
  const items = [
    ["Net profit", metrics.netProfit],
    ["Profit factor", metrics.profitFactor],
    ["Max drawdown", metrics.maxDrawdown, "%"],
    ["Win rate", metrics.winRate, "%"],
    ["Trades", metrics.totalTrades, "", 0],
    ["Expectancy", metrics.expectancy],
  ];

  return (
    <div className="hubert-lab__metrics">
      {items.map(([label, value, suffix = "", digits = 2]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{formatNumber(value, digits)}{suffix}</strong>
        </div>
      ))}
    </div>
  );
}

function EquityCurve({ curve }) {
  const points = useMemo(() => {
    if (curve.length < 2) return "";

    const width = 520;
    const height = 120;
    const values = curve.map((point) => point.equity);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;

    return curve
      .map((point, index) => {
        const x = (index / (curve.length - 1)) * width;
        const y = height - ((point.equity - min) / span) * height;

        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [curve]);

  return (
    <svg className="hubert-lab__equity" viewBox="0 0 520 120" preserveAspectRatio="none">
      <polyline points={points} />
    </svg>
  );
}

function TradeTable({ trades }) {
  return (
    <div className="hubert-lab__table">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Side</th>
            <th>Entry</th>
            <th>Exit</th>
            <th>PnL</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {trades.slice(-80).map((trade, index) => (
            <tr key={`${trade.entryTime}-${trade.exitTime}-${index}`}>
              <td>{trades.length - Math.min(trades.length, 80) + index + 1}</td>
              <td>{trade.direction}</td>
              <td>{formatNumber(trade.entryPrice)}</td>
              <td>{formatNumber(trade.exitPrice)}</td>
              <td>{formatNumber(trade.netPnl)}</td>
              <td>{trade.exitReason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SetupAuditTable({ setups }) {
  return (
    <div className="hubert-lab__table hubert-lab__table--audit">
      <table>
        <thead>
          <tr>
            <th>Setup</th>
            <th>Side</th>
            <th>Band</th>
            <th>Benchmark</th>
            <th>Trigger</th>
            <th>SL</th>
            <th>Invalidated</th>
            <th>Entry</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {setups.slice(-80).map((setup) => (
            <tr key={setup.setupId}>
              <td>{setup.setupId}</td>
              <td>{setup.direction}</td>
              <td>{formatTime(setup.bandSignalTime)}</td>
              <td>{formatTime(setup.benchmarkTime)}</td>
              <td>{formatNumber(setup.triggerPrice)}</td>
              <td>{formatNumber(setup.slPrice)}</td>
              <td>{formatTime(setup.invalidationTime)}</td>
              <td>{formatTime(setup.entryTime)}</td>
              <td>{setup.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function StrategyLab({
  backtestResult,
  onApplyChart,
  onBacktestResult,
  onClose,
  onDeployExecution,
  rawCandles,
  selectedInterval,
  setSelectedInterval,
  settings,
  updateSetting,
}) {
  const persistedLabState = useMemo(() => readStrategyLabState(), []);
  const [advanced, setAdvanced] = useState(Boolean(persistedLabState.advanced));
  const [selectedPreset, setSelectedPreset] = useState(
    persistedLabState.selectedPreset ?? "baseline",
  );
  const [selectedConfig, setSelectedConfig] = useState(null);
  const [favorites, setFavorites] = useState(persistedLabState.favorites ?? []);
  const [compare, setCompare] = useState([]);
  const [backtestConfig, setBacktestConfig] = useState({
    ...defaultBacktestConfig,
    ...(persistedLabState.backtestConfig ?? {}),
  });
  const [optimizerRanges, setOptimizerRanges] = useState({
    atrLength: "10,14,21",
    atrMultiplier: "1,1.2,1.5",
    bandwidth: "6,8,10",
    envelopeMultiplier: "2.5,3,3.5",
    ...(persistedLabState.optimizerRanges ?? {}),
  });
  const [optimizationResults, setOptimizationResults] = useState([]);

  const activeConfig = selectedConfig ?? pickStrategyConfig(settings);

  function updateBacktestConfig(key, value) {
    setBacktestConfig((currentConfig) => ({ ...currentConfig, [key]: value }));
  }

  useEffect(() => {
    writeStoredJson(STRATEGY_LAB_STORAGE_KEY, {
      advanced,
      backtestConfig,
      favorites,
      optimizerRanges,
      selectedPreset,
    });
  }, [advanced, backtestConfig, favorites, optimizerRanges, selectedPreset]);

  function applyPreset(key) {
    setSelectedPreset(key);
    Object.entries(presets[key]).forEach(([settingKey, value]) => updateSetting(settingKey, value));
  }

  function runCurrentBacktest() {
    const result = runBacktest({ backtestConfig, rawCandles, settings });

    globalThis.__CHOROMANSKI_BACKTEST_SETUP_AUDIT__ = result.setupAudits;
    onBacktestResult(result);
  }

  function runSweep() {
    const results = runOptimization({
      backtestConfig,
      rawCandles,
      ranges: optimizerRanges,
      settings,
    });

    setOptimizationResults(results);
    setSelectedConfig(results[0] ? { ...pickStrategyConfig(settings), ...results[0] } : null);
  }

  function saveFavorite(config = activeConfig) {
    const name = `Config ${favorites.length + 1}`;
    setFavorites((currentFavorites) => [
      ...currentFavorites,
      {
        ...config,
        id: `${Date.now()}-${favorites.length}`,
        name,
      },
    ]);
  }

  function applyConfigToChart(config) {
    onApplyChart(config);
    setSelectedConfig(config);
  }

  function toggleCompare(config) {
    setCompare((currentCompare) => {
      const exists = currentCompare.some((item) => item.id === config.id);

      if (exists) {
        return currentCompare.filter((item) => item.id !== config.id);
      }

      return [...currentCompare, config].slice(-3);
    });
  }

  return (
    <aside className="hubert-lab" aria-label="Strategy Lab">
      <div className="hubert-lab__header">
        <strong>Strategy Lab</strong>
        <span>{rawCandles.length} candles loaded</span>
        <button type="button" onClick={onClose}>Close</button>
      </div>

      <div className="hubert-lab__tabs">
        <button type="button" data-active={!advanced} onClick={() => setAdvanced(false)}>
          Basic
        </button>
        <button type="button" data-active={advanced} onClick={() => setAdvanced(true)}>
          Advanced
        </button>
      </div>

      <div className="hubert-lab__section hubert-lab__grid">
        <label>
          <span>Timeframe</span>
          <select value={selectedInterval} onChange={(event) => setSelectedInterval(event.target.value)}>
            {timeframeOptions.map(([label, value]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
        <label>
          <span>History depth</span>
          <select value={settings.historyLimit} onChange={(event) => updateSetting("historyLimit", Number(event.target.value))}>
            <option value="500">500</option>
            <option value="1000">1000</option>
            <option value="2000">2000</option>
            <option value="3000">3000</option>
            <option value="5000">5000</option>
          </select>
        </label>
        <label>
          <span>Strategy preset</span>
          <select value={selectedPreset} onChange={(event) => applyPreset(event.target.value)}>
            <option value="baseline">Baseline</option>
            <option value="smooth">Smooth</option>
            <option value="responsive">Responsive</option>
          </select>
        </label>
      </div>

      {advanced && (
        <>
          <div className="hubert-lab__section hubert-lab__grid">
            {[
              ["bandwidth", "Nadaraya bandwidth", 0.5],
              ["envelopeMultiplier", "NWE multiplier", 0.1],
              ["atrLength", "ATR length", 1],
              ["atrMultiplier", "ATR multiplier", 0.1],
              ["maxSameSideFailures", "Max same-side failures", 1],
            ].map(([key, label, step]) => (
              <label key={key}>
                <span>{label}</span>
                <input type="number" value={settings[key]} step={step} onChange={(event) => updateSetting(key, Number(event.target.value))} />
              </label>
            ))}
            <label>
              <span>Commission %</span>
              <input type="number" value={backtestConfig.commissionPercent} step="0.01" onChange={(event) => updateBacktestConfig("commissionPercent", Number(event.target.value))} />
            </label>
            <label>
              <span>Slippage %</span>
              <input type="number" value={backtestConfig.slippagePercent} step="0.01" onChange={(event) => updateBacktestConfig("slippagePercent", Number(event.target.value))} />
            </label>
            <label>
              <span>Position size %</span>
              <input type="number" value={backtestConfig.positionSizePercent} step="5" onChange={(event) => updateBacktestConfig("positionSizePercent", Number(event.target.value))} />
            </label>
          </div>

          <div className="hubert-lab__toggles">
            {[
              ["showEntries", "Confirmed entries"],
              ["showBenchmarks", "Diagnostic setups"],
              ["showNegated", "Negated setups"],
              ["showSl", "SL lines"],
              ["showTrigger", "Trigger lines"],
            ].map(([key, label]) => (
              <label key={key}>
                <input checked={settings[key]} type="checkbox" onChange={(event) => updateSetting(key, event.target.checked)} />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </>
      )}

      <div className="hubert-lab__actions hubert-lab__actions--sticky">
        <button type="button" onClick={runCurrentBacktest}>Run Backtest</button>
        <button type="button" onClick={runSweep}>Run Sweep</button>
        <button type="button" onClick={() => saveFavorite()}>Save Favorite</button>
        <button type="button" onClick={() => applyConfigToChart(activeConfig)}>Apply to Chart</button>
        <button type="button" onClick={() => onDeployExecution(activeConfig, selectedInterval, "Strategy Lab")}>Deploy to Execution Profile</button>
        <button type="button" onClick={() => onBacktestResult(null)}>Clear Results</button>
      </div>

      {backtestResult && (
        <>
          {backtestResult.metrics.totalTrades < 20 && (
            <div className="hubert-lab__warning">Low trade count. Treat results as unstable.</div>
          )}
          <MetricGrid metrics={backtestResult.metrics} />
          <EquityCurve curve={backtestResult.equityCurve} />
          <TradeTable trades={backtestResult.trades} />
          {advanced && <SetupAuditTable setups={backtestResult.setupAudits} />}
        </>
      )}

      {advanced && (
        <div className="hubert-lab__section">
          <div className="hubert-lab__subhead">
            <strong>Optimization Sweep</strong>
            <span>Comma-separated ranges</span>
          </div>
          <div className="hubert-lab__grid">
            {[
              ["bandwidth", "Bandwidth"],
              ["envelopeMultiplier", "NWE mult"],
              ["atrLength", "ATR length"],
              ["atrMultiplier", "ATR mult"],
            ].map(([key, label]) => (
              <label key={key}>
                <span>{label}</span>
                <input
                  value={optimizerRanges[key]}
                  onChange={(event) =>
                    setOptimizerRanges((currentRanges) => ({
                      ...currentRanges,
                      [key]: event.target.value,
                    }))
                  }
                />
              </label>
            ))}
          </div>
        </div>
      )}

      {optimizationResults.length > 0 && (
        <div className="hubert-lab__table">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Net</th>
                <th>PF</th>
                <th>DD</th>
                <th>Win</th>
                <th>Trades</th>
                <th>Exp</th>
                <th>Avg R</th>
                <th>Score</th>
                <th>Use</th>
              </tr>
            </thead>
            <tbody>
              {optimizationResults.map((row, index) => (
                <tr key={`${row.bandwidth}-${row.envelopeMultiplier}-${row.atrLength}-${row.atrMultiplier}`}>
                  <td>{index + 1}</td>
                  <td>{formatNumber(row.netProfit)}</td>
                  <td>{formatNumber(row.profitFactor)}</td>
                  <td>{formatNumber(row.maxDrawdown)}%</td>
                  <td>{formatNumber(row.winRate)}%</td>
                  <td>{row.totalTrades}</td>
                  <td>{formatNumber(row.expectancy)}</td>
                  <td>{formatNumber(row.averageR)}</td>
                  <td>{formatNumber(row.score)}</td>
                  <td>
                    <button type="button" onClick={() => setSelectedConfig({ ...pickStrategyConfig(settings), ...row })}>Select</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {favorites.length > 0 && (
        <div className="hubert-lab__section">
          <div className="hubert-lab__subhead">
            <strong>Favorites</strong>
            <span>{favorites.length} saved</span>
          </div>
          <div className="hubert-lab__table hubert-lab__table--audit">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>h</th>
                  <th>mult</th>
                  <th>ATR</th>
                  <th>Use</th>
                </tr>
              </thead>
              <tbody>
                {favorites.map((favorite) => (
                  <tr key={favorite.id}>
                    <td>{favorite.name}</td>
                    <td>{favorite.bandwidth}</td>
                    <td>{favorite.envelopeMultiplier}</td>
                    <td>{favorite.atrLength}</td>
                    <td>
                      <button type="button" onClick={() => applyConfigToChart(favorite)}>Chart</button>
                      <button type="button" onClick={() => onDeployExecution(favorite, selectedInterval, favorite.name)}>Deploy</button>
                      <button type="button" onClick={() => toggleCompare(favorite)}>Compare</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {compare.length > 0 && (
        <div className="hubert-lab__warning">
          Comparing: {compare.map((item) => item.name).join(" vs ")}
        </div>
      )}
    </aside>
  );
}
