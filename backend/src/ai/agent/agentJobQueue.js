const DEFAULT_WORKER_CONCURRENCY = 3;
const DEFAULT_STALLED_THRESHOLD_MS = 120000;

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(number, max));
}

function workerConcurrency() {
  const requested = Number(process.env.AI_AGENT_WORKER_CONCURRENCY ?? DEFAULT_WORKER_CONCURRENCY);
  const explicitHighCap = process.env.AI_AGENT_ALLOW_HIGH_WORKER_CONCURRENCY === "true";
  return clamp(requested, 1, explicitHighCap ? 12 : 6);
}

export function createAgentJobQueue({ executor, runStore }) {
  const queue = [];
  const active = new Set();
  const concurrency = workerConcurrency();
  const stalledThresholdMs = Number(process.env.AI_AGENT_STALLED_THRESHOLD_MS ?? DEFAULT_STALLED_THRESHOLD_MS);
  const workerIdPrefix = `ai-worker-${process.pid}`;
  let started = false;
  let tickTimer = null;
  let stalledTimer = null;

  function enqueue(id) {
    if (!id) return;
    if (queue.includes(id) || active.has(id)) return;
    const run = runStore.get(id);
    if (!run || run.status !== "queued") return;
    queue.push(id);
    setTimeout(processQueue, 0);
  }

  function enqueuePersistedQueuedRuns() {
    for (const run of runStore.listRaw()) {
      if (run.status === "queued") enqueue(run.id);
    }
  }

  async function runWorker(runId) {
    active.add(runId);
    const workerId = `${workerIdPrefix}-${runId.slice(-6)}`;
    try {
      await runStore.heartbeat(runId, {
        currentStep: "Worker claimed job",
        startedAt: runStore.get(runId)?.startedAt ?? new Date().toISOString(),
        status: "running",
        workerId,
      });
      await executor.execute(runId);
    } catch (error) {
      await runStore.update(runId, {
        currentStep: "Failed",
        errors: [...(runStore.get(runId)?.errors ?? []), error instanceof Error ? error.message : String(error)],
        finishedAt: new Date().toISOString(),
        status: "failed",
      });
    } finally {
      active.delete(runId);
      setTimeout(processQueue, 0);
    }
  }

  function processQueue() {
    while (active.size < concurrency && queue.length > 0) {
      const runId = queue.shift();
      const run = runStore.get(runId);
      if (!run || run.status !== "queued") continue;
      runWorker(runId);
    }
  }

  async function start() {
    if (started) return;
    started = true;
    await runStore.markInterruptedOnStartup();
    enqueuePersistedQueuedRuns();
    tickTimer = setInterval(() => {
      enqueuePersistedQueuedRuns();
      processQueue();
    }, 2000);
    stalledTimer = setInterval(() => {
      runStore.markStalled({ thresholdMs: stalledThresholdMs }).catch((error) => {
        console.warn(`[ai-agent] stalled job check failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, Math.min(stalledThresholdMs, 30000));
  }

  function status() {
    return {
      activeWorkerCount: active.size,
      concurrency,
      queuedCount: queue.length,
      stalledThresholdMs,
    };
  }

  function stop() {
    if (tickTimer) clearInterval(tickTimer);
    if (stalledTimer) clearInterval(stalledTimer);
    tickTimer = null;
    stalledTimer = null;
    started = false;
  }

  return {
    enqueue,
    start,
    status,
    stop,
  };
}
