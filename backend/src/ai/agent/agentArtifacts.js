function safeName(value = "agent-artifact") {
  return String(value)
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "agent-artifact";
}

export function createAgentArtifact({ content, format = "json", name, type = "report" }) {
  const encodedContent = Buffer.isBuffer(content) ? content.toString("base64") : content;
  const extension = {
    csv: "csv",
    docx: "docx",
    html: "html",
    json: "json",
    md: "md",
    xlsx: "xlsx",
    zip: "zip",
  }[format] ?? "json";
  const mime = {
    csv: "text/csv",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    html: "text/html",
    json: "application/json",
    md: "text/markdown",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    zip: "application/zip",
  }[format] ?? "application/json";

  return {
    content: encodedContent,
    createdAt: new Date().toISOString(),
    encoding: Buffer.isBuffer(content) ? "base64" : undefined,
    fileName: `${safeName(name ?? type)}.${extension}`,
    format,
    id: `agent-artifact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    mime,
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
