const DEFAULT_SAFE_MAX = 1000;
const ADVANCED_HARD_MAX = 5000;

export function checkAgentPlanSafety(plan, options = {}) {
  const warnings = [];
  const maxCombinations = Number(plan.maxCombinations ?? 0);
  const confirmed = Boolean(options.confirmLargeJob || options.confirmed);

  if (maxCombinations > ADVANCED_HARD_MAX) {
    return {
      ok: false,
      code: "COMBINATION_LIMIT",
      message: `This job asks for ${maxCombinations} combinations. The hard safety cap is ${ADVANCED_HARD_MAX}.`,
      warnings,
    };
  }

  if (maxCombinations > DEFAULT_SAFE_MAX && !confirmed) {
    return {
      ok: false,
      code: "CONFIRMATION_REQUIRED",
      message: `This job asks for ${maxCombinations} combinations. Confirm the large run before starting it.`,
      needsConfirmation: true,
      warnings,
    };
  }

  if ((plan.timeframes?.length ?? 0) > 3 && maxCombinations > 500 && !confirmed) {
    return {
      ok: false,
      code: "CONFIRMATION_REQUIRED",
      message: "Multi-timeframe optimization above 500 tests needs confirmation.",
      needsConfirmation: true,
      warnings,
    };
  }

  if (maxCombinations > DEFAULT_SAFE_MAX) {
    warnings.push(`Large job confirmed: ${maxCombinations} combinations. Progress is batched and can be cancelled.`);
  }

  return {
    ok: true,
    warnings,
  };
}
