const RUN_LIMIT = 80;

function publicRun(run) {
  if (!run) return null;
  return {
    artifacts: (run.artifacts ?? []).map(({ content, ...artifact }) => artifact),
    currentStep: run.currentStep,
    errors: run.errors ?? [],
    finishedAt: run.finishedAt,
    id: run.id,
    parsedIntent: run.parsedIntent,
    plan: run.plan,
    progress: run.progress,
    prompt: run.prompt,
    resultSummary: run.resultSummary,
    startedAt: run.startedAt,
    status: run.status,
    warnings: run.warnings ?? [],
  };
}

export function createAgentRunStore({ store }) {
  async function saveAll(runs) {
    await store.setCollection("aiAgentRuns", runs.slice(0, RUN_LIMIT));
  }

  function runs() {
    return store.getCollection("aiAgentRuns") ?? [];
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
      return this.update(id, { cancelRequested: true });
    },

    async create({ plan, prompt, warnings = [] }) {
      const run = {
        artifacts: [],
        cancelRequested: false,
        currentStep: "Queued",
        errors: [],
        id: `agent-run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        logs: [],
        parsedIntent: plan.kind,
        plan,
        progress: { completed: 0, percent: 0, total: plan.maxCombinations ?? 1 },
        prompt,
        resultSummary: null,
        startedAt: new Date().toISOString(),
        status: "queued",
        warnings,
      };
      await saveAll([run, ...runs().filter((item) => item.id !== run.id)]);
      return publicRun(run);
    },

    get(id) {
      return runs().find((run) => run.id === id) ?? null;
    },

    getArtifact(runId, artifactId) {
      const run = this.get(runId);
      return (run?.artifacts ?? []).find((artifact) => artifact.id === artifactId) ?? null;
    },

    list() {
      return runs().map(publicRun);
    },

    publicRun,

    async update(id, patch) {
      const next = runs().map((run) => (run.id === id ? { ...run, ...patch } : run));
      await saveAll(next);
      return publicRun(next.find((run) => run.id === id));
    },
  };
}
