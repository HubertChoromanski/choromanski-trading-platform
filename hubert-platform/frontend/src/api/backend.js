const LOCAL_BACKEND_URL = "http://127.0.0.1:8787";

function isLocalBackendUrl(value) {
  return /^https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])(?::\d+)?/iu.test(String(value));
}

export function normalizeBackendUrl(value) {
  const raw = String(value ?? "").trim();
  const fallback = import.meta.env.PROD ? "/api" : LOCAL_BACKEND_URL;
  const normalized = (raw || fallback).replace(/\/+$/u, "");

  if (import.meta.env.PROD && isLocalBackendUrl(normalized)) {
    return "/api";
  }

  if (!normalized) {
    return import.meta.env.PROD ? "/api" : "";
  }

  if (/^\/api$/iu.test(normalized)) {
    return "/api";
  }

  if (/\/api$/iu.test(normalized)) {
    return normalized.replace(/\/api$/iu, "/api");
  }

  if (import.meta.env.PROD && !/^https?:\/\//iu.test(normalized)) {
    return `${normalized}/api`;
  }

  return normalized;
}

function normalizeApiPath(path) {
  const raw = String(path ?? "").trim();

  if (!raw) {
    return "";
  }

  if (/^https?:\/\//iu.test(raw)) {
    return raw;
  }

  const withSlash = raw.startsWith("/") ? raw : `/${raw}`;
  return withSlash.replace(/^\/api(?=\/|$)/iu, "");
}

export const BACKEND_URL = normalizeBackendUrl(
  import.meta.env.VITE_BACKEND_URL ?? undefined,
);

export const DASHBOARD_TOKEN = import.meta.env.VITE_DASHBOARD_TOKEN ?? "";

export function backendApiUrl(path) {
  const normalizedPath = normalizeApiPath(path);
  return /^https?:\/\//iu.test(normalizedPath)
    ? normalizedPath
    : `${BACKEND_URL}${normalizedPath}`;
}

export function dashboardAuthHeaders(extra = {}) {
  return {
    ...(DASHBOARD_TOKEN ? { "x-dashboard-token": DASHBOARD_TOKEN } : {}),
    ...extra,
  };
}
