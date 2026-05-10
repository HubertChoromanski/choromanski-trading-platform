import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "../../..");
const ALLOWED_ROOTS = [
  path.join(PROJECT_ROOT, "backend/src"),
  path.join(PROJECT_ROOT, "hubert-platform/frontend/src"),
];
const BLOCKED_PARTS = new Set([".git", "node_modules", "dist", "build", "data", "logs"]);
const BLOCKED_FILE_PATTERN = /(^|\/)(\.env|.*\.pem|.*secret.*|.*token.*)$/iu;
const MAX_SNIPPET_CHARS = 16_000;
const MAX_MAP_FILES = 260;

function isAllowedPath(filePath) {
  const resolved = path.resolve(PROJECT_ROOT, filePath);
  return ALLOWED_ROOTS.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

function isBlocked(filePath) {
  const relative = path.relative(PROJECT_ROOT, filePath);
  if (BLOCKED_FILE_PATTERN.test(relative)) return true;
  return relative.split(path.sep).some((part) => BLOCKED_PARTS.has(part));
}

async function walk(dir, files = []) {
  if (files.length >= MAX_MAP_FILES) return files;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (isBlocked(fullPath)) continue;
    if (entry.isDirectory()) {
      await walk(fullPath, files);
    } else if (/\.(js|jsx|css|json|cjs)$/iu.test(entry.name)) {
      files.push(fullPath);
    }
    if (files.length >= MAX_MAP_FILES) break;
  }

  return files;
}

function classify(relative) {
  if (relative.includes("/components/")) return "frontend component";
  if (relative.includes("/backtest/")) return "backtest engine";
  if (relative.includes("/engine/")) return "strategy engine";
  if (relative.includes("/indicators/")) return "indicator logic";
  if (relative.includes("/api/")) return "frontend data API";
  if (relative.includes("backend/src/ai/")) return "AI module";
  if (relative.includes("backend/src/exchanges/")) return "exchange connector";
  if (relative.includes("backend/src/execution/")) return "execution backend";
  if (relative.includes("backend/src/strategy/")) return "backend strategy/data provider";
  if (relative.endsWith("backend/src/index.js")) return "backend routes";
  return "supporting file";
}

export async function buildCodeMap() {
  const files = (await Promise.all(ALLOWED_ROOTS.map((root) => walk(root)))).flat();
  const rows = [];

  for (const filePath of files.slice(0, MAX_MAP_FILES)) {
    const relative = path.relative(PROJECT_ROOT, filePath);
    const info = await stat(filePath).catch(() => null);
    rows.push({
      category: classify(relative),
      path: relative,
      size: info?.size ?? 0,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    projectRoot: path.basename(PROJECT_ROOT),
    scannedFiles: rows.length,
    sections: rows.reduce((groups, row) => {
      groups[row.category] = groups[row.category] ?? [];
      groups[row.category].push(row);
      return groups;
    }, {}),
  };
}

export async function readSafeCodeSnippet({ filePath, line = 1, window = 80 } = {}) {
  const relative = String(filePath ?? "").replaceAll("\\", "/");
  const absolutePath = path.resolve(PROJECT_ROOT, relative);

  if (!relative || !isAllowedPath(relative) || isBlocked(absolutePath)) {
    throw new Error("That file is outside the safe AI code-inspection area.");
  }

  const text = await readFile(absolutePath, "utf8");
  if (text.length > MAX_SNIPPET_CHARS * 8) {
    throw new Error("That file is too large for direct AI inspection. Ask for a smaller file.");
  }

  const lines = text.split("\n");
  const start = Math.max(1, Number(line) || 1);
  const size = Math.max(10, Math.min(Number(window) || 80, 160));
  const from = Math.max(1, start - Math.floor(size / 2));
  const to = Math.min(lines.length, from + size - 1);
  const snippet = lines
    .slice(from - 1, to)
    .map((content, index) => `${from + index}: ${content}`)
    .join("\n")
    .slice(0, MAX_SNIPPET_CHARS);

  return {
    from,
    path: relative,
    snippet,
    to,
    totalLines: lines.length,
  };
}
