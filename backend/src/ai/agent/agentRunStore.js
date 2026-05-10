const RUN_LIMIT = 80;

function publicRow(row) {
  if (!row) return row;
  return {
    candlesUsed: row.candlesUsed,
    fillMode: row.fillMode,
    id: row.id,
    metrics: row.metrics,
    netProfit: row.netProfit,
    params: row.params,
    provenance: row.provenance,
    rank: row.rank,
    research: row.research,
    score: row.score,
    settings: row.settings,
    symbol: row.symbol,
    timeframe: row.timeframe,
    totalTrades: row.totalTrades,
    winRate: row.winRate,
  };
}

function publicRun(run, persistenceWarning = "") {
  if (!run) return null;
  const resultSummary = run.resultSummary ? {
    ...run.resultSummary,
    best: publicRow(run.resultSummary.best),
    topRows: (run.resultSummary.topRows ?? []).map(publicRow),
  } : null;
  return {
    artifacts: (run.artifacts ?? []).map(({ content, ...artifact }) => artifact),
    currentStep: run.currentStep,
    errors: run.errors ?? [],
    finishedAt: run.finishedAt,
    id: run.id,
    messages: run.messages ?? [],
    parsedIntent: run.parsedIntent,
    partialResults: (run.partialResults ?? []).map(publicRow),
    plan: run.plan,
    progress: run.progress,
    prompt: run.prompt,
    resultSummary,
    cacheStats: run.cacheStats ?? {},
    cancelRequested: Boolean(run.cancelRequested),
    heartbeatAt: run.heartbeatAt,
    queuedAt: run.queuedAt,
    startedAt: run.startedAt,
    status: run.status,
    updatedAt: run.updatedAt,
    workerId: run.workerId,
    warnings: run.warnings ?? [],
    ...(persistenceWarning ? { persistenceWarning } : {}),
  };
}

export function createAgentRunStore({ store }) {
  let fallbackRuns = Array.isArray(store.getCollection("aiAgentRuns"))
    ? store.getCollection("aiAgentRuns")
    : [];
  let persistenceWarning = "";

  async function saveAll(runs) {
    fallbackRuns = runs.slice(0, RUN_LIMIT);
    try {
      await store.setCollection("aiAgentRuns", fallbackRuns);
      persistenceWarning = "";
    } catch (error) {
      persistenceWarning = `AI run history is in memory only because filesystem persistence failed: ${error instanceof Error ? error.message : String(error)}`;
      console.warn(`[ai-agent] ${persistenceWarning}`);
    }
  }

  function runs() {
    const persisted = store.getCollection("aiAgentRuns");
    return Array.isArray(persisted) && persisted.length ? persisted : fallbackRuns;
  }

  return {
    async appendLog(id, message) {
      const run = this.get(id);
      if (!run) return null;
      return this.update(id, {
        logs: [...(run.logs ?? []), { message, time: new Date().toISOString() }].slice(-80),
      });
    },

    async cancel(id) {
      const run = this.get(id);
      if (!run) return null;
      if (run.status === "queued") {
        return this.update(id, {
          cancelRequested: true,
          currentStep: "Cancelled before worker start",
          finishedAt: new Date().toISOString(),
          status: "cancelled",
        });
      }
      return this.update(id, {
        cancelRequested: true,
        currentStep: "Cancelling after current batch",
      });
    },

    async create({ plan, prompt, warnings = [] }) {
      const now = new Date().toISOString();
      const run = {
        artifacts: [],
        cacheStats: { hits: 0, misses: 0 },
        cancelRequested: false,
        currentStep: "Queued",
        errors: [],
        heartbeatAt: null,
        id: `agent-run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        logs: [],
        messages: [],
        parsedIntent: plan.kind,
        partialResults: [],
        plan,
        progress: { completed: 0, percent: 0, total: plan.maxCombinations ?? 1 },
        prompt,
        queuedAt: now,
        resultSummary: null,
        startedAt: null,
        status: "queued",
        updatedAt: now,
        warnings,
      };
      await saveAll([run, ...runs().filter((item) => item.id !== run.id)]);
      return publicRun(run, persistenceWarning);
    },

    async heartbeat(id, patch = {}) {
      return this.update(id, {
        ...patch,
        heartbeatAt: new Date().toISOString(),
      });
    },

    get(id) {
      return runs().find((run) => run.id === id) ?? null;
    },

    getArtifact(runId, artifactId) {
      const run = this.get(runId);
      return (run?.artifacts ?? []).find((artifact) => artifact.id === artifactId) ?? null;
    },

    list() {
      return runs().map((run) => publicRun(run, persistenceWarning));
    },

    listRaw() {
      return runs();
    },

    async markInterruptedOnStartup() {
      const now = new Date().toISOString();
      const next = runs().map((run) => {
        if (run.status !== "running") return run;
        return {
          ...run,
          currentStep: "Interrupted by backend restart",
          errors: [...(run.errors ?? []), "Backend restarted while this AI job was running."],
          finishedAt: now,
          status: "interrupted",
          updatedAt: now,
          warnings: [...(run.warnings ?? []), "This job was interrupted by backend restart. Start it again from the same prompt if needed."],
        };
      });
      await saveAll(next);
      return next;
    },

    async markStalled({ thresholdMs = 120000 } = {}) {
      const now = Date.now();
      let changed = false;
      const next = runs().map((run) => {
        if (run.status !== "running") return run;
        const heartbeatTime = run.heartbeatAt ? Date.parse(run.heartbeatAt) : Date.parse(run.updatedAt ?? run.startedAt ?? run.queuedAt ?? 0);
        if (Number.isFinite(heartbeatTime) && now - heartbeatTime <= thresholdMs) return run;
        changed = true;
        return {
          ...run,
          currentStep: "Stalled",
          errors: [...(run.errors ?? []), "AI worker heartbeat stopped updating."],
          finishedAt: new Date().toISOString(),
          status: "stalled",
          warnings: [...(run.warnings ?? []), "This job stalled. Partial leaders were preserved; restart from the same prompt if needed."],
        };
      });
      if (changed) await saveAll(next);
      return next;
    },

    publicRun(run) {
      return publicRun(run, persistenceWarning);
    },

    async update(id, patch) {
      const next = runs().map((run) => (run.id === id ? { ...run, ...patch, updatedAt: new Date().toISOString() } : run));
      await saveAll(next);
      return publicRun(next.find((run) => run.id === id), persistenceWarning);
    },
  };
}
