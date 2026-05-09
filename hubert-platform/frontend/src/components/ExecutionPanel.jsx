import { useEffect, useState } from "react";
import { fetchSolKlines } from "../api/binance";
import {
  EXECUTION_TIMEFRAMES,
  MONEY_PRESETS,
  applyMoneyPreset,
} from "../execution/executionProfiles";
import { runExecutionSimulation } from "../execution/executionEngine";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? "http://127.0.0.1:8787";
const DASHBOARD_TOKEN = import.meta.env.VITE_DASHBOARD_TOKEN ?? "";

function formatNumber(value, digits = 2) {
  return Number(value || 0).toLocaleString(undefined, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  });
}

function profileWarnings(profile) {
  const warnings = [];
  const config = profile.draftConfig;

  if (config.riskPerTradePercent > 5) warnings.push("Risk above 5%");
  if (config.leverage >= 10) warnings.push("High leverage");
  if (profile.maximumPositionSize < profile.minimumPositionSize) warnings.push("Position size range invalid");
  if (config.mode === "live") warnings.push("Live requires successful BingX test and explicit arming");
  if (config.emergencyStop) warnings.push("Emergency stop active");

  return warnings;
}

function updateProfile(profiles, profileId, updater) {
  return profiles.map((profile) => (profile.id === profileId ? updater(profile) : profile));
}

function formatTime(value) {
  return value ? new Date(value).toLocaleString() : "--";
}

function extractBingxBalance(balance) {
  const value = balance?.balance ?? balance;
  const account = Array.isArray(value) ? value[0] : value;
  const nested = account?.balance ?? account;

  return Number(
    nested?.availableMargin ??
      nested?.availableBalance ??
      nested?.equity ??
      nested?.balance ??
      0,
  );
}

function readBalanceAmount(result) {
  if (!result?.ok) return null;
  return Number(result.amount ?? extractBingxBalance(result.payload));
}

function balanceStatusText(result) {
  if (!result) return "not tested";
  if (!result.ok) return `failed: ${result.error}`;
  return formatNumber(readBalanceAmount(result), 4);
}

function toBackendProfile(frontendProfile, existingProfile = {}) {
  return {
    ...existingProfile,
    id: frontendProfile.id,
    account: {
      apiProfile: frontendProfile.accountRoute.apiProfile,
      exchange: frontendProfile.accountRoute.exchange,
      label: frontendProfile.accountRoute.accountLabel,
      type: frontendProfile.accountRoute.accountType,
    },
    enabled: frontendProfile.enabled,
    executionMode: frontendProfile.lastSavedConfig.mode,
    locked: frontendProfile.locked,
    live: existingProfile.live ?? {
      lastProcessedSetupId: null,
      openPosition: null,
      orderLog: [],
    },
    paper: {
      equity: frontendProfile.paperState.currentEquity,
      lastProcessedSetupId: existingProfile.paper?.lastProcessedSetupId ?? null,
      openPosition: existingProfile.paper?.openPosition ?? null,
      realizedPnl: frontendProfile.paperState.realizedPnl,
      tradesToday: frontendProfile.paperState.tradesToday,
    },
    risk: {
      allowLong: frontendProfile.lastSavedConfig.allowLong,
      allowShort: frontendProfile.lastSavedConfig.allowShort,
      emergencyStop: frontendProfile.lastSavedConfig.emergencyStop,
      leverage: frontendProfile.lastSavedConfig.leverage,
      marginMode: frontendProfile.lastSavedConfig.marginMode,
      maxDailyLossPercent: frontendProfile.lastSavedConfig.maxDailyLossPercent,
      maxOpenPositions: frontendProfile.lastSavedConfig.maxOpenPositions,
      maxTradesPerDay: frontendProfile.lastSavedConfig.maxTradesPerDay,
      positionSizeMode: frontendProfile.lastSavedConfig.positionSizeMode,
      riskPerTradePercent: frontendProfile.lastSavedConfig.riskPerTradePercent,
      startingBalance: frontendProfile.lastSavedConfig.startingBalance,
      takeProfitRr: frontendProfile.lastSavedConfig.takeProfitRr,
    },
    status: frontendProfile.enabled
      ? frontendProfile.lastSavedConfig.mode === "live" ? "Live ready" : "Paper ready"
      : "Disabled",
    strategyDeployed: Boolean(frontendProfile.lastDeployedFrom),
    strategyParameters: frontendProfile.strategyParameters,
    symbol: frontendProfile.lastSavedConfig.symbol,
    timeframe: frontendProfile.interval,
    version: frontendProfile.version,
  };
}

