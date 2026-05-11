import { createAgentArtifact } from "../agent/agentArtifacts.js";
import { rowsToCsv } from "../agent/agentReportComposer.js";
import { buildFileManifest } from "./fileManifest.js";
import { writeAgentOSMarkdown } from "./reportWriter.js";

function xmlEscape(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function metric(row = {}, key) {
  return row.canonical?.metrics?.[key] ?? row.metrics?.[key] ?? row[key] ?? "";
}

function rrr(row = {}) {
  return metric(row, "rrr") || "RRR unavailable";
}

function avgR(row = {}) {
  return metric(row, "avgR") || row.averageR || "Avg R unavailable";
}

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ -1) >>> 0;
}

function dosTimeDate(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = (date.getFullYear() - 1980) << 9 | ((date.getMonth() + 1) << 5) | date.getDate();
  return { day, time };
}

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function zipStore(files = []) {
  const now = dosTimeDate();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  files.forEach((file) => {
    const name = Buffer.from(file.name);
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data));
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(now.time), u16(now.day), u32(crc),
      u32(data.length), u32(data.length), u16(name.length), u16(0), name, data,
    ]);
    localParts.push(local);
    centralParts.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(now.time), u16(now.day), u32(crc),
      u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name,
    ]));
    offset += local.length;
  });
  const central = Buffer.concat(centralParts);
  return Buffer.concat([
    ...localParts,
    central,
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(central.length), u32(offset), u16(0),
  ]);
}

function sheetXml(rows = []) {
  const rowXml = rows.map((row, rowIndex) => {
    const cells = row.map((cell, columnIndex) => {
      const ref = `${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}`;
      return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(cell)}</t></is></c>`;
    }).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`;
}

function rowsForExcel(rows = []) {
  return [
    ["Rank", "Score", "Net", "PF", "Win %", "RRR", "Avg R / trade", "DD", "Trades", "BW", "NWE", "ATR Length", "ATR Mult", "Max Failures", "Sizing", "Fill Mode", "Range"],
    ...rows.map((row) => [
      row.rank ?? "",
      row.score ?? "",
      metric(row, "netProfit") ?? metric(row, "netPnl"),
      metric(row, "profitFactor"),
      metric(row, "winRate"),
      rrr(row),
      avgR(row),
      metric(row, "maxDrawdown"),
      metric(row, "totalTrades") ?? metric(row, "trades"),
      row.params?.bandwidth,
      row.params?.envelopeMultiplier,
      row.params?.atrLength,
      row.params?.atrMultiplier,
      row.params?.maxSameSideFailures,
      `${row.params?.sizingMode ?? ""} ${row.params?.sizingValue ?? ""}`,
      row.params?.fillMode ?? row.fillMode,
      `${row.provenance?.from ?? row.canonical?.range?.from ?? ""} to ${row.provenance?.to ?? row.canonical?.range?.to ?? ""}`,
    ]),
  ];
}

function buildXlsx({ output = {}, plan = {} }) {
  const rows = output.rankedResults ?? output.rows ?? [];
  const winners = output.categoryWinners ?? {};
  const summaryRows = [
    ["Field", "Value"],
    ["Symbol", plan.symbol ?? "SOLUSDT"],
    ["Timeframe", plan.timeframe ?? "15m"],
    ["Range", `${plan.range?.from ?? ""} to ${plan.range?.to ?? ""}`],
    ["Methodology", plan.methodology ?? "agent_os"],
    ["Best PF Rank", winners.bestPF?.rank ?? ""],
    ["Best Win Rank", winners.bestWinRate?.rank ?? ""],
    ["Best Net Rank", winners.bestNetProfit?.rank ?? ""],
    ["Lowest DD Rank", winners.lowestDrawdown?.rank ?? ""],
    ["Best Overall Rank", winners.bestOverall?.rank ?? ""],
  ];
  const sheets = [
    { id: 1, name: "Summary", rows: summaryRows },
    { id: 2, name: "All tested configs", rows: rowsForExcel(rows) },
    { id: 3, name: "Top by PF", rows: rowsForExcel([winners.bestPF].filter(Boolean)) },
    { id: 4, name: "Top by win", rows: rowsForExcel([winners.bestWinRate].filter(Boolean)) },
    { id: 5, name: "Top by net", rows: rowsForExcel([winners.bestNetProfit].filter(Boolean)) },
    { id: 6, name: "Top low DD", rows: rowsForExcel([winners.lowestDrawdown].filter(Boolean)) },
    { id: 7, name: "Overall ranking", rows: rowsForExcel([winners.bestOverall].filter(Boolean)) },
  ];
  return zipStore([
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((sheet) => `<Override PartName="/xl/worksheets/sheet${sheet.id}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: "xl/workbook.xml", data: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sheet) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${sheet.id}" r:id="rId${sheet.id}"/>`).join("")}</sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((sheet) => `<Relationship Id="rId${sheet.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${sheet.id}.xml"/>`).join("")}</Relationships>` },
    ...sheets.map((sheet) => ({ name: `xl/worksheets/sheet${sheet.id}.xml`, data: sheetXml(sheet.rows) })),
  ]);
}

function buildDocx(markdown = "") {
  const paragraphs = markdown.split(/\n+/).map((line) => `<w:p><w:r><w:t>${xmlEscape(line)}</w:t></w:r></w:p>`).join("");
  return zipStore([
    { name: "[Content_Types].xml", data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>` },
    { name: "_rels/.rels", data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: "word/document.xml", data: `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>` },
  ]);
}

export function createAgentOSArtifacts({ output = {}, plan = {}, run = {} } = {}) {
  const markdown = writeAgentOSMarkdown({ output, plan, run });
  const rows = output.rankedResults ?? output.rows ?? [];
  const artifacts = [
    createAgentArtifact({ content: markdown, format: "md", name: "agent-os-report", type: "agent-os-markdown-report" }),
    createAgentArtifact({ content: JSON.stringify({ output, plan, runId: run.id }, null, 2), format: "json", name: "agent-os-result", type: "agent-os-json" }),
    createAgentArtifact({ content: rowsToCsv(rows), format: "csv", name: "agent-os-ranking", type: "agent-os-csv" }),
  ];
  if (plan.artifacts?.docx || plan.artifactFormats?.includes("docx")) {
    artifacts.push(createAgentArtifact({ content: buildDocx(markdown), format: "docx", name: "agent-os-report", type: "agent-os-word-report" }));
  }
  if (plan.artifacts?.xlsx || plan.artifactFormats?.includes("xlsx")) {
    artifacts.push(createAgentArtifact({ content: buildXlsx({ output, plan }), format: "xlsx", name: "agent-os-workbook", type: "agent-os-excel-workbook" }));
  }
  const manifest = buildFileManifest(artifacts, {
    range: plan.range,
    symbol: plan.symbol,
    timeframe: plan.timeframe,
    toolPlan: plan.toolsPlanned,
  });
  artifacts.push(createAgentArtifact({ content: JSON.stringify(manifest, null, 2), format: "json", name: "agent-os-manifest", type: "agent-os-manifest" }));
  return artifacts;
}
