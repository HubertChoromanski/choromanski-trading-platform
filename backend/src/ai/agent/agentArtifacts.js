function safeName(value = "agent-artifact") {
  return String(value)
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "agent-artifact";
}

export function createAgentArtifact({ content, format = "json", name, type = "report" }) {
  const extension = format === "csv" ? "csv" : format === "md" ? "md" : "json";

  return {
    content,
    createdAt: new Date().toISOString(),
    fileName: `${safeName(name ?? type)}.${extension}`,
    format,
    id: `agent-artifact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    mime: format === "csv" ? "text/csv" : format === "md" ? "text/markdown" : "application/json",
    name: name ?? type,
    type,
  };
}

export function artifactPreview(artifact) {
  if (!artifact) return null;

  return {
    createdAt: artifact.createdAt,
    fileName: artifact.fileName,
    format: artifact.format,
    id: artifact.id,
    mime: artifact.mime,
    name: artifact.name,
    type: artifact.type,
  };
}
