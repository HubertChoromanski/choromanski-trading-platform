export function designAdaptiveExperiment(task = {}) {
  const combinations = Number(task.requestedCombinations ?? 500);
  return {
    stages: [
      { allocation: Math.round(combinations * 0.45), name: "coarse exploration", purpose: "cover broad parameter space" },
      { allocation: Math.round(combinations * 0.25), name: "cluster selection", purpose: "identify promising PF/win/net/DD regions" },
      { allocation: Math.round(combinations * 0.2), name: "focused exploitation", purpose: "test denser neighboring values around leaders" },
      { allocation: Math.max(1, combinations - Math.round(combinations * 0.9)), name: "robustness validation", purpose: "check fill mode, periods, and sensitivity where available" },
    ],
    methodology: task.methodology ?? "adaptive multi-stage search",
    objectivePolicy: "multi-objective; do not rank only by raw PnL",
  };
}
