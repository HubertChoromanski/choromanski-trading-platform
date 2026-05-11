import { compareRows } from "./comparisonReasoner.js";
import { detectContradictions } from "./contradictionDetector.js";
import { confidenceScore, riskAssessment } from "./confidenceScoring.js";
import { buildEvidence } from "./evidenceBuilder.js";
import { generateHypotheses } from "./hypothesisGenerator.js";
import { nextTests, operatorRecommendation } from "./recommendationEngine.js";
import { selfCritique } from "./selfCritique.js";
import { synthesizeNarrative } from "./narrativeSynthesizer.js";
import { uncertaintyFactors } from "./uncertaintyAnalyzer.js";

function classifyQuestion(question = "") {
  const lower = question.toLowerCase();
  if (lower.includes("overfit")) return "overfit";
  if (lower.includes("conservative") || lower.includes("fill")) return "fill-mode";
  if (lower.includes("weak month") || lower.includes("period") || /\bq[1-4]\b/i.test(question)) return "period";
  if (lower.includes("compare") || lower.includes("better than") || lower.includes("config #")) return "comparison";
  if (lower.includes("fake") || lower.includes("suspicious") || lower.includes("trust") || lower.includes("worr") || lower.includes("live")) return "critique";
  if (lower.includes("parameter") || lower.includes("atr") || lower.includes("bandwidth") || lower.includes("nwe") || lower.includes("max failure") || lower.includes("sizing")) return "parameter";
  if (lower.includes("rank") || lower.includes("best") || lower.includes("why")) return "ranking";
  return "general";
}

export function buildReasoningResponse({ question = "", row = null, rows = [], run = {} } = {}) {
  const selected = row ?? rows[0] ?? {};
  if (!selected || !Object.keys(selected).length) {
    return {
      answer: "I do not have a ranked result to analyze yet. Run a research job first, then ask me about the result.",
      confidence: { label: "low", reasons: ["No result row is available."], score: 0 },
      critique: { summary: "No evidence was available.", warnings: ["No completed result row."] },
      evidence: [`Run: ${run?.id ?? "none"}`],
      nextAction: "Run a small research prompt or open a completed run.",
      risk: { label: "high", reasons: ["No result row is available."] },
      sections: [{ body: "No result row is available.", title: "Conclusion" }],
    };
  }

  const intent = classifyQuestion(question);
  const confidence = confidenceScore({ row: selected, rows });
  const risk = riskAssessment({ row: selected });
  const evidence = buildEvidence({ row: selected, rows, run });
  const contradictions = detectContradictions({ row: selected, rows });
  const uncertainties = uncertaintyFactors({ row: selected });
  const hypotheses = generateHypotheses({ question, row: selected });
  const comparisons = compareRows({ row: selected, rows });
  const next = nextTests({ question, row: selected, rows });
  const recommendation = operatorRecommendation({ confidence, risk, row: selected });
  const critique = selfCritique({ confidence, risk, row: selected });
  const narrative = synthesizeNarrative({
    confidence,
    contradictions: intent === "comparison" ? comparisons : contradictions,
    evidence: evidence.bullets,
    hypotheses,
    next,
    question,
    recommendation,
    risk,
    row: selected,
  });

  const sections = [...narrative.sections];
  if (intent === "comparison") sections.splice(2, 0, { bullets: comparisons, title: "Comparison" });
  if (intent === "critique" || intent === "overfit") {
    sections.splice(2, 0, { bullets: critique.warnings.length ? critique.warnings : [critique.summary], title: "What Worries Me" });
  }
  sections.push({ bullets: uncertainties, title: "Uncertainty" });

  return {
    answer: narrative.answer,
    confidence,
    critique,
    evidence: evidence.bullets,
    intent,
    nextAction: next[0] ?? "Re-run exact config if you want parity against the manual backtest panel.",
    recommendation,
    risk,
    row: selected,
    sections,
  };
}

export function buildRunReasoningSummary({ run = {}, rows = [] } = {}) {
  const top = rows[0] ?? null;
  if (!top) {
    return {
      confidence: { label: "low", score: 0 },
      headline: "No ranked rows were available.",
      risks: ["No candidate could be evaluated."],
    };
  }
  const reasoning = buildReasoningResponse({
    question: "Produce a research report summary and criticize the top candidate.",
    row: top,
    rows,
    run,
  });
  return {
    confidence: reasoning.confidence,
    headline: reasoning.sections.find((section) => section.title === "Conclusion")?.body ?? reasoning.answer,
    risks: reasoning.risk.reasons,
    sections: reasoning.sections,
  };
}