function authHeaders(extraHeaders = {}) {
  return {
    ...extraHeaders,
    ...(DASHBOARD_TOKEN ? { "X-Dashboard-Token": DASHBOARD_TOKEN } : {}),
  };
}

function downloadJson(fileName, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function ExecutionPanel({
  onClose,
  profiles,
  rawCandles,
  selectedInterval,
  setProfiles,
}) {
  const [activeProfileId, setActiveProfileId] = useState("profile-15m");
  const [backendError, setBackendError] = useState("");
  const [backendStatus, setBackendStatus] = useState(null);
  const [connectionMessage, setConnectionMessage] = useState("");
  const [connectionResult, setConnectionResult] = useState(null);
  const [isSimulating, setIsSimulating] = useState(false);
  const activeProfile =
    profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0];
  const warnings = profileWarnings(activeProfile);
  const backendBingx = backendStatus?.state?.bingx;
  const showBackendHint = !backendStatus && !backendError;
  const showApiWarning = backendStatus && !backendBingx?.apiConfigured;
  const showLiveReadinessWarning =
    activeProfile.draftConfig.mode === "live" &&
    backendBingx?.apiConfigured &&
    !backendBingx?.liveReady;

  async function loadBackendStatus() {
    try {
      const response = await fetch(`${BACKEND_URL}/status`);

      if (!response.ok) {
        throw new Error(`Backend status failed: ${response.status}`);
      }

      setBackendStatus(await response.json());
      setBackendError("");
    } catch (error) {
      setBackendError(
        error instanceof Error ? error.message : "Backend runner is offline.",
      );
    }
  }

  async function postBackend(path, body = null) {
    try {
      const response = await fetch(`${BACKEND_URL}${path}`, {
        body: body ? JSON.stringify(body) : undefined,
        headers: authHeaders(body ? { "Content-Type": "application/json" } : {}),
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(`Backend request failed: ${response.status}`);
      }

      await loadBackendStatus();
    } catch (error) {
      setBackendError(error instanceof Error ? error.message : "Backend request failed.");
    }
  }

  async function syncProfileToBackend(profile) {
    try {
      const response = await fetch(`${BACKEND_URL}/profiles`);

      if (!response.ok) {
        throw new Error(`Backend profiles failed: ${response.status}`);
      }

      const backendProfiles = await response.json();
      const existingProfile = backendProfiles.find((item) => item.id === profile.id) ?? {};
      const nextBackendProfile = toBackendProfile(profile, existingProfile);
      const nextProfiles = [
        ...backendProfiles.filter((item) => item.id !== profile.id),
        nextBackendProfile,
      ];
      const saveResponse = await fetch(`${BACKEND_URL}/profiles`, {
        body: JSON.stringify({ profiles: nextProfiles }),
        headers: authHeaders({ "Content-Type": "application/json" }),
        method: "POST",
      });

      if (!saveResponse.ok) {
        throw new Error(`Backend profile save failed: ${saveResponse.status}`);
      }

      setConnectionMessage(`Backend profile synced: ${profile.label} ${profile.lastSavedConfig.mode}`);
      await loadBackendStatus();
    } catch (error) {
      setConnectionMessage(
        error instanceof Error ? error.message : "Backend profile sync failed.",
      );
    }
  }

  async function testBingxConnection() {
    try {
      const response = await fetch(`${BACKEND_URL}/bingx/test`, { method: "POST" });
      const result = await response.json();

      setConnectionResult(result);
      if (!result.ok) {
        setConnectionMessage(result.reason ?? "BingX connection failed.");
      } else {
        setConnectionMessage(
          result.liveReady
            ? "BingX connected. Futures balance confirmed."
            : result.reason ?? "BingX connected, but futures balance is not ready.",
        );
      }

      await loadBackendStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : "BingX test failed.";
      setConnectionResult({
        ok: false,
        reason: message,
        testedAt: new Date().toISOString(),
      });
      setConnectionMessage(message);
    }
  }

  async function exportBackendLogs() {
    const response = await fetch(`${BACKEND_URL}/logs`);
    downloadJson(`choromanski-logs-${new Date().toISOString().slice(0, 10)}.json`, await response.json());
  }

  async function exportBackendConfig() {
    const response = await fetch(`${BACKEND_URL}/config/export`);
    downloadJson(`choromanski-backend-config-${new Date().toISOString().slice(0, 10)}.json`, await response.json());
  }

  function startLive() {
    const confirmed = window.confirm(
      "Live trading can lose money. Confirm only after testing with small size and verifying the locked Execution Profile.",
    );

    if (confirmed) {
      postBackend("/bot/live/start", { confirm: "START_LIVE" });
    }
  }

  useEffect(() => {
    loadBackendStatus();
    const timer = window.setInterval(loadBackendStatus, 5000);

    return () => window.clearInterval(timer);
  }, []);

  function patchProfile(patch) {
    setProfiles((currentProfiles) =>
      updateProfile(currentProfiles, activeProfile.id, (profile) => ({
        ...profile,
        ...patch,
      })),
    );
  }

  function patchDraft(key, value) {
    setProfiles((currentProfiles) =>
      updateProfile(currentProfiles, activeProfile.id, (profile) => ({
        ...profile,
        draftConfig: {
          ...profile.draftConfig,
          [key]: value,
        },
      })),
    );
  }

  function patchRoute(key, value) {
    setProfiles((currentProfiles) =>
      updateProfile(currentProfiles, activeProfile.id, (profile) => ({
        ...profile,
        accountRoute: {
          ...profile.accountRoute,
          [key]: value,
        },
      })),
    );
  }

  function saveDraft() {
    const nextProfile = {
      ...activeProfile,
      lastSavedAt: new Date().toISOString(),
      lastSavedConfig: activeProfile.draftConfig,
      status: activeProfile.enabled
        ? activeProfile.draftConfig.mode === "live" ? "Live ready" : "Paper ready"
        : "Disabled",
      version: activeProfile.version + 1,
    };
    setProfiles((currentProfiles) =>
      updateProfile(currentProfiles, activeProfile.id, () => nextProfile),
    );
    syncProfileToBackend(nextProfile);
  }

  function lockProfile() {
    const nextProfile = {
      ...activeProfile,
      lastSavedAt: new Date().toISOString(),
      lastSavedConfig: activeProfile.draftConfig,
      locked: true,
      status: activeProfile.enabled
        ? activeProfile.draftConfig.mode === "live" ? "Live ready" : "Paper ready"
        : "Disabled",
      version: activeProfile.version + 1,
    };
    setProfiles((currentProfiles) =>
      updateProfile(currentProfiles, activeProfile.id, () => nextProfile),
    );
    syncProfileToBackend(nextProfile);
  }

  async function runPaperProfile() {
    setIsSimulating(true);

    try {
      const profileCandles =
        activeProfile.interval === selectedInterval
          ? rawCandles
          : await fetchSolKlines(activeProfile.interval, 3000);
      const result = runExecutionSimulation({
        executionConfig: {
          ...activeProfile.lastSavedConfig,
          maximumPositionSize: activeProfile.maximumPositionSize,
          minimumPositionSize: activeProfile.minimumPositionSize,
          mode: "paper",
        },
        rawCandles: profileCandles,
        strategySettings: activeProfile.strategyParameters,
      });

      setProfiles((currentProfiles) =>
        updateProfile(currentProfiles, activeProfile.id, (profile) => ({
          ...profile,
          paperState: {
            currentEquity: result.endingEquity,
            dailyLossUsed: result.trades
              .filter((trade) => trade.pnl < 0)
              .reduce((total, trade) => total + Math.abs(trade.pnl), 0),
            openPosition: null,
            realizedPnl: result.endingEquity - profile.lastSavedConfig.startingBalance,
            tradesToday: result.trades.length,
            tradeLog: result.trades,
            unrealizedPnl: 0,
          },
          status: "Paper simulated",
        })),
      );
    } catch (simulationError) {
      setConnectionMessage(
        simulationError instanceof Error ? simulationError.message : "Paper simulation failed.",
      );
    } finally {
      setIsSimulating(false);
    }
  }

  return (
    <aside className="hubert-lab hubert-lab--wide" aria-label="Execution Center">
      <div className="hubert-lab__header">
        <strong>Execution Center</strong>
        <span>Profiles are locked away from chart experiments</span>
        <button type="button" onClick={onClose}>Close</button>
      </div>

      <div className="hubert-profile-strip">
        {EXECUTION_TIMEFRAMES.map((timeframe) => {
          const profile = profiles.find((item) => item.interval === timeframe.interval);

          return (
            <button
              data-active={profile?.id === activeProfile.id}
              key={timeframe.interval}
              onClick={() => setActiveProfileId(profile.id)}
              type="button"
            >
              {timeframe.label}
              <span>{profile?.enabled ? "on" : "off"}</span>
            </button>
          );
        })}
      </div>

      {selectedInterval !== activeProfile.interval && (
        <div className="hubert-lab__warning">
          Chart timeframe is {selectedInterval}. This profile is {activeProfile.label}. Execution profile settings remain independent.
        </div>
      )}

      {showBackendHint && (
        <div className="hubert-lab__warning">
          Backend status is loading. Backend paper mode can run with the browser closed.
        </div>
      )}

      {showApiWarning && (
        <div className="hubert-lab__warning">
          API keys are missing. Configure backend .env before using Live mode.
        </div>
      )}

      {showLiveReadinessWarning && (
        <div className="hubert-lab__warning">
          Live mode needs a successful futures balance test before arming.
        </div>
      )}

      <div className="hubert-lab__section">
        <div className="hubert-lab__subhead">
          <strong>Backend Runner</strong>
          <span>{backendStatus?.state?.botStatus ?? "offline"}</span>
        </div>
        <div className="hubert-lab__actions">
          <button type="button" onClick={() => postBackend("/bot/start")}>Start Paper Bot</button>
          <button type="button" onClick={testBingxConnection}>Test BingX</button>
          <button type="button" onClick={() => postBackend("/bot/live/arm")}>Arm Live</button>
          <button type="button" onClick={startLive}>Start Live</button>
          <button type="button" onClick={() => postBackend("/bot/reconcile")}>Reconcile Now</button>
          <button type="button" onClick={() => postBackend("/bot/confirm-resume")}>Confirm Resume</button>
          <button type="button" onClick={() => postBackend("/bot/stop")}>Stop Bot</button>
          <button type="button" onClick={() => postBackend("/bot/stop-new-entries", { enabled: true })}>Stop New Entries</button>
          <button type="button" onClick={() => postBackend("/paper/close-all")}>Close All Paper Positions</button>
          <button type="button" onClick={() => postBackend("/bot/emergency-stop", { closePositions: false })}>Emergency Stop</button>
          <button type="button" onClick={exportBackendLogs}>Export Logs</button>
          <button type="button" onClick={exportBackendConfig}>Export Config</button>
          <button type="button" onClick={loadBackendStatus}>Refresh</button>
        </div>
        {backendError && (
          <div className="hubert-lab__warning">
            Backend unavailable at {BACKEND_URL}. Start it with npm run dev inside /backend.
          </div>
        )}
        {backendStatus && (
          <>
            <div className="hubert-lab__metrics">
              <div>
                <span>State</span>
                <strong>{backendStatus.state.botStatus}</strong>
              </div>
              <div>
                <span>Runtime</span>
                <strong>{backendStatus.state.runtime?.processManager ?? "node"}</strong>
              </div>
              <div>
                <span>Backend</span>
                <strong>{backendError ? "offline" : "online"}</strong>
              </div>
              <div>
                <span>Heartbeat</span>
                <strong>{formatTime(backendStatus.state.heartbeatAt)}</strong>
              </div>
              <div>
                <span>Active profiles</span>
                <strong>{backendStatus.profiles.filter((profile) => profile.enabled).length}</strong>
              </div>
              <div>
                <span>Backend trades</span>
                <strong>{backendStatus.trades.length}</strong>
              </div>
              <div>
                <span>Last tick</span>
                <strong>{formatTime(backendStatus.state.lastTickAt)}</strong>
              </div>
              <div>
                <span>Last candle</span>
                <strong>{backendStatus.state.lastCandleTime ?? "--"}</strong>
              </div>
              <div>
                <span>Last signal</span>
                <strong>{backendStatus.state.lastStrategySignal?.direction ?? "none"}</strong>
              </div>
              <div>
                <span>Last decision</span>
                <strong>{backendStatus.state.lastExecutionDecision ?? "--"}</strong>
              </div>
              <div>
                <span>API keys</span>
                <strong>{backendStatus.state.bingx?.apiConfigured ? "configured" : "missing"}</strong>
              </div>
              <div>
                <span>BingX test</span>
                <strong>
                  {connectionResult
                    ? connectionResult.ok ? "connected" : "failed"
                    : backendStatus.state.bingx?.balance ? "connected" : "not tested"}
                </strong>
              </div>
              <div>
                <span>Fund balance</span>
                <strong>{balanceStatusText(connectionResult?.balances?.fund ?? backendStatus.state.bingx?.balances?.fund)}</strong>
              </div>
              <div>
                <span>Spot balance</span>
                <strong>{balanceStatusText(connectionResult?.balances?.spot ?? backendStatus.state.bingx?.balances?.spot)}</strong>
              </div>
              <div>
                <span>Futures USDT</span>
                <strong>{balanceStatusText(connectionResult?.balances?.futures ?? backendStatus.state.bingx?.balances?.futures)}</strong>
              </div>
              <div>
                <span>Execution balance</span>
                <strong>{formatNumber(connectionResult?.activeExecutionBalance ?? backendStatus.state.bingx?.activeExecutionBalance, 4)}</strong>
              </div>
              <div>
                <span>Reconciliation</span>
                <strong>{backendStatus.state.bingx?.reconciliationStatus ?? "--"}</strong>
              </div>
              <div>
                <span>Last sync</span>
                <strong>{formatTime(backendStatus.state.bingx?.lastSyncAt)}</strong>
              </div>
              <div>
                <span>Open positions</span>
                <strong>{backendStatus.state.bingx?.openPositions?.length ?? 0}</strong>
              </div>
              <div>
                <span>Open orders</span>
                <strong>{backendStatus.state.bingx?.openOrders?.length ?? 0}</strong>
              </div>
              <div>
                <span>Active SL</span>
                <strong>{backendStatus.state.bingx?.activeSlOrders?.length ?? 0}</strong>
              </div>
              <div>
                <span>Daily PnL</span>
                <strong>{formatNumber(backendStatus.trades.filter((trade) => new Date(trade.exitTime * 1000 || trade.exitTime).toDateString() === new Date().toDateString()).reduce((sum, trade) => sum + Number(trade.pnl || 0), 0))}</strong>
              </div>
              <div>
                <span>Safety</span>
                <strong>{backendStatus.state.safety?.status ?? "--"}</strong>
              </div>
              <div>
                <span>Emergency</span>
                <strong>{backendStatus.state.globalEmergencyStop ? "on" : "off"}</strong>
              </div>
            </div>

            <div className="hubert-lab__table">
              <table>
                <thead>
                  <tr>
                    <th>Profile</th>
                    <th>Status</th>
                    <th>Equity</th>
                    <th>Open</th>
                    <th>Realized</th>
                  </tr>
                </thead>
                <tbody>
                  {backendStatus.profiles.map((profile) => (
                    <tr key={profile.id}>
                      <td>{profile.timeframe} {profile.symbol}</td>
                      <td>{profile.status}</td>
                      <td>{formatNumber(profile.paper?.equity)}</td>
                      <td>{profile.paper?.openPosition?.direction ?? "none"}</td>
                      <td>{formatNumber(profile.paper?.realizedPnl)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="hubert-lab__table">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Side</th>
                    <th>Entry</th>
                    <th>Exit</th>
                    <th>PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {backendStatus.trades.slice(-12).reverse().map((trade) => (
                    <tr key={trade.id}>
                      <td>{formatTime(trade.exitTime)}</td>
                      <td>{trade.direction}</td>
                      <td>{formatNumber(trade.entryPrice, 3)}</td>
                      <td>{formatNumber(trade.exitPrice, 3)}</td>
                      <td>{formatNumber(trade.pnl)}</td>
                    </tr>
                  ))}
                  {backendStatus.trades.length === 0 && (
                    <tr>
                      <td colSpan="5">No backend paper trades yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="hubert-lab__table">
              <table>
                <thead>
                  <tr>
                    <th>Log time</th>
                    <th>Event</th>
                    <th>Context</th>
                  </tr>
                </thead>
                <tbody>
                  {backendStatus.logs.slice(-10).reverse().map((log) => (
                    <tr key={log.id}>
                      <td>{formatTime(log.time)}</td>
                      <td>{log.message}</td>
                      <td>{JSON.stringify(log.context ?? {})}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div className="hubert-lab__section">
        <div className="hubert-lab__subhead">
          <strong>Profile</strong>
          <span>{activeProfile.locked ? "Locked" : "Draft editable"} v{activeProfile.version}</span>
        </div>
        <div className="hubert-lab__grid">
          <label>
            <span>Enabled</span>
            <select value={String(activeProfile.enabled)} onChange={(event) => patchProfile({ enabled: event.target.value === "true" })}>
              <option value="true">enabled</option>
              <option value="false">disabled</option>
            </select>
          </label>
          <label>
            <span>Symbol</span>
            <input value={activeProfile.draftConfig.symbol} onChange={(event) => patchDraft("symbol", event.target.value)} disabled={activeProfile.locked} />
          </label>
          <label>
            <span>Execution mode</span>
            <select value={activeProfile.draftConfig.mode} onChange={(event) => patchDraft("mode", event.target.value)} disabled={activeProfile.locked}>
              <option value="paper">Paper</option>
              <option value="live">Live</option>
            </select>
          </label>
          <label>
            <span>API profile</span>
            <input value={activeProfile.accountRoute.apiProfile} onChange={(event) => patchRoute("apiProfile", event.target.value)} disabled={activeProfile.locked} />
          </label>
          <label>
            <span>Account type</span>
            <select value={activeProfile.accountRoute.accountType} onChange={(event) => patchRoute("accountType", event.target.value)} disabled={activeProfile.locked}>
              <option value="main">main account</option>
              <option value="subaccount">subaccount</option>
            </select>
          </label>
          <label>
            <span>Account label</span>
            <input value={activeProfile.accountRoute.accountLabel} onChange={(event) => patchRoute("accountLabel", event.target.value)} disabled={activeProfile.locked} />
          </label>
        </div>
      </div>

      <div className="hubert-lab__section">
        <div className="hubert-lab__subhead">
          <strong>Money Management</strong>
          <span>{MONEY_PRESETS[activeProfile.moneyPreset]?.description}</span>
        </div>
        <div className="hubert-profile-strip">
          {Object.entries(MONEY_PRESETS).map(([key, preset]) => (
            <button
              data-active={activeProfile.moneyPreset === key}
              disabled={activeProfile.locked}
              key={key}
              onClick={() =>
                setProfiles((currentProfiles) =>
                  updateProfile(currentProfiles, activeProfile.id, (profile) =>
                    applyMoneyPreset(profile, key),
                  ),
                )
              }
              type="button"
            >
              {preset.label}
            </button>
          ))}
        </div>

        <div className="hubert-lab__grid">
          {[
            ["riskPerTradePercent", "Risk per trade %", 0.1],
            ["leverage", "Leverage", 1],
            ["maxDailyLossPercent", "Max daily loss %", 0.5],
            ["maxWeeklyLossPercent", "Max weekly loss %", 0.5],
            ["maxOpenPositions", "Max open positions", 1],
            ["maxTradesPerDay", "Max trades per day", 1],
            ["takeProfitRr", "TP R multiple", 0.25],
          ].map(([key, label, step]) => (
            <label key={key}>
              <span>{label}</span>
              <input type="number" step={step} value={activeProfile.draftConfig[key]} onChange={(event) => patchDraft(key, Number(event.target.value))} disabled={activeProfile.locked} />
            </label>
          ))}
          <label>
            <span>Cooldown after loss</span>
            <input type="number" value={activeProfile.cooldownAfterLoss} onChange={(event) => patchProfile({ cooldownAfterLoss: Number(event.target.value) })} disabled={activeProfile.locked} />
          </label>
          <label>
            <span>Min position size</span>
            <input type="number" value={activeProfile.minimumPositionSize} onChange={(event) => patchProfile({ minimumPositionSize: Number(event.target.value) })} disabled={activeProfile.locked} />
          </label>
          <label>
            <span>Max position size</span>
            <input type="number" value={activeProfile.maximumPositionSize} onChange={(event) => patchProfile({ maximumPositionSize: Number(event.target.value) })} disabled={activeProfile.locked} />
          </label>
          <label>
            <span>Equity mode</span>
            <select value={activeProfile.fixedEquityMode} onChange={(event) => patchProfile({ fixedEquityMode: event.target.value })} disabled={activeProfile.locked}>
              <option value="fixed">fixed equity</option>
              <option value="live">live equity</option>
            </select>
          </label>
        </div>

        <div className="hubert-lab__toggles">
          {[
            ["allowLong", "Allow long"],
            ["allowShort", "Allow short"],
            ["autoExecution", "Auto execution"],
            ["emergencyStop", "Emergency stop"],
            ["compounding", "Compounding"],
          ].map(([key, label]) => (
            <label key={key}>
              <input
                checked={key === "compounding" ? activeProfile.compounding : activeProfile.draftConfig[key]}
                disabled={activeProfile.locked}
                type="checkbox"
                onChange={(event) =>
                  key === "compounding"
                    ? patchProfile({ compounding: event.target.checked })
                    : patchDraft(key, event.target.checked)
                }
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="hubert-lab__warning">{warnings.join(" | ")}</div>
      )}

      <div className="hubert-lab__actions hubert-lab__actions--sticky">
        <button type="button" onClick={() => patchProfile({ locked: false })}>Unlock</button>
        <button type="button" onClick={saveDraft}>Save Draft</button>
        <button type="button" onClick={lockProfile}>Lock Profile</button>
        <button type="button" onClick={runPaperProfile}>{isSimulating ? "Simulating" : "Activate Paper Trading"}</button>
        <button type="button" onClick={() => patchDraft("emergencyStop", true)}>Emergency Stop</button>
        <button type="button" onClick={testBingxConnection}>Test Connection</button>
      </div>

      {(connectionMessage || connectionResult) && (
        <div className="hubert-lab__warning">
          {connectionResult
            ? `${connectionResult.ok ? "connected" : "failed"} | ${connectionMessage || connectionResult.reason || "BingX test complete"} | checked ${connectionResult.activeExecutionBalanceAccount ?? "USDT-M Perpetual / Swap Futures"} | last tested ${formatTime(connectionResult.testedAt)} | execution balance ${formatNumber(connectionResult.activeExecutionBalance, 4)}`
            : connectionMessage}
        </div>
      )}

      <div className="hubert-lab__metrics">
        <div>
          <span>Paper equity</span>
          <strong>{formatNumber(activeProfile.paperState.currentEquity)}</strong>
        </div>
        <div>
          <span>Open position</span>
          <strong>{activeProfile.paperState.openPosition?.direction ?? "none"}</strong>
        </div>
        <div>
          <span>Realized PnL</span>
          <strong>{formatNumber(activeProfile.paperState.realizedPnl)}</strong>
        </div>
        <div>
          <span>Unrealized PnL</span>
          <strong>{formatNumber(activeProfile.paperState.unrealizedPnl)}</strong>
        </div>
        <div>
          <span>Trades today</span>
          <strong>{activeProfile.paperState.tradesToday}</strong>
        </div>
        <div>
          <span>Daily loss used</span>
          <strong>{formatNumber(activeProfile.paperState.dailyLossUsed)}</strong>
        </div>
      </div>

      <div className="hubert-lab__table">
        <table>
          <thead>
            <tr>
              <th>Profile</th>
              <th>Status</th>
              <th>Mode</th>
              <th>Account</th>
              <th>Deployed</th>
              <th>Saved</th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((profile) => (
              <tr key={profile.id}>
                <td>{profile.label}</td>
                <td>{profile.status}</td>
                <td>{profile.lastSavedConfig.mode}</td>
                <td>{profile.accountRoute.accountLabel}</td>
                <td>{profile.lastDeployedFrom || "--"}</td>
                <td>{new Date(profile.lastSavedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </aside>
  );
}
