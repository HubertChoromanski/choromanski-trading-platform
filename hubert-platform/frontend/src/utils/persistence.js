export const LEGACY_PLATFORM_STORAGE_KEY = "hbb-platform-state-v1";
export const LEGACY_STRATEGY_LAB_STORAGE_KEY = "hbb-strategy-lab-state-v1";
export const PLATFORM_STORAGE_KEY = "choromanski-platform-state-v1";
export const STRATEGY_LAB_STORAGE_KEY = "choromanski-strategy-lab-state-v1";

export function readStoredJson(key, fallback = null) {
  try {
    const rawValue = window.localStorage.getItem(key);

    return rawValue ? JSON.parse(rawValue) : fallback;
  } catch {
    return fallback;
  }
}

export function writeStoredJson(key, value) {
  window.localStorage.setItem(key, JSON.stringify(value));
}

export function readPlatformState() {
  return readStoredJson(
    PLATFORM_STORAGE_KEY,
    readStoredJson(LEGACY_PLATFORM_STORAGE_KEY, {}),
  );
}

export function readStrategyLabState() {
  return readStoredJson(
    STRATEGY_LAB_STORAGE_KEY,
    readStoredJson(LEGACY_STRATEGY_LAB_STORAGE_KEY, {}),
  );
}
