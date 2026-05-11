import { sanitizeForAi } from "../aiContextBuilder.js";

const MEMORY_VERSION = 1;
const LIMITS = {
  baselines: 12,
  conclusions: 24,
  conversations: 36,
  rejected: 20,
  runs: 16,
  weaknesses: 24,
};

const DEFAULT_MEMORY = {
  conversationSummary: [],
  discussedWeaknesses: [],
  favoriteBaselines: [],
  preferences: {
    language: "auto",
    metrics: [],
    style: "direct",
  },
  previousConclusions: [],
  researchIntent: null,
  recentRuns: [],
  recentWorkspace: null,
  rejectedConfigs: [],
  updatedAt: null,
  version: MEMORY_VERSION,
};

function normalizeText(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

function isPolish(value = "") {
  return /(^|\s)(co|czemu|dlaczego|jak|gdzie|porownaj|porównaj|wynik|dziala|działa|nadal|lepszy|gorszy|ustawienia|prosze|proszę)(\s|$)/u
    .test(normalizeText(value));
}

function uniquePush(list = [], item, keyFn = (entry) => JSON.stringify(entry), limit = 20) {
  const key = keyFn(item);
  return [item, ...list.filter((entry) => keyFn(entry) !== key)].slice(0, limit);
}

function extractMetricPreferences(text = "") {
  const normalized = normalizeText(text);
  const metrics = [];
  if (normalized.includes("pf") || normalized.includes("profit factor")) metrics.push("profit factor");
  if (normalized.includes("net") || normalized.includes("pnl") || normalized.includes("profit")) metrics.push("net profit");
  if (normalized.includes("dd") || normalized.includes("drawdown")) metrics.push("drawdown");
  if (normalized.includes("robust") || normalized.includes("stabil")) metrics.push("robustness");
  if (normalized.includes("win rate") || normalized.includes("skuteczn")) metrics.push("win rate");
  if (normalized.includes("conservative") || normalized.includes("legacy")) metrics.push("fill-mode sensitivity");
  return metrics;
}

function extractWeaknesses(text = "") {
  const normalized = normalizeText(text);
  const weaknesses = [];
  if (normalized.includes("overfit")) weaknesses.push("overfit risk");
  if (normalized.includes("slaby") || normalized.includes("weak")) weaknesses.push("weak result");
  if (normalized.includes("stale") || normalized.includes("sync")) weaknesses.push("data freshness");
  if (normalized.includes("sl") || normalized.includes("stop loss")) weaknesses.push("SL/protection reliability");
  if (normalized.includes("drawdown") || normalized.includes("dd")) weaknesses.push("drawdown risk");
  if (normalized.includes("few trades") || normalized.includes("malo transakcji")) weaknesses.push("low sample size");
  return weaknesses;
}

function extractBaselineName(text = "") {
  const source = String(text);
  const match = source.match(/\b(hubert|baseline\s+[\w.-]+|backtest\s+[\w.-]+)\b/i);
  if (!match) return "";
  return match[1].replace(/^baseline\s+|^backtest\s+/i, "").trim();
}

function compactWorkspace(workspace = {}) {
  if (!workspace || typeof workspace !== "object") return null;
  return sanitizeForAi({
    activeBacktest: workspace.activeBacktest,
    activePanel: workspace.activePanel,
    activeResult: workspace.activeResult,
    chart: workspace.chart,
    execution: workspace.execution,
    live: workspace.live,
    selectedDecks: workspace.selectedDecks,
  });
}

function normalizeMemory(memory = {}) {
  return {
    ...DEFAULT_MEMORY,
    ...memory,
    conversationSummary: Array.isArray(memory.conversationSummary) ? memory.conversationSummary : [],
    discussedWeaknesses: Array.isArray(memory.discussedWeaknesses) ? memory.discussedWeaknesses : [],
    favoriteBaselines: Array.isArray(memory.favoriteBaselines) ? memory.favoriteBaselines : [],
    preferences: {
      ...DEFAULT_MEMORY.preferences,
      ...(memory.preferences ?? {}),
      metrics: Array.isArray(memory.preferences?.metrics) ? memory.preferences.metrics : [],
    },
    previousConclusions: Array.isArray(memory.previousConclusions) ? memory.previousConclusions : [],
    researchIntent: memory.researchIntent && typeof memory.researchIntent === "object" ? memory.researchIntent : null,
    recentRuns: Array.isArray(memory.recentRuns) ? memory.recentRuns : [],
    rejectedConfigs: Array.isArray(memory.rejectedConfigs) ? memory.rejectedConfigs : [],
    version: MEMORY_VERSION,
  };
}

export function createCopilotMemoryStore({ store }) {
  async function save(memory) {
    const next = sanitizeForAi({
      ...normalizeMemory(memory),
      updatedAt: new Date().toISOString(),
    });
    await store.setCollection("aiCopilotMemory", next);
    return next;
  }

  function getMemory() {
    return normalizeMemory(store.getCollection("aiCopilotMemory"));
  }

  return {
    async clearMemory() {
      return save(DEFAULT_MEMORY);
    },

    getMemory() {
      return sanitizeForAi(getMemory());
    },

    async rememberBaseline(baseline = {}) {
      if (!baseline.name && !baseline.id) return this.getMemory();
      const current = getMemory();
      return save({
        ...current,
        favoriteBaselines: uniquePush(
          current.favoriteBaselines,
          {
            id: baseline.id ?? null,
            name: baseline.name ?? baseline.id,
            rememberedAt: new Date().toISOString(),
            source: baseline.source ?? baseline.type ?? "saved-backtest",
            summary: baseline.summary ?? null,
          },
          (entry) => normalizeText(entry.name ?? entry.id),
          LIMITS.baselines,
        ),
      });
    },

    async rememberInteraction({ message = "", response = null, run = null, row = null, workspaceContext = null } = {}) {
      const current = getMemory();
      const metrics = [...new Set([...current.preferences.metrics, ...extractMetricPreferences(message)])].slice(0, 12);
      const language = isPolish(message) ? "pl" : current.preferences.language;
      const baselineName = extractBaselineName(message);
      const weaknesses = extractWeaknesses(`${message} ${response?.answer ?? response?.text ?? ""}`);
      const conclusion = response?.answer ?? response?.text ?? "";
      const nextMemory = {
        ...current,
        conversationSummary: uniquePush(
          current.conversationSummary,
          {
            message: String(message).slice(0, 500),
            response: String(conclusion).slice(0, 700),
            runId: run?.id ?? response?.runId ?? null,
            time: new Date().toISOString(),
          },
          (entry) => `${entry.runId ?? "chat"}:${entry.message}`,
          LIMITS.conversations,
        ),
        discussedWeaknesses: [
          ...new Set([...weaknesses, ...current.discussedWeaknesses]),
        ].slice(0, LIMITS.weaknesses),
        favoriteBaselines: baselineName
          ? uniquePush(
              current.favoriteBaselines,
              { name: baselineName, rememberedAt: new Date().toISOString(), source: "conversation" },
              (entry) => normalizeText(entry.name ?? entry.id),
              LIMITS.baselines,
            )
          : current.favoriteBaselines,
        preferences: {
          ...current.preferences,
          language,
          metrics,
        },
        previousConclusions: conclusion
          ? uniquePush(
              current.previousConclusions,
              {
                conclusion: String(conclusion).slice(0, 900),
                runId: run?.id ?? response?.runId ?? null,
                time: new Date().toISOString(),
              },
              (entry) => `${entry.runId ?? "chat"}:${entry.conclusion}`,
              LIMITS.conclusions,
            )
          : current.previousConclusions,
        recentRuns: run?.id
          ? uniquePush(
              current.recentRuns,
              {
                id: run.id,
                prompt: run.prompt,
                result: run.resultSummary?.message ?? run.currentStep ?? run.status,
                status: run.status,
                time: new Date().toISOString(),
              },
              (entry) => entry.id,
              LIMITS.runs,
            )
          : current.recentRuns,
        recentWorkspace: compactWorkspace(workspaceContext) ?? current.recentWorkspace,
      };

      if (row?.research?.label && /unstable|overfit|low sample|invalid/i.test(row.research.label)) {
        nextMemory.rejectedConfigs = uniquePush(
          current.rejectedConfigs,
          {
            id: row.id ?? null,
            reason: row.research.label,
            runId: run?.id ?? null,
            time: new Date().toISOString(),
          },
          (entry) => `${entry.runId}:${entry.id}`,
          LIMITS.rejected,
        );
      }

      return save(nextMemory);
    },

    async rememberRun(run = {}) {
      if (!run.id) return this.getMemory();
      const current = getMemory();
      return save({
        ...current,
        recentRuns: uniquePush(
          current.recentRuns,
          {
            id: run.id,
            prompt: run.prompt,
            result: run.resultSummary?.message ?? run.currentStep ?? run.status,
            status: run.status,
            time: new Date().toISOString(),
          },
          (entry) => entry.id,
          LIMITS.runs,
        ),
      });
    },

    async rememberResearchIntent(intent = {}) {
      if (!intent || typeof intent !== "object") return this.getMemory();
      const current = getMemory();
      return save({
        ...current,
        researchIntent: sanitizeForAi({
          ...intent,
          updatedAt: new Date().toISOString(),
        }),
      });
    },

    summary() {
      const memory = getMemory();
      return sanitizeForAi({
        baselines: memory.favoriteBaselines.slice(0, 6),
        conversationSummary: memory.conversationSummary.slice(0, 8),
        discussedWeaknesses: memory.discussedWeaknesses.slice(0, 8),
        preferences: memory.preferences,
        previousConclusions: memory.previousConclusions.slice(0, 5),
        researchIntent: memory.researchIntent,
        recentRuns: memory.recentRuns.slice(0, 6),
        recentWorkspace: memory.recentWorkspace,
        updatedAt: memory.updatedAt,
      });
    },
  };
}
