export function progressPercent(completed = 0, total = 1) {
  const safeTotal = Math.max(1, Number(total) || 1);
  return Math.max(0, Math.min(100, Math.round((Number(completed) / safeTotal) * 100)));
}

export function mergeProgress(current = {}, patch = {}) {
  const completed = patch.completed ?? current.completed ?? 0;
  const total = patch.total ?? current.total ?? 1;

  return {
    completed,
    percent: patch.percent ?? progressPercent(completed, total),
    remainingSeconds: patch.remainingSeconds ?? current.remainingSeconds,
    total,
  };
}
