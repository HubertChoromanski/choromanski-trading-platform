import { createAgentExecutor } from "./agentExecutor.js";
import { createAgentJobQueue } from "./agentJobQueue.js";
import { createAgentPlan } from "./agentPlanner.js";
import { createAgentRunStore } from "./agentRunStore.js";
import { checkAgentPlanSafety } from "./agentRiskGuard.js";
import { createAgentToolRegistry } from "./agentToolRegistry.js";
import {
  clarificationForIntent,
  describeResearchAssumptions,
  isResearchPlanningMessage,
  researchIntentToPlanOptions,
  updateResearchIntent,
} from "./conversationResearchIntent.js";
import { composeAgentMarkdown, rowsToCsv } from "./agentReportComposer.js";
import { metricDiff as diffMetrics, normalizeResearchResult, summarizeIntegrity } from "./agentResultIntegrity.js";
import { buildReasoningResponse } from "../reasoning/reasoningEngine.js";
import { agentOSToolCatalog, createAgentOSPendingOperation, isAgentOSGoal, planAgentOSTask } from "../agentOS/agentOS.js";

function isPolishQuestion(value = "") {
  const normalized = String(value)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  return /(^|\s)(czy|co|czemu|dlaczego|jak|gdzie|ile|pokaz|porownaj|wynik|dziala|nadal|robi|robia|ustawienia|blad|gorszy|lepszy|optymalnie|analiz|uzyj|ignoruj|bez|bazeline|baseline|chce|zebys|zrobil|badani|badania|zakres|katem|ostatnie|dni|nazwij|uwaga|okres|testow|testy)(\s|$)/u.test(normalized);
}

function normalizeCommandText(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

const LIVE_ACTION_VERBS = "(?:zmien|ustaw|przesun|move|set|change)";

function hasResearchPriorityIntent(message = "") {
  const normalized = normalizeCommandText(message);
  return /(test|backtest|sweep|kombinacj|ustawien|ustawienia|zakres|optymaliz|adaptive|najlepsze\s+ustawien|pf|profit factor|skutecznosc|skuteczność|drawdown|\bdd\b|metoda|ranking|rankingu|badanie|research)/i.test(normalized) ||
    isResearchPlanningMessage(message);
}

function hasExplicitLiveActionIntent(message = "") {
  const normalized = normalizeCommandText(message);
  const slOrTpAction = new RegExp(`(?:\\b${LIVE_ACTION_VERBS}\\b.{0,50}\\b(?:sl|tp)\\b|\\b(?:sl|tp)\\b.{0,50}\\b${LIVE_ACTION_VERBS}\\b)`, "i");
  return slOrTpAction.test(normalized) ||
    /(zamknij|close).*(pozyc|position)|\bclose position\b/i.test(normalized) ||
    /(cancel|anuluj|skasuj).*(orders|order|zlecen|protection)|cancel orders/i.test(normalized) ||
    /\b(market\s+(long|short)|otworz|otwórz|open).{0,30}\b(long|short)\b/i.test(normalized);
}

function isDateLikeNumberAt(source = "", index = -1) {
  if (index < 0) return false;
  return /^\d{4}[.-]\d{1,2}[.-]\d{1,2}/.test(source.slice(index));
}

function extractLiveActionPrice(normalized = "", target = "sl") {
  const patterns = [
    new RegExp(`\\b${target}\\b.{0,40}\\b(?:na|to|at|=)\\s*([0-9]+(?:[.,][0-9]+)?)`, "i"),
    new RegExp(`\\b${LIVE_ACTION_VERBS}\\b.{0,40}\\b${target}\\b.{0,40}\\b(?:na|to|at|=)?\\s*([0-9]+(?:[.,][0-9]+)?)`, "i"),
    new RegExp(`\\b${target}\\b\\s+([0-9]+(?:[.,][0-9]+)?)`, "i"),
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (!match?.[1]) continue;
    const numberIndex = match.index + match[0].lastIndexOf(match[1]);
    if (isDateLikeNumberAt(normalized, numberIndex)) continue;
    const price = Number(match[1].replace(",", "."));
    if (Number.isFinite(price)) return price;
  }
  return null;
}

function detectLiveExecutionIntent(message = "") {
  const normalized = normalizeCommandText(message);
  if (!hasExplicitLiveActionIntent(message)) return null;

  const slAction = new RegExp(`(?:\\b${LIVE_ACTION_VERBS}\\b.{0,50}\\bsl\\b|\\bsl\\b.{0,50}\\b${LIVE_ACTION_VERBS}\\b)`, "i");
  const tpAction = new RegExp(`(?:\\b${LIVE_ACTION_VERBS}\\b.{0,50}\\btp\\b|\\btp\\b.{0,50}\\b${LIVE_ACTION_VERBS}\\b)`, "i");

  if (slAction.test(normalized)) {
    return { action: "MOVE_SL", label: "Move SL", price: extractLiveActionPrice(normalized, "sl") };
  }
  if (tpAction.test(normalized)) {
    return { action: "MOVE_TP", label: "Move TP", price: extractLiveActionPrice(normalized, "tp") };
  }
  if (/(zamknij|close).*(pozyc|position)|\bclose position\b/i.test(normalized)) {
    return { action: "CLOSE_POSITION", label: "Close Position", price: null };
  }
  if (/(cancel|anuluj|skasuj).*(orders|order|zlecen|protection)|cancel orders/i.test(normalized)) {
    return { action: "CANCEL_ATTACHED_ORDERS", label: "Cancel Protection/Orders", price: null };
  }
  return null;
}

function isResearchActionRequest(message = "") {
  const normalized = normalizeCommandText(message);
  return /(zrob|zrobil|zrób|uruchom|odpal|run|start|przetestuj|testuj|backtestuj|znajdz|znajdź|szukaj|optimi[sz]e|optymaliz|porownaj|porównaj|compare|analy[sz]e|analizuj|zbadaj|sprawdz|sprawdź)\b/i.test(normalized);
}

function isConversationalExplanationQuestion(message = "") {
  const normalized = normalizeCommandText(message);
  if (!normalized.trim()) return false;
  if (isResearchActionRequest(message)) return false;

  const conceptQuestion =
    /(o co chodzi(?:\s+z)?|co to znaczy|co oznacza|co to jest|czym jest|jak dziala|jak działa|w jaki sposob|w jaki sposób|po co|czy to oznacza|what is|what does|what are|how does|explain|meaning of)/i.test(normalized);
  if (conceptQuestion) return true;

  const asksWhyConcept = /(czemu|dlaczego|why)\b/i.test(normalized) &&
    /(baseline|hubert|adaptive|search|metodolog|methodolog|uzywasz|używasz|oznacza|means)/i.test(normalized) &&
    !/(nie dziala|nie działa|failed|failure|error|blad|błąd|problem|sl|tp|order|position|pozyc|config|konfig|ranking|rank|wynik|result|pf|profit factor|drawdown|dd|lepszy|gorszy|better|worse|backtest|porownaj|porównaj|compare)/i.test(normalized);
  return asksWhyConcept;
}

function activeResearchBaseline(memory = {}) {
  const baseline = memory?.researchIntent?.baselineQuery;
  return baseline ? String(baseline) : "";
}

function buildDirectConversationAnswer({ message = "", memory = {} } = {}) {
  const normalized = normalizeCommandText(message);
  const polish = isPolishQuestion(message) || /[ąćęłńóśźż]/i.test(message);
  const activeBaseline = activeResearchBaseline(memory);
  const mentionsHubert = /\bhubert\b/i.test(normalized);
  const mentionsBaseline = /(baseline|bazeline|baza odniesienia|punkt odniesienia)/i.test(normalized);
  const mentionsAdaptive = /(adaptive|adaptacyj|two-stage|dwustopni|search)/i.test(normalized);

  if (mentionsBaseline || mentionsHubert) {
    const answer = polish
      ? [
          "Baseline to po prostu punkt odniesienia.",
          "W AH może nim być np. zapisany backtest „hubert”, żeby nowe wyniki porównywać do czegoś, co już uważasz za dobre.",
          activeBaseline
            ? `Aktualnie w planie tej rozmowy baseline to „${activeBaseline}”.`
            : "Nie podpinam „hubert” automatycznie do każdego badania; użyję go tylko wtedy, gdy o to poprosisz albo potwierdzisz.",
          "Mogę też działać całkowicie bez baseline.",
        ].join(" ")
      : [
          "A baseline is simply a reference point.",
          "In AH it can be a saved backtest such as “hubert”, so new results can be compared against something you already trust.",
          activeBaseline
            ? `The active research plan currently uses “${activeBaseline}” as baseline.`
            : "I do not attach “hubert” automatically to every research run; I use it only when you ask or confirm it.",
          "AH can also run research without any baseline.",
        ].join(" ");
    return {
      answer,
      confidence: {
        label: "high",
        reason: "This is a concept explanation, so AH answered before research planning.",
        score: 90,
      },
      evidence: [
        "Detected explanation/conversation intent before research planning.",
        activeBaseline ? `Active conversation baseline: ${activeBaseline}` : "No active baseline is attached to this conversation plan.",
        "No pending operation was created.",
      ],
      intent: "conversation-explanation",
      nextAction: polish
        ? "Jeśli chcesz, możesz napisać: „użyj hubert jako baseline” albo „ignoruj hubert”."
        : "If you want, say “use hubert as baseline” or “ignore hubert”.",
      recommendation: polish
        ? "Traktuj baseline jako porównanie, nie jako obowiązkową część badania."
        : "Treat a baseline as a comparison point, not a required part of research.",
      risk: { label: "low", reasons: ["Explanation only; no research job was prepared or started."] },
      sections: [],
    };
  }

  if (mentionsAdaptive) {
    const answer = polish
      ? [
          "Adaptive search to sposób szukania parametrów w etapach.",
          "Najpierw robi się szerszy, grubszy przegląd, potem zawęża testy wokół najlepszych klastrów parametrów.",
          "W tej platformie oznacza to praktycznie dwustopniowy sweep i walidację, nie pełną Bayesian optimization.",
          "Czyli: mniej ślepego brute force, więcej stopniowego zawężania, ale nadal bez gwarancji znalezienia idealnego optimum.",
        ].join(" ")
      : [
          "Adaptive search means searching parameters in stages.",
          "First you run a broader coarse scan, then narrow around the strongest parameter clusters.",
          "In this platform it currently means a two-stage sweep plus validation, not full Bayesian optimization.",
          "So it is less blind brute force, but it still does not guarantee the perfect optimum.",
        ].join(" ");
    return {
      answer,
      confidence: {
        label: "high",
        reason: "This is a concept explanation, not a request to run research.",
        score: 88,
      },
      evidence: [
        "Detected explanation/conversation intent before research planning.",
        "No combinations, methodology choice, or pending operation was injected into the answer.",
      ],
      intent: "conversation-explanation",
      nextAction: polish
        ? "Jeśli chcesz to uruchomić, napisz wprost: „zrób adaptive search dla ...”."
        : "If you want to run it, say explicitly: “run adaptive search for ...”.",
      recommendation: polish
        ? "Używaj adaptive search, gdy chcesz najpierw znaleźć okolice dobrych parametrów, a potem je dopracować."
        : "Use adaptive search when you want to find promising parameter regions first, then refine them.",
      risk: { label: "low", reasons: ["Explanation only; no research job was prepared or started."] },
      sections: [],
    };
  }

  return {
    answer: polish
      ? "Najpierw odpowiem wprost: pytasz o wyjaśnienie, więc nie uruchamiam żadnego researchu ani planu. Doprecyzuj, które pojęcie mam rozłożyć na prostsze słowa, a odpowiem krótko i praktycznie."
      : "Directly: you are asking for an explanation, so I am not starting research or building a plan. Tell me which term you want unpacked and I will explain it plainly.",
    confidence: {
      label: "medium",
      reason: "Explanation intent was clear, but the exact concept was not specific enough.",
      score: 64,
    },
    evidence: ["Detected explanation/conversation intent before research planning.", "No pending operation was created."],
    intent: "conversation-explanation",
    nextAction: polish ? "Podaj pojęcie albo przycisk, który mam wyjaśnić." : "Name the term or button you want explained.",
    recommendation: polish ? "Zadaj krótkie pytanie w stylu: „co to znaczy X?”" : "Ask a short question like: “what does X mean?”",
    risk: { label: "low", reasons: ["Explanation only."] },
    sections: [],
  };
}

function inferCopilotIntent(message = "", mode = "research") {
  const normalized = normalizeCommandText(message);
  const asksAboutButtons = /(przycisk|przyciski|button|buttons|verify integrity|re[- ]?run|rerun|open backtest|show metric diff)/i.test(normalized);
  const asksLimits = /(czego ai nie moze|czego ai nie może|what can.?t ai|what cannot ai|limitations|ograniczenia|nie moze jeszcze|nie może jeszcze)/i.test(normalized);
  const asksFailure = /(czemu|dlaczego|why|nie dziala|nie działa|failed|failure|error|blad|błąd|problem|unreachable|stale|lag)/i.test(normalized);
  const asksCode = /(kod|code|trace|sciezka|ścieżka|route|endpoint|function|plik|file|gdzie jest|where is)/i.test(normalized);
  const asksResearchRun = hasResearchPriorityIntent(message);
  const asksBaselineDefinition = /(co to|czym jest|what is).*(baseline|hubert)|baseline hubert.*(co to|czym jest|what is)/i.test(normalized);
  const asksResult = /(config|konfig|ranking|rank|wynik|result|pf|profit factor|drawdown|dd|hubert|baseline|backtest|lepszy|gorszy|better|worse|porownaj|porównaj|compare|pelna analiz|pełna analiz|deep analysis|full analysis)/i.test(normalized);
  const asksChart = /(chart|wykres|candle|swiec|świec|timeframe|zakres|range|equity|drawdown)/i.test(normalized);

  if (isConversationalExplanationQuestion(message)) return "conversation-explanation";
  if (asksAboutButtons || asksLimits) return "general-platform-question";
  if (asksBaselineDefinition) return "general-platform-question";
  if (asksCode) return "code-platform-diagnosis";
  if (asksResearchRun) return "research-request";
  if (asksResult) return "current-research-result";
  if (asksFailure) return "platform-diagnosis";
  if (asksChart) return "chart-backtest-question";
  if (mode === "platform-diagnosis" || mode === "code-evidence" || mode === "platform") return "platform-diagnosis";
  return "general-platform-question";
}

function buildIntentAmbiguityResponse({ message = "" } = {}) {
  const polish = isPolishQuestion(message) || /[ąćęłńóśźż]/i.test(message);
  return {
    answer: polish
      ? "Widzę tu jednocześnie język badania/backtestu i komendę live dla pozycji. Nie zgaduję, bo to mogłoby być niebezpieczne. Czy chodzi Ci o badanie/backtest, czy o zmianę SL/TP na żywej pozycji?"
      : "I see both research/backtest language and a live-position command. I will not guess because that could be unsafe. Do you mean a research/backtest task, or changing SL/TP on a live position?",
    confidence: {
      label: "low",
      reason: "Message contains both research keywords and explicit live-action wording.",
      score: 35,
    },
    evidence: [
      "Research keywords were detected.",
      "Explicit live-action wording was also detected.",
      "No pending research job or live action was created.",
    ],
    intent: "intent-clarification",
    nextAction: polish
      ? "Odpowiedz: „badanie” albo „żywa pozycja”."
      : "Reply with “research” or “live position”.",
    recommendation: polish
      ? "Dla SL w backteście pisz raczej „SL jako parametr strategii”; dla live użyj „zmień SL żywej pozycji na ...”."
      : "For backtest SL, say “SL as strategy parameter”; for live, say “change live position SL to ...”.",
    risk: { label: "moderate", reasons: ["Ambiguous live execution wording requires clarification."] },
    sections: [],
  };
}

function researchObjectiveLabels(message = "", { polish = false } = {}) {
  const normalized = normalizeCommandText(message);
  const objectives = [];
  if (/\bpf\b|profit factor/i.test(normalized)) objectives.push(polish ? "najlepszy PF" : "best PF");
  if (/skutecznosc|skuteczność|win rate|trafnosc|trafność/i.test(normalized)) objectives.push(polish ? "najlepsza skuteczność / win rate" : "best win rate");
  if (/niski(?:ego|m)?\s+dd|niskiego\s+drawdown|low\s+drawdown|drawdown|\bdd\b/i.test(normalized)) objectives.push(polish ? "najniższy DD" : "lowest DD");
  if (/calosciow|całościow|overall|optymaln|balanced|robust/i.test(normalized)) objectives.push(polish ? "najlepszy wynik całościowy" : "best overall");
  return objectives.length ? objectives : [polish ? "robustness-adjusted return" : "robustness-adjusted return"];
}

function researchSizingLabel(message = "", plan = {}, { polish = false } = {}) {
  const normalized = normalizeCommandText(message);
  const percent = normalized.match(/\b(\d+(?:[.,]\d+)?)\s*%\s*(?:per\s*position|pozycj|position)/i);
  const hasAtrSl = /\bsl\b.{0,40}\batr\b|\batr\b.{0,40}\bsl\b/i.test(normalized);
  if (percent?.[1] && hasAtrSl) {
    return polish
      ? `${percent[1].replace(",", ".")}% per position z ATR SL sizing`
      : `${percent[1].replace(",", ".")}% per position with ATR SL sizing`;
  }
  if (percent?.[1]) {
    return polish
      ? `${percent[1].replace(",", ".")}% per position`
      : `${percent[1].replace(",", ".")}% per position`;
  }
  return `${plan.sizingMode ?? "position-percent"}${plan.parameters?.sizingValues?.length ? ` ${plan.parameters.sizingValues.join(", ")}` : ""}`;
}

function isSearchCoverageAuditQuestion(message = "") {
  const normalized = normalizeCommandText(message);
  return /(czemu|dlaczego|why).{0,80}(reczny|ręczny|manual).{0,80}(sweep|wynik|result|lepsze|lepszy)|(?:manual|reczny|ręczny).{0,80}(better|lepsze|lepszy).{0,80}(ah|ai)/i.test(normalized);
}

function buildSearchCoverageAuditAnswer({ message = "", run = null } = {}) {
  const polish = isPolishQuestion(message) || /[ąćęłńóśźż]/i.test(message);
  const plan = run?.plan ?? {};
  const hasRun = Boolean(run);
  return {
    answer: polish
      ? [
          "Najbardziej prawdopodobne wyjaśnienie: ręczny sweep i AH nie testowały dokładnie tej samej przestrzeni albo nie użyły tych samych założeń.",
          "Żeby to uczciwie sprawdzić, AH powinien porównać: zakres dat, timeframe, provider, fill mode, sizing mode, Strategy/MM deck, parametry gridu, constraints i ranking objective.",
          hasRun
            ? `Dla aktywnego runu widzę: ${plan.symbol ?? "symbol?"} ${plan.timeframe ?? "TF?"}, ${plan.range?.from ?? "from?"} → ${plan.range?.to ?? "to?"}, fill ${plan.fillMode ?? "?"}, sizing ${plan.sizingMode ?? "?"}.`
            : "Nie mam teraz wybranego konkretnego runu i ręcznego wyniku, więc mogę opisać ścieżkę audytu, ale nie policzę jeszcze dokładnego diffu.",
          "Jeśli podasz nazwę ręcznego backtestu/sweepu, np. hubert, użyję resolvera biblioteki i zrobię porównanie założeń oraz metryk.",
        ].join(" ")
      : [
          "Most likely, the manual sweep and AH did not test the exact same search space or assumptions.",
          "The fair audit compares date range, timeframe, provider, fill mode, sizing mode, Strategy/MM deck, grid parameters, constraints, and ranking objective.",
          hasRun
            ? `For the active run I see: ${plan.symbol ?? "symbol?"} ${plan.timeframe ?? "TF?"}, ${plan.range?.from ?? "from?"} to ${plan.range?.to ?? "to?"}, fill ${plan.fillMode ?? "?"}, sizing ${plan.sizingMode ?? "?"}.`
            : "No concrete run/manual result is selected, so I can explain the audit path but cannot compute the exact diff yet.",
          "Give me the saved manual result name, for example hubert, and I can compare assumptions and metrics.",
        ].join(" "),
    confidence: { label: hasRun ? "medium" : "low", reason: "Search coverage audit needs both AH run and manual baseline for exact diff.", score: hasRun ? 66 : 42 },
    evidence: [
      "Audit dimensions: range, timeframe, provider, fill mode, sizing mode, strategy/MM deck, parameter grid, constraints, ranking objective.",
      hasRun ? `Active run: ${run.id}` : "No active run was selected.",
    ],
    intent: "search-coverage-audit",
    nextAction: polish ? "Podaj nazwę ręcznego wyniku albo baseline, żebym zrobił dokładny diff." : "Provide the saved manual result/baseline name so I can compute the exact diff.",
    recommendation: polish ? "Nie porównuj wyników po samym PF/net bez zgodności założeń." : "Do not compare by PF/net alone until assumptions match.",
    risk: { label: "moderate", reasons: ["Exact audit requires a named manual result or saved backtest."] },
    sections: [],
  };
}

function compactPositionForAnswer(position = {}) {
  if (!position) return null;
  return {
    apiProfile: position.apiProfile ?? position.profile ?? null,
    currentPrice: position.currentPrice ?? position.markPrice ?? null,
    positionId: position.positionId ?? position.positionID ?? position.id ?? null,
    positionSide: position.positionSide ?? position.side ?? null,
    quantity: position.quantity ?? position.qty ?? null,
    stopLoss: position.stopLoss ?? null,
    symbol: position.symbol ?? null,
    takeProfit: position.takeProfit ?? null,
  };
}

function recentResearchPrompt(memory = {}) {
  const candidates = (memory?.conversationSummary ?? []).filter((entry) => {
    const normalized = normalizeCommandText(entry.message ?? "");
    const looksLikeResearch = /(najlepsze|ustawienia|sweep|research|badanie|backtest|settings|znajdz|znajdź)/i.test(normalized);
    const looksLikePlanningAdvice = /(ile|optymalnie|how many).*(kombinacj|combination|test)/i.test(normalized);
    return looksLikeResearch && !looksLikePlanningAdvice;
  });
  return candidates.find((entry) => /\b[A-Z]{2,12}USDT\b/i.test(entry.message ?? "") || /\d{4}[.-]\d{1,2}[.-]\d{1,2}/.test(entry.message ?? ""))?.message ??
    candidates[0]?.message ??
    "";
}

function isCombinationAdviceQuestion(message = "") {
  const normalized = normalizeCommandText(message);
  return /(ile|jaka|jakie|how many|optymalnie|optimal).*(kombinacj|combination|test)/i.test(normalized) ||
    /(kombinacj|combination).*(ile|optymalnie|optimal)/i.test(normalized);
}

export const __intentTestHooks = {
  detectLiveExecutionIntent,
  hasExplicitLiveActionIntent,
  hasResearchPriorityIntent,
  inferCopilotIntent,
};

function isResearchMethodQuestion(message = "") {
  const normalized = normalizeCommandText(message);
  return /(w jaki sposob|w jaki sposób|jak pracujesz|how do you work|search strategy|szukasz optymaln|optymalnych ustawien|optymalnych ustawień|optymalne ustawien)/i.test(normalized);
}

function isResearchConfirmationMessage(message = "") {
  const normalized = normalizeCommandText(message);
  return /(zrob|zrób|odpal|uruchom|run|start|potwierdzam|confirm)\b/i.test(normalized) ||
    /^\s*\d{2,5}\s*(kombinacj|combination|test)?/i.test(normalized);
}

function isResearchContinuationCommand(message = "") {
  const normalized = normalizeCommandText(message);
  return /(zawez|zawęź|narrow|wokol|wokół|sprawdz|sprawdź|przetestuj|testuj|conservative|legacy|dla 1h|dla 30m)/i.test(normalized);
}

function rangeLabel(range = {}) {
  if (!range?.from || !range?.to) return "latest available range";
  return `${range.from.slice(0, 10)} → ${range.to.slice(0, 10)}`;
}

function estimateDurationLabel(combinations = 0) {
  const count = Number(combinations) || 0;
  if (count <= 100) return "about 1-3 minutes";
  if (count <= 200) return "about 3-8 minutes";
  if (count <= 500) return "about 8-18 minutes";
  if (count <= 1000) return "about 15-35 minutes";
  return "long run; likely 35+ minutes depending on cache and provider speed";
}

function isActivePlanningSession(session = null) {
  return Boolean(session && ["collecting_info", "ready_to_confirm"].includes(session.status));
}

function isPlanningResetMessage(message = "") {
  const normalized = normalizeCommandText(message);
  return /(nowy temat|zacznij od nowa|start new|forget this|clear plan|anuluj plan|cancel plan|reset plan|od nowa)/i.test(normalized);
}

function classifyPlanningFollowUp(message = "", session = null) {
  if (!isActivePlanningSession(session)) return "none";
  const normalized = normalizeCommandText(message);
  if (isPlanningResetMessage(message)) return "cancellation";
  if (isAgentOSGoal(message) && normalized.length > 120) return "unrelated";
  if (/^(czemu|dlaczego|why|co|jak)\b/i.test(normalized)) return "unrelated";
  if (detectLiveExecutionIntent(message) && !hasResearchPriorityIntent(message)) return "unrelated";
  if (isConversationalExplanationQuestion(message)) return "unrelated";
  if (/(nazwij|nazwa|name|tytul|tytuł|badani|research|test ai|\bai\s*\d+\b)/i.test(normalized)) return "answer";
  if (/(ostatnie|ostatnich|last)\s+\d{1,4}\s*(dni|days)|\d{4}[.-]\d{1,2}[.-]\d{1,2}|marzec|marca|styczen|stycznia|luty|lutego|kwiecien|kwietnia|maj|maja|czerwiec|czerwca|lipiec|lipca|sierpien|sierpnia|wrzesien|wrzesnia|pazdziernik|pazdziernika|listopad|listopada|grudzien|grudnia/i.test(normalized)) return "answer";
  if (/(bez baseline|ignore baseline|ignoruj hubert|bez hubert|hubert|baseline)/i.test(normalized)) return "answer";
  if (/(\d{2,5})\s*(kombinacj|testow|testów|runs|combinations)|\b(zrob|zrób|run|odpal|uruchom)\s*\d{2,5}\b/i.test(normalized)) return "answer";
  if (/(pf|profit factor|dd|drawdown|trade|transakc|atr|nwe|bandwidth|conservative|legacy|fixed risk|risk per sl|per sl|na sl|mm deck|sizing|sl z atr|atr sl)/i.test(normalized)) return "answer";
  if (session.lastQuestionAsked && normalized.length < 120) return "answer";
  return "unrelated";
}

function extractOperationName(message = "") {
  const source = String(message).trim();
  const patterns = [
    /\b(?:nazwij|nazwa|name|tytul|tytuł)\s+(?:badanie|badania|research|test)?\s*["“]?([^",.;\n]+)["”]?/i,
    /\b(?:badanie|badania|research)\s+(?:ma\s+sie\s+nazywac|ma\s+się\s+nazywać|called)\s*["“]?([^",.;\n]+)["”]?/i,
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1]) {
      return match[1].trim().replace(/\s+(i|oraz|plus)\s+.*$/i, "").slice(0, 80);
    }
  }
  return "";
}

function extractSizingInterpretationNote(message = "") {
  const normalized = normalizeCommandText(message);
  if (/(1\s*%|procent).{0,80}(sl|stop loss|mm deck|risk per sl|na sl|per sl)|(?:sl|stop loss|mm deck).{0,80}(1\s*%|procent)/i.test(normalized)) {
    return "1% should be treated as MM/risk per SL sizing, not ordinary position size.";
  }
  return "";
}

function planningSessionFromIntent({
  intent = {},
  lastQuestionAsked = "",
  operationName = "",
  pendingOperation = null,
  previous = null,
  sizingInterpretationNote = "",
  status = "collecting_info",
} = {}) {
  return {
    accumulatedIntent: intent,
    lastQuestionAsked,
    missingFields: intent.unknownFields ?? [],
    operationName: operationName || previous?.operationName || "",
    pendingOperationId: pendingOperation?.id ?? previous?.pendingOperationId ?? null,
    sizingInterpretationNote: sizingInterpretationNote || previous?.sizingInterpretationNote || "",
    status,
    startedAt: previous?.startedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function buildPendingResearchOperation({ memory = {}, message = "", options = {}, researchIntent = null, workspaceContext = {} }) {
  const previous = recentResearchPrompt(memory);
  const combinedPrompt = previous && isResearchConfirmationMessage(message)
    ? `${previous}\n${message}`
    : message;
  const intent = researchIntent ?? memory.researchIntent ?? updateResearchIntent({
    message,
    previous: memory.researchIntent,
    workspaceContext,
  });
  const planOptions = researchIntentToPlanOptions(intent, options, workspaceContext);
  const plan = createAgentPlan({
    options: planOptions,
    prompt: combinedPrompt,
  });
  if (intent.range?.label && plan.range) {
    plan.range = {
      ...plan.range,
      label: intent.range.label,
      requestedDays: intent.range.requestedDays ?? plan.range.requestedDays,
    };
  }
  const baseline = plan.baselineQuery || "";
  const operation = {
    id: `ah-op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    estimatedDuration: estimateDurationLabel(plan.maxCombinations),
    name: `AH research ${plan.symbol} ${plan.timeframe} ${rangeLabel(plan.range)}`,
    params: {
      options: {
        ...planOptions,
        confirmLargeJob: plan.maxCombinations > 1000 || Boolean(options.confirmLargeJob),
        maxCombinations: plan.maxCombinations,
        workspaceContext,
      },
      prompt: combinedPrompt,
      workspaceContext,
    },
    plan,
    riskNotes: [
      "This queues analysis only. It cannot place trades.",
      "More combinations improve search coverage but do not guarantee the grid contains the best region.",
      ...(plan.maxCombinations > 1000 ? ["Large run: confirm that runtime cost is acceptable."] : []),
    ],
    summary: [
      `${plan.symbol} ${plan.timeframe}`,
      `${rangeLabel(plan.range)}`,
      `${plan.maxCombinations} combinations`,
      `${plan.provider}`,
      `fill ${plan.fillMode}`,
      `sizing ${plan.sizingMode}`,
      plan.methodology ? `method ${plan.methodology}` : "method not selected",
      baseline ? `baseline ${baseline}` : "no explicit baseline",
    ].join(" · "),
    type: "research-job",
  };
  return operation;
}

function isResearchIntentReady(intent = {}) {
  return Boolean(
    intent?.range?.from &&
    intent?.range?.to &&
    intent?.symbol &&
    intent?.timeframe &&
    intent?.combinations &&
    intent?.methodology
  );
}

function decoratePlanningOperation(operation, { name = "", session = null, status = "ready_to_confirm" } = {}) {
  const plan = { ...operation.plan, planningSession: session };
  if (status === "collecting_info" && session?.missingFields?.includes("range")) {
    plan.range = null;
  }
  const operationName = name || (
    status === "collecting_info" && session?.missingFields?.includes("range")
      ? `AH research ${operation.plan?.symbol ?? "market"} ${operation.plan?.timeframe ?? ""}`.trim()
      : operation.name
  );
  return {
    ...operation,
    name: operationName,
    plan,
    status,
    summary: status === "collecting_info"
      ? `${operation.plan?.symbol ?? "market"} ${operation.plan?.timeframe ?? ""} · range missing · collecting missing info`
      : operation.summary,
  };
}

export function createAgentOrchestrator({ copilotMemory, store, tools }) {
  const runStore = createAgentRunStore({ store });
  const toolRegistry = createAgentToolRegistry({ tools });
  const executor = createAgentExecutor({ runStore, toolRegistry });
  const jobQueue = createAgentJobQueue({ executor, runStore });

  jobQueue.start().catch((error) => {
    console.warn(`[ai-agent] queue startup failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  async function startRun(body = {}) {
    const prompt = String(body.prompt ?? "").trim();
    if (!prompt) {
      return {
        ok: false,
        message: "Tell the agent what to analyze first.",
        statusCode: 400,
      };
    }

    const memory = copilotMemory?.summary?.() ?? null;
    const workspaceContext = body.workspaceContext ?? body.options?.workspaceContext ?? null;
    const plan = createAgentPlan({ options: body.options ?? {}, prompt });
    const safety = checkAgentPlanSafety(plan, body.options ?? {});

    if (!safety.ok) {
      return {
        ok: false,
        ...safety,
        plan,
        statusCode: safety.needsConfirmation ? 409 : 400,
      };
    }

    const run = await runStore.create({
      name: body.name ?? body.options?.operationName ?? "",
      plan,
      prompt,
      warnings: safety.warnings,
    });
    await runStore.update(run.id, {
      copilotMemory: memory,
      workspaceContext,
    });
    await copilotMemory?.rememberInteraction?.({
      message: prompt,
      response: { answer: "Research job queued." },
      run: { ...run, plan, prompt, status: "queued" },
      workspaceContext,
    });
    if (memory?.researchPlanningSession) {
      await copilotMemory?.rememberResearchPlanningSession?.({
        ...memory.researchPlanningSession,
        pendingOperationId: body.options?.operationId ?? memory.researchPlanningSession.pendingOperationId ?? null,
        status: "confirmed",
        updatedAt: new Date().toISOString(),
      });
    }
    jobQueue.enqueue(run.id);

    return {
      ok: true,
      run: runStore.get(run.id) ? runStore.publicRun(runStore.get(run.id)) : run,
    };
  }

  async function cancelRun(id) {
    const run = await runStore.cancel(id);
    if (!run) {
      return {
        ok: false,
        message: "That agent run was not found.",
        statusCode: 404,
      };
    }

    return {
      ok: true,
      run,
    };
  }

  async function restartRun(id) {
    const run = runStore.get(id);
    if (!run) {
      return {
        ok: false,
        message: "That agent run was not found.",
        statusCode: 404,
      };
    }

    return startRun({
      options: {
        confirmLargeJob: true,
        fillMode: run.plan?.fillMode,
        maxCombinations: run.plan?.requestedCombinations ?? run.plan?.maxCombinations,
        objective: run.plan?.objective,
        provider: run.plan?.provider,
        sizingMode: run.plan?.sizingMode,
        startingBalance: run.plan?.startingBalance,
        timeframe: run.plan?.timeframe,
      },
      prompt: run.prompt,
    });
  }

  function exportRun(id, body = {}) {
    const run = runStore.get(id);
    if (!run) {
      return {
        ok: false,
        message: "That agent run was not found.",
        statusCode: 404,
      };
    }

    const format = ["csv", "docx", "json", "md", "xlsx", "zip"].includes(body.format) ? body.format : "md";
    const rows = (run.resultSummary?.topRows ?? []).map((row, index) => normalizeResearchResult(row, {
      index,
      output: run.resultSummary,
      plan: run.plan,
      run,
    }));
    const exportIntegrity = run.resultSummary?.integrity ?? summarizeIntegrity(rows, run.resultSummary ?? {});
    if ((rows.length || run.resultSummary) && !["docx", "xlsx", "zip"].includes(format)) {
      if (format === "csv") {
        return {
          content: rowsToCsv(rows),
          fileName: "agent-ranking.csv",
          format,
          mime: "text/csv",
          ok: true,
        };
      }
      if (format === "json") {
        return {
          content: JSON.stringify({
            integrity: exportIntegrity,
            plan: run.plan,
            resultSummary: {
              ...run.resultSummary,
              best: rows[0] ?? run.resultSummary?.best ?? null,
              integrity: exportIntegrity,
              topRows: rows,
            },
            runId: run.id,
          }, null, 2),
          fileName: "agent-result.json",
          format,
          mime: "application/json",
          ok: true,
        };
      }
      return {
        content: composeAgentMarkdown({
          output: {
            ...run.resultSummary,
            integrity: exportIntegrity,
            processedCombinations: run.resultSummary?.executedCombinations,
            rankedResults: rows,
            summary: run.resultSummary?.message,
            testedCombinations: run.resultSummary?.executedCombinations,
            totalCombinations: run.resultSummary?.plannedCombinations,
          },
          plan: run.plan,
          run,
        }),
        fileName: "agent-report.md",
        format,
        mime: "text/markdown",
        ok: true,
      };
    }
    const artifact =
      (run.artifacts ?? []).find((item) => item.id === body.artifactId) ??
      (run.artifacts ?? []).find((item) => item.format === format) ??
      run.artifacts?.[0];

    if (!artifact) {
      return {
        ok: false,
        message: "No export artifact is available for this run yet.",
        statusCode: 400,
      };
    }

    return {
      content: artifact.content,
      encoding: artifact.encoding,
      fileName: artifact.fileName,
      format: artifact.format,
      mime: artifact.mime,
      ok: true,
    };
  }

  function rowsForRun(run) {
    return [
      ...(run.resultSummary?.topRows ?? []),
      ...(run.partialResults ?? []),
    ].filter(Boolean);
  }

  function resolveRow(run, body = {}) {
    const rows = rowsForRun(run);
    if (body.rowId) return rows.find((row) => row.id === body.rowId) ?? null;
    const index = Math.max(0, Number(body.rowIndex ?? body.configIndex ?? 0));
    return rows[index] ?? rows[0] ?? null;
  }

  function compactRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      canonical: row.canonical,
      dataCompleteness: row.dataCompleteness,
      integrity: row.integrity,
      metrics: row.metrics,
      params: row.params,
      provenance: row.provenance,
      rank: row.rank,
      research: row.research,
      score: row.score,
      symbol: row.symbol,
      timeframe: row.timeframe,
    };
  }

  function extractBaselineName(message = "") {
    const source = String(message);
    const patterns = [
      /\b(?:compare|porownaj|porównaj)\b.*?\b(?:with|to|z|do)\s+["“]?([a-z0-9][a-z0-9 _.-]{1,60})["”]?/i,
      /\b(?:compare|porownaj|porównaj)\s+(?:config\s*#?\s*\d+\s+)?(?:with|to|z|do)\s+["“]?([a-z0-9][a-z0-9 _.-]{1,60})["”]?/i,
      /\b(?:worse|better|gorszy|gorsze|lepszy|lepsze)\s+(?:than|niz|niż|od)\s+["“]?([a-z0-9][a-z0-9 _.-]{1,60})["”]?/i,
      /\b(?:baseline|baz[ae]|punkt odniesienia)\s*[:=]?\s*["“]?([a-z0-9][a-z0-9 _.-]{1,60})["”]?/i,
    ];
    for (const pattern of patterns) {
      const match = source.match(pattern);
      if (match?.[1]) {
        return match[1]
          .replace(/\b(?:and|oraz|i|please|prosze|proszę|why|czemu|dlaczego)\b.*$/i, "")
          .trim();
      }
    }
    return "";
  }

  function inferBaselineName(message = "", memory = null) {
    const explicit = extractBaselineName(message);
    if (explicit) return explicit;
    if (!/(baseline|hubert|porownaj|porównaj|compare|gorszy|worse|lepszy|better)/i.test(String(message))) return "";
    if (/hubert/i.test(String(message))) return "hubert";
    return memory?.baselines?.[0]?.name ?? "";
  }

  function comparableValue(value) {
    if (value === undefined || value === null || value === "") return null;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
    return String(value);
  }

  function metricComparison(aiRow = {}, baseline = {}) {
    const normalized = aiRow.canonical ? aiRow : normalizeResearchResult(aiRow);
    const metrics = baseline.metrics ?? {};
    const pairs = {
      maxDrawdown: [normalized.canonical?.metrics?.maxDrawdown, metrics.maxDrawdown],
      netProfit: [normalized.canonical?.metrics?.netPnl, metrics.netProfit],
      profitFactor: [normalized.canonical?.metrics?.profitFactor, metrics.profitFactor],
      trades: [normalized.canonical?.metrics?.trades, metrics.totalTrades],
      winRate: [normalized.canonical?.metrics?.winRate, metrics.winRate],
      expectancy: [normalized.canonical?.metrics?.expectancy, metrics.expectancy],
    };
    return Object.fromEntries(Object.entries(pairs).map(([key, [ai, saved]]) => [
      key,
      {
        ai: comparableValue(ai),
        delta: Number.isFinite(Number(ai)) && Number.isFinite(Number(saved)) ? Number((Number(ai) - Number(saved)).toFixed(8)) : null,
        match: Number.isFinite(Number(ai)) && Number.isFinite(Number(saved)) ? Math.abs(Number(ai) - Number(saved)) < 0.000001 : ai === saved,
        saved: comparableValue(saved),
      },
    ]));
  }

  function fieldComparison(aiValue, savedValue) {
    const left = comparableValue(aiValue);
    const right = comparableValue(savedValue);
    return {
      ai: left,
      match: left === right || (Number.isFinite(Number(left)) && Number.isFinite(Number(right)) && Math.abs(Number(left) - Number(right)) < 0.000001),
      saved: right,
    };
  }

  function explainBacktestDiff({ baseline, contextDiff, metricDiff, row }) {
    const blockers = Object.entries(contextDiff).filter(([, value]) => !value.match).map(([key]) => key);
    const aiNet = metricDiff.netProfit.ai;
    const savedNet = metricDiff.netProfit.saved;
    const aiPf = metricDiff.profitFactor.ai;
    const savedPf = metricDiff.profitFactor.saved;
    const verdict = blockers.length
      ? `This is not an exact apples-to-apples comparison because ${blockers.join(", ")} differ.`
      : "This is an apples-to-apples comparison by stored context fields.";
    const performance = Number(aiNet) < Number(savedNet)
      ? `The AI config is weaker on net PnL (${aiNet} vs ${savedNet}) and should admit that against this baseline.`
      : Number(aiNet) > Number(savedNet)
        ? `The AI config is stronger on net PnL (${aiNet} vs ${savedNet}), but PF/DD still need review.`
        : "Net PnL is equal or unavailable between the two records.";

    return [
      verdict,
      performance,
      `PF comparison: AI ${aiPf ?? "unavailable"} vs ${savedPf ?? "unavailable"}.`,
      row?.integrity?.warnings?.length ? `AI row integrity notes: ${row.integrity.warnings.slice(0, 3).join("; ")}` : "",
      baseline.dataCompleteness?.missing?.length ? `Saved backtest is missing: ${baseline.dataCompleteness.missing.join(", ")}.` : "",
    ].filter(Boolean).join(" ");
  }

  function verifiedFrom(run, row) {
    if (!row) {
      return {
        missing: ["No ranked config row was selected for this answer."],
        runId: run?.id ?? null,
        verified: false,
      };
    }

    const normalized = row.canonical ? row : normalizeResearchResult(row, { run, plan: run?.plan });
    return {
      drawdown: normalized.canonical?.metrics?.maxDrawdown ?? null,
      fillMode: normalized.canonical?.fillMode ?? "legacy",
      integrityScore: normalized.integrity?.score ?? null,
      integrityStatus: normalized.integrity?.status ?? "unknown",
      integrityWarnings: normalized.integrity?.warnings ?? [],
      net: normalized.canonical?.metrics?.netPnl ?? null,
      provider: normalized.canonical?.provider ?? "binance-futures",
      rank: normalized.rank ?? null,
      range: normalized.canonical?.range ?? { from: null, to: null },
      runId: run?.id ?? null,
      sizingMode: normalized.canonical?.sizingMode ?? "position-percent",
      symbol: normalized.canonical?.symbol ?? "SOLUSDT",
      timeframe: normalized.canonical?.timeframe ?? null,
      trades: normalized.canonical?.metrics?.trades ?? null,
      profitFactor: normalized.canonical?.metrics?.profitFactor ?? null,
      verified: true,
    };
  }

  function memorySnapshot() {
    const memory = process.memoryUsage();
    return {
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      rssMb: Math.round(memory.rss / 1024 / 1024),
    };
  }

  async function rerunExact(id, body = {}) {
    const run = runStore.get(id);
    if (!run) {
      return { ok: false, message: "That agent run was not found.", statusCode: 404 };
    }
    const row = resolveRow(run, body);
    if (!row?.params) {
      return { ok: false, message: "This run does not include an exact parameter row to re-run.", statusCode: 400 };
    }
    const sizingMode = row.params.sizingMode ?? run.plan.sizingMode ?? "position-percent";
    const result = await toolRegistry.runBacktest(run.plan, {
      ...row.params,
      fillMode: body.fillMode ?? row.params.fillMode ?? run.plan.fillMode ?? "legacy",
      positionPercent: sizingMode === "position-percent" ? row.params.sizingValue : undefined,
      riskPercent: sizingMode === "fixed-risk" ? row.params.sizingValue : undefined,
      sizingMode,
      timeframe: body.timeframe ?? row.timeframe ?? run.plan.timeframe,
    });
    const normalizedAiRow = normalizeResearchResult(row, { run, plan: run.plan });
    const normalizedRerunRow = normalizeResearchResult({
      candlesUsed: result.candlesUsed,
      fillMode: result.fillMode,
      metrics: result.metrics ?? {},
      params: row.params,
      provenance: result.provenance,
      rank: row.rank,
      symbol: result.symbol,
      timeframe: result.timeframe,
    }, { run, plan: run.plan });
    const metricDiff = {
      ...diffMetrics(normalizedAiRow, normalizedRerunRow),
      aiNetProfit: normalizedAiRow.canonical.metrics.netPnl,
      aiProfitFactor: normalizedAiRow.canonical.metrics.profitFactor,
      aiTrades: normalizedAiRow.canonical.metrics.trades,
      rerunNetProfit: normalizedRerunRow.canonical.metrics.netPnl,
      rerunProfitFactor: normalizedRerunRow.canonical.metrics.profitFactor,
      rerunTrades: normalizedRerunRow.canonical.metrics.trades,
      sameCandles: Number(row.candlesUsed ?? 0) === Number(result.candlesUsed ?? 0),
      sameFillMode: (row.params?.fillMode ?? run.plan.fillMode ?? "legacy") === (result.fillMode ?? "legacy"),
      sameSizingMode: (row.params?.sizingMode ?? run.plan.sizingMode ?? "position-percent") === (result.provenance?.sizingMode ?? run.plan.sizingMode ?? "position-percent"),
    };
    const diffValues = Object.values(metricDiff).filter((item) => item && typeof item === "object" && "match" in item);
    const parityPassed = diffValues.length > 0 && diffValues.every((item) => item.match) && metricDiff.sameCandles && metricDiff.sameFillMode && metricDiff.sameSizingMode;
    const integrityPassed = parityPassed && normalizedAiRow.canonical.status === "complete" && normalizedRerunRow.canonical.status === "complete";
    const integrityWarnings = [
      ...(parityPassed ? [] : ["AI result and exact rerun are not fully identical."]),
      ...(normalizedAiRow.integrity?.warnings ?? []).map((warning) => `AI row: ${warning}`),
      ...(normalizedRerunRow.integrity?.warnings ?? []).map((warning) => `Rerun: ${warning}`),
    ];

    return {
      cacheHit: Boolean(result.cacheHit),
      exactConfig: row.params,
      integrity: {
        ai: normalizedAiRow.integrity,
        metricDiff,
        passed: integrityPassed,
        parityPassed,
        rerun: normalizedRerunRow.integrity,
        warnings: [...new Set(integrityWarnings)],
      },
      metricDiff,
      ok: true,
      provenance: result.provenance,
      result,
      row: normalizedAiRow,
      rerunRow: normalizedRerunRow,
    };
  }

  async function compareAgentResultToBacktest(id, body = {}) {
    const run = runStore.get(id);
    if (!run) {
      return { ok: false, message: "That agent run was not found.", statusCode: 404 };
    }
    const row = resolveRow(run, body);
    if (!row) {
      return { ok: false, message: "Choose an AI result row to compare first.", statusCode: 400 };
    }
    const backtestNameOrId = String(body.backtestNameOrId ?? body.query ?? "").trim();
    if (!backtestNameOrId) {
      return { ok: false, message: "Enter a saved backtest name or id, for example hubert.", statusCode: 400 };
    }
    if (typeof toolRegistry.getBacktestDetail !== "function") {
      return { ok: false, message: "Saved backtest detail tool is not available.", statusCode: 500 };
    }

    const baseline = await toolRegistry.getBacktestDetail(backtestNameOrId, { tradeLimit: body.tradeLimit ?? 500 });
    if (!baseline?.ok) {
      return { ok: false, message: baseline?.message ?? "Saved backtest could not be resolved.", resolution: baseline, statusCode: 404 };
    }

    const normalizedRow = normalizeResearchResult(row, {
      output: run.resultSummary ?? {},
      plan: run.plan,
      run,
    });
    const contextDiff = {
      atrLength: fieldComparison(normalizedRow.params?.atrLength, baseline.strategyParams?.atrLength),
      atrMultiplier: fieldComparison(normalizedRow.params?.atrMultiplier, baseline.strategyParams?.atrMultiplier),
      bandwidth: fieldComparison(normalizedRow.params?.bandwidth, baseline.strategyParams?.bandwidth),
      candlesUsed: fieldComparison(normalizedRow.canonical?.candlesUsed, baseline.provenance?.candlesUsed),
      envelopeMultiplier: fieldComparison(normalizedRow.params?.envelopeMultiplier, baseline.strategyParams?.envelopeMultiplier),
      fillMode: fieldComparison(normalizedRow.canonical?.fillMode, baseline.fillMode),
      maxSameSideFailures: fieldComparison(normalizedRow.params?.maxSameSideFailures, baseline.strategyParams?.maxSameSideFailures),
      provider: fieldComparison(normalizedRow.canonical?.provider, baseline.provenance?.provider),
      rangeFrom: fieldComparison(normalizedRow.canonical?.range?.from, baseline.range?.from),
      rangeTo: fieldComparison(normalizedRow.canonical?.range?.to, baseline.range?.to),
      sizingMode: fieldComparison(normalizedRow.canonical?.sizingMode, baseline.sizingMode),
      timeframe: fieldComparison(normalizedRow.canonical?.timeframe, baseline.timeframe),
    };
    const metricDiff = metricComparison(normalizedRow, baseline);
    const allContextMatch = Object.values(contextDiff).every((item) => item.match);
    const allMetricMatch = Object.values(metricDiff).every((item) => item.match || item.ai === null || item.saved === null);

    return {
      baseline,
      contextDiff,
      explanation: explainBacktestDiff({ baseline, contextDiff, metricDiff, row: normalizedRow }),
      metricDiff,
      ok: true,
      parity: {
        allContextMatch,
        allMetricMatch,
        exactExperiment: allContextMatch,
        warnings: [
          ...(!allContextMatch ? ["Context differs. Do not treat metrics as exact parity."] : []),
          ...(!allMetricMatch ? ["Metrics differ between AI row and saved backtest."] : []),
          ...(baseline.dataCompleteness?.missing?.length ? [`Saved baseline missing ${baseline.dataCompleteness.missing.join(", ")}.`] : []),
        ],
      },
      row: compactRow(normalizedRow),
      runId: run.id,
      savedBacktestNameOrId: backtestNameOrId,
    };
  }

  async function chat(body = {}) {
    const message = String(body.message ?? "").trim();
    if (!message) {
      return { ok: false, message: "Ask a follow-up first.", statusCode: 400 };
    }
    const mode = String(body.mode ?? body.copilotMode ?? "research").toLowerCase();
    const run = body.runId ? runStore.get(body.runId) : runStore.list().find((item) => item.status === "completed");
    const memory = copilotMemory?.summary?.() ?? null;
    const workspaceContext = body.workspaceContext ?? null;
    const activePlanningSession = memory?.researchPlanningSession ?? null;
    const planningFollowUp = classifyPlanningFollowUp(message, activePlanningSession);
    if (planningFollowUp === "cancellation") {
      await copilotMemory?.clearResearchPlanningSession?.();
      const polish = isPolishQuestion(message) || /[ąćęłńóśźż]/i.test(message);
      const response = {
        answer: polish
          ? "Jasne. Wyczyściłem aktywny plan badania. Możemy zacząć nowy temat od zera."
          : "Done. I cleared the active research plan. We can start a new topic from scratch.",
        confidence: { label: "high", reason: "User explicitly cancelled/reset the active planning session.", score: 90 },
        evidence: ["Active AH planning session cleared.", "No job was queued."],
        intent: "planning-cancelled",
        nextAction: polish ? "Napisz nowy temat albo nowe badanie." : "Send a new topic or research request.",
        risk: { label: "low", reasons: ["Conversation state only."] },
      };
      await copilotMemory?.rememberInteraction?.({ message, response, run, workspaceContext });
      return { ok: true, response };
    }

    const inferredIntent = inferCopilotIntent(message, mode);
    const liveCandidate = detectLiveExecutionIntent(message);
    const researchPriority = inferredIntent === "research-request" || hasResearchPriorityIntent(message);
    const ambiguousLiveResearch = researchPriority && liveCandidate && hasExplicitLiveActionIntent(message);
    const liveIntent = researchPriority ? null : liveCandidate;
    const shouldContinuePlanning = planningFollowUp === "answer" || planningFollowUp === "update";
    const shouldUpdateResearchIntent = (inferredIntent === "research-request" && isResearchPlanningMessage(message)) || shouldContinuePlanning;
    const updatedResearchIntent = shouldUpdateResearchIntent
      ? updateResearchIntent({
        forceInherit: shouldContinuePlanning,
        message,
        previous: shouldContinuePlanning
          ? activePlanningSession?.accumulatedIntent ?? memory?.researchIntent
          : memory?.researchIntent,
        workspaceContext,
      })
      : memory?.researchIntent ?? null;
    const effectiveMemory = updatedResearchIntent
      ? { ...(memory ?? {}), researchIntent: updatedResearchIntent }
      : memory;

    if (ambiguousLiveResearch) {
      const response = buildIntentAmbiguityResponse({ message });
      if (run) {
        await runStore.update(run.id, {
          messages: [
            ...(run.messages ?? []),
            { role: "user", text: message, time: new Date().toISOString() },
            {
              evidence: response.evidence,
              confidence: response.confidence,
              role: "assistant",
              sections: response.sections,
              text: response.answer,
              time: new Date().toISOString(),
            },
          ].slice(-40),
        });
      }
      await copilotMemory?.rememberInteraction?.({ message, response, run, workspaceContext });
      return { ok: true, response };
    }

    if (shouldContinuePlanning) {
      const polish = isPolishQuestion(message) || /[ąćęłńóśźż]/i.test(message);
      const operationName = extractOperationName(message) || activePlanningSession?.operationName || "";
      const sizingInterpretationNote = extractSizingInterpretationNote(message) || activePlanningSession?.sizingInterpretationNote || "";
      if (sizingInterpretationNote) {
        updatedResearchIntent.sizingMode = "fixed-risk";
        updatedResearchIntent.parameterRanges = {
          ...(updatedResearchIntent.parameterRanges ?? {}),
          sizingValues: updatedResearchIntent.parameterRanges?.sizingValues?.length
            ? updatedResearchIntent.parameterRanges.sizingValues
            : [1],
        };
        updatedResearchIntent.unknownFields = updatedResearchIntent.unknownFields ?? [];
      }
      const pendingOperationBase = buildPendingResearchOperation({
        memory: { ...(memory ?? {}), researchIntent: updatedResearchIntent },
        message,
        options: body.options ?? {},
        researchIntent: updatedResearchIntent,
        workspaceContext,
      });
      const clarification = clarificationForIntent(updatedResearchIntent, { polish });
      const ready = !clarification && isResearchIntentReady(updatedResearchIntent);
      const session = planningSessionFromIntent({
        intent: updatedResearchIntent,
        lastQuestionAsked: clarification,
        operationName,
        pendingOperation: pendingOperationBase,
        previous: activePlanningSession,
        sizingInterpretationNote,
        status: ready ? "ready_to_confirm" : "collecting_info",
      });
      const pendingOperation = decoratePlanningOperation(pendingOperationBase, {
        name: operationName,
        session,
        status: session.status,
      });
      await copilotMemory?.rememberResearchIntent?.(updatedResearchIntent);
      await copilotMemory?.rememberResearchPlanningSession?.(session);

      const added = [];
      if (operationName && operationName !== activePlanningSession?.operationName) added.push(polish ? `nazwę: ${operationName}` : `name: ${operationName}`);
      if (sizingInterpretationNote && sizingInterpretationNote !== activePlanningSession?.sizingInterpretationNote) {
        added.push(polish ? "interpretację sizingu: 1% jako MM/risk per SL" : "sizing interpretation: 1% as MM/risk per SL");
      }
      if (updatedResearchIntent.range?.from && updatedResearchIntent.range?.to && updatedResearchIntent.range?.label !== activePlanningSession?.accumulatedIntent?.range?.label) {
        added.push(polish ? `zakres: ${updatedResearchIntent.range.label}` : `range: ${updatedResearchIntent.range.label}`);
      }
      if (updatedResearchIntent.baselineExplicitlyDisabled && !activePlanningSession?.accumulatedIntent?.baselineExplicitlyDisabled) {
        added.push(polish ? "baseline wyłączony" : "baseline disabled");
      }
      const assumptionBlock = describeResearchAssumptions(updatedResearchIntent, { polish });
      const response = {
        answer: ready
          ? (polish
              ? [
                  added.length ? `Dopisałem ${added.join("; ")}.` : "Zaktualizowałem plan badania.",
                  "Plan jest kompletny. Przygotowałem kartę potwierdzenia, ale niczego jeszcze nie uruchamiam.",
                  `Zakres: ${rangeLabel(pendingOperation.plan.range)}.`,
                  `Rynek: ${pendingOperation.plan.symbol} ${pendingOperation.plan.timeframe}.`,
                  `Kombinacje: ${pendingOperation.plan.maxCombinations}.`,
                  `Metoda: ${pendingOperation.plan.methodology}.`,
                  "Kliknij Confirm, jeśli mam wrzucić badanie do kolejki.",
                ].join(" ")
              : [
                  added.length ? `I added ${added.join("; ")}.` : "I updated the research plan.",
                  "The plan is complete. I prepared a confirmation card, but I have not started anything.",
                  `Range: ${rangeLabel(pendingOperation.plan.range)}.`,
                  `Market: ${pendingOperation.plan.symbol} ${pendingOperation.plan.timeframe}.`,
                  `Combinations: ${pendingOperation.plan.maxCombinations}.`,
                  `Method: ${pendingOperation.plan.methodology}.`,
                  "Click Confirm if you want me to queue the research.",
                ].join(" "))
          : (polish
              ? [
                  added.length ? `Dopisałem ${added.join("; ")}.` : "Zaktualizowałem aktywny plan badania.",
                  sizingInterpretationNote ? "Rozumiem też, że 1% ma być traktowane jako ustawienie MM/risk per SL, nie zwykły position size." : "",
                  assumptionBlock.missing.length ? `Nadal brakuje: ${assumptionBlock.missing.join(", ")}.` : "",
                  clarification,
                ].filter(Boolean).join(" ")
              : [
                  added.length ? `I added ${added.join("; ")}.` : "I updated the active research plan.",
                  sizingInterpretationNote ? "I understand that 1% should be treated as MM/risk per SL, not ordinary position size." : "",
                  assumptionBlock.missing.length ? `Still missing: ${assumptionBlock.missing.join(", ")}.` : "",
                  clarification,
                ].filter(Boolean).join(" ")),
        confidence: { label: "high", reason: "Message was merged into the active AH planning session.", score: 86 },
        evidence: [
          `Planning status: ${session.status}`,
          `Last question: ${activePlanningSession?.lastQuestionAsked ?? "none"}`,
          `Missing fields: ${(session.missingFields ?? []).join(", ") || "none"}`,
          `Operation name: ${operationName || "not set"}`,
          `Sizing note: ${sizingInterpretationNote || "none"}`,
        ],
        intent: ready ? "research-confirmation" : "research-planning",
        nextAction: ready
          ? (polish ? "Sprawdź kartę i kliknij Confirm." : "Review the card and click Confirm.")
          : clarification,
        pendingOperation,
        recommendation: polish ? "Kontynuuję ten sam plan, nie zaczynam nowego wątku." : "I am continuing the same plan, not starting a new thread.",
        risk: { label: "low", reasons: ["Planning only; no job was queued."] },
        sections: [
          {
            title: polish ? "Aktywny plan" : "Active plan",
            bullets: [
              `Name: ${operationName || "--"}`,
              `Symbol/timeframe: ${updatedResearchIntent.symbol ?? "--"} ${updatedResearchIntent.timeframe ?? "--"}`,
              `Range: ${updatedResearchIntent.range?.label ?? "--"}`,
              `Combinations: ${updatedResearchIntent.combinations ?? "--"}`,
              `Methodology: ${updatedResearchIntent.methodology ?? "--"}`,
              `Sizing: ${updatedResearchIntent.sizingMode ?? "--"} ${updatedResearchIntent.parameterRanges?.sizingValues?.join(", ") ?? ""}`,
            ],
          },
        ],
      };
      await copilotMemory?.rememberInteraction?.({ message, response, run, workspaceContext });
      return { ok: true, response };
    }

    if (liveIntent) {
      const freshState = typeof tools.getCurrentManualPositionState === "function"
        ? await tools.getCurrentManualPositionState({ fresh: true, workspaceContext }).catch(() => null)
        : null;
      const position =
        compactPositionForAnswer(workspaceContext?.live?.positions?.[0]) ??
        compactPositionForAnswer(freshState?.positions?.[0]) ??
        null;
      const polish = isPolishQuestion(message) || /[ąćęłńóśźż]/i.test(message);
      const positionText = position?.symbol
        ? `${position.symbol} ${position.positionSide ?? ""}${position.quantity ? ` qty ${position.quantity}` : ""}${position.positionId ? ` positionId ${position.positionId}` : ""}`
        : null;
      const targetText = liveIntent.price ? ` ${liveIntent.price}` : "";
      const answer = polish
        ? [
            `Rozpoznałem to jako komendę live execution: ${liveIntent.label}${targetText}.`,
            "Nie mogę samodzielnie wykonać tej akcji z czatu bez potwierdzenia.",
            positionText ? `Aktualnie wykryta pozycja: ${positionText}.` : "Nie widzę pewnej aktywnej pozycji w kontekście czatu.",
            "Ta funkcja nie jest jeszcze podłączona do czatu jako bezpieczny pending action.",
            liveIntent.action === "MOVE_SL"
              ? "Użyj panelu Crisis i przycisku Move SL bezpośrednio w karcie pozycji. Tam payload bierze positionId, positionSide, quantity i profil z tej konkretnej karty."
              : "Użyj panelu Crisis i przycisku tej akcji bezpośrednio w karcie pozycji.",
          ].join(" ")
        : [
            `I recognized this as a live execution command: ${liveIntent.label}${targetText}.`,
            "I cannot execute it from chat without explicit confirmation.",
            positionText ? `Current detected position: ${positionText}.` : "I cannot see a certain active position in chat context.",
            "This chat-to-pending-action flow is not wired yet.",
            "Use the Crisis panel position-card button for this exact position.",
          ].join(" ");
      const response = {
        answer,
        confidence: {
          label: position ? "high" : "medium",
          reason: "Live command was intercepted before research-result reasoning.",
          score: position ? 86 : 62,
        },
        evidence: [
          "Detected live execution intent before research reasoning.",
          positionText ? `Detected position: ${positionText}` : "No active position was available in workspace context.",
          "AI chat is analysis-only and cannot place orders or modify SL/TP automatically.",
        ],
        intent: "unsafe-live-action",
        nextAction: "Open Crisis and use the position-card control with explicit confirmation.",
        recommendation: "Use direct position-card controls; do not trust chat as an execution surface yet.",
        risk: {
          label: "high",
          reasons: ["Live exchange action requires explicit UI confirmation.", "Chat pending-action execution is not implemented."],
        },
        sections: [
          {
            title: polish ? "Co zrobić teraz" : "What to do now",
            bullets: polish
              ? ["Otwórz Crisis.", "Znajdź kartę pozycji SOLUSDT LONG/SHORT.", "Wpisz cenę w polu SL/TP.", "Kliknij Move SL/Move TP na tej samej karcie pozycji."]
              : ["Open Crisis.", "Find the SOLUSDT LONG/SHORT position card.", "Type the SL/TP price.", "Click Move SL/Move TP on that same position card."],
          },
        ],
        verifiedFrom: position
          ? {
              fillMode: null,
              provider: "BingX live state",
              runId: null,
              symbol: position.symbol,
              timeframe: null,
              trades: null,
              verified: true,
            }
          : null,
      };

      if (run) {
        await runStore.update(run.id, {
          messages: [
            ...(run.messages ?? []),
            { role: "user", text: message, time: new Date().toISOString() },
            {
              evidence: response.evidence,
              confidence: response.confidence,
              role: "assistant",
              sections: response.sections,
              text: response.answer,
              time: new Date().toISOString(),
            },
          ].slice(-40),
        });
      }
      await copilotMemory?.rememberInteraction?.({ message, response, run, workspaceContext });

      return { ok: true, response };
    }

    if (inferredIntent === "conversation-explanation") {
      const response = buildDirectConversationAnswer({ message, memory });

      if (run) {
        await runStore.update(run.id, {
          messages: [
            ...(run.messages ?? []),
            { role: "user", text: message, time: new Date().toISOString() },
            {
              evidence: response.evidence,
              confidence: response.confidence,
              role: "assistant",
              sections: response.sections,
              text: response.answer,
              time: new Date().toISOString(),
            },
          ].slice(-40),
        });
      }
      await copilotMemory?.rememberInteraction?.({ message, response, run, workspaceContext });

      return { ok: true, response };
    }

    if (isAgentOSGoal(message)) {
      const polish = isPolishQuestion(message) || /[ąćęłńóśźż]/i.test(message);
      const pendingOperation = createAgentOSPendingOperation({
        message,
        options: body.options ?? {},
        workspaceContext,
      });
      const task = pendingOperation.plan.agentOSTask ?? planAgentOSTask({ message, options: body.options ?? {}, workspaceContext });
      const response = {
        answer: polish
          ? [
              "Rozumiem to jako zadanie Agent OS: badanie + analiza + raportowanie, a nie zwykły pojedynczy sweep.",
              `Cel: ${task.objectives.join("; ")}.`,
              `Zakres: ${task.range ? `${task.range.from} → ${task.range.to}` : "nieustalony"}.`,
              `Rynek: ${task.symbol} ${task.timeframe}.`,
              `Metoda: ${task.methodology}.`,
              `Planowane narzędzia: ${task.tools.slice(0, 10).join(", ")}.`,
              `Artefakty: ${Object.entries(task.artifacts).filter(([, enabled]) => enabled).map(([key]) => key).join(", ")}.`,
              task.missingFields.length
                ? `Brakuje: ${task.missingFields.join(", ")}.`
                : "Przygotowałem operację do potwierdzenia. Niczego nie uruchamiam bez Confirm.",
            ].join(" ")
          : [
              "I understand this as an Agent OS task: research + analysis + reporting, not a single scripted sweep.",
              `Goal: ${task.objectives.join("; ")}.`,
              `Range: ${task.range ? `${task.range.from} → ${task.range.to}` : "missing"}.`,
              `Market: ${task.symbol} ${task.timeframe}.`,
              `Method: ${task.methodology}.`,
              `Tools planned: ${task.tools.slice(0, 10).join(", ")}.`,
              `Artifacts: ${Object.entries(task.artifacts).filter(([, enabled]) => enabled).map(([key]) => key).join(", ")}.`,
              task.missingFields.length
                ? `Missing: ${task.missingFields.join(", ")}.`
                : "I prepared this operation for confirmation. Nothing starts until Confirm.",
            ].join(" "),
        confidence: { label: "high", reason: "Agent OS goal detected from multi-objective research/report request.", score: 88 },
        evidence: [
          `Agent OS objectives: ${task.objectives.join(", ")}`,
          `Tools planned: ${task.tools.join(", ")}`,
          `Artifacts requested: ${Object.entries(task.artifacts).filter(([, enabled]) => enabled).map(([key]) => key).join(", ")}`,
          "No live execution is allowed from Agent OS.",
        ],
        intent: task.missingFields.length ? "agent-os-planning" : "agent-os-confirmation",
        nextAction: task.missingFields.length
          ? (polish ? `Doprecyzuj: ${task.missingFields.join(", ")}.` : `Clarify: ${task.missingFields.join(", ")}.`)
          : (polish ? "Sprawdź kartę Agent OS i kliknij Confirm." : "Review the Agent OS card and click Confirm."),
        pendingOperation,
        recommendation: polish
          ? "Użyj tego trybu do pakietów badawczych i raportów. Do prostych pytań AH nadal odpowiada normalnie."
          : "Use this mode for research packages and reports. For simple questions AH still answers normally.",
        risk: { label: "moderate", reasons: pendingOperation.riskNotes },
        sections: [
          { title: polish ? "Etapy" : "Stages", bullets: (task.experimentDesign?.stages ?? []).map((stage) => `${stage.name}: ${stage.purpose}`) },
        ],
      };
      await copilotMemory?.rememberInteraction?.({ message, response, run, workspaceContext });
      return { ok: true, response };
    }

    if (isSearchCoverageAuditQuestion(message)) {
      const response = buildSearchCoverageAuditAnswer({ message, run });
      await copilotMemory?.rememberInteraction?.({ message, response, run, workspaceContext });
      return { ok: true, response };
    }

    if (inferredIntent === "research-request") {
      const polish = isPolishQuestion(message) || /[ąćęłńóśźż]/i.test(message);
      if (updatedResearchIntent) {
        await copilotMemory?.rememberResearchIntent?.(updatedResearchIntent);
      }
      if (isResearchMethodQuestion(message)) {
        const response = {
          answer: polish
            ? "Pracuję teraz głównie jak kontrolowany research runner: biorę zakres, symbol, timeframe i parametry, buduję siatkę kombinacji, uruchamiam istniejący backtest dla każdej kombinacji, a potem sortuję wyniki przez score uwzględniający profit, drawdown, trade count i stabilność. To nie jest jeszcze inteligentne zawężanie zakresów w stylu Bayesian optimization. Jeśli mam baseline, np. hubert, mogę używać go jako punktu odniesienia i porównywać wyniki. Ograniczenie jest takie, że obecnie najpierw testuję przygotowaną siatkę, a dopiero potem oceniam, co wygląda stabilnie. Mądrzejszy tryb wymagałby iteracyjnego procesu: najpierw szeroki sweep, potem wykrycie obiecującego klastra, potem sąsiednie parametry, walidacja miesięczna, Legacy vs Conservative i dopiero rekomendacja."
            : "Right now I work mostly as a controlled research runner: I take range, symbol, timeframe, and parameters, build a parameter grid, run the existing backtest for each combination, then rank results with a score that considers profit, drawdown, trade count, and stability. This is not yet Bayesian or fully adaptive range narrowing. With a baseline such as hubert, I can use it as a comparison point. The current limitation is that I test a prepared grid first and interpret stability afterward. Smarter iterative search would need broad exploration, cluster detection, neighboring-parameter validation, monthly checks, Legacy vs Conservative checks, and only then a recommendation.",
          confidence: { label: "high", reason: "Answer describes current AH research architecture and its limitations.", score: 88 },
          evidence: [
            "AH uses existing sweep/backtest tools, not a separate strategy engine.",
            "Current search is grid/batched execution first, interpretation second.",
            "Baseline comparison and robustness checks exist, but adaptive optimization is still limited.",
          ],
          intent: "chat-explanation",
          nextAction: polish ? "Jeśli chcesz, poproś AH o przygotowanie 500 albo 1000 kombinacji dla konkretnego zakresu." : "Ask AH to prepare 500 or 1000 combinations for a concrete range if you want to proceed.",
          recommendation: polish ? "Najbardziej sensowny praktyczny flow: 500 szeroko, potem 1000 wokół najlepszych regionów." : "Practical flow: 500 broad tests first, then 1000 around the best regions.",
          risk: { label: "low", reasons: ["Explanation only; no job was queued."] },
          sections: [
            {
              title: polish ? "Co wymaga ulepszenia" : "What would make it smarter",
              bullets: polish
                ? ["automatyczne zawężanie zakresów", "test sąsiednich parametrów", "walidacja miesięczna/kwartalna", "porównanie Legacy vs Conservative", "odrzucanie konfiguracji z małą próbką"]
                : ["adaptive range narrowing", "neighboring-parameter tests", "monthly/quarterly validation", "Legacy vs Conservative comparison", "rejecting low-sample configs"],
            },
          ],
        };
        await copilotMemory?.rememberInteraction?.({ message, response, run, workspaceContext });
        return { ok: true, response };
      }
      if (isCombinationAdviceQuestion(message)) {
        const response = {
          answer: polish
            ? "Dla jednego symbolu i jednego interwału wybrałbym 500 jako rozsądny pierwszy research. 50-100 to tylko szybki smoke test. 200 daje lekki obraz, ale może ominąć dobre okolice parametrów. 500 zwykle jest sensownym kompromisem. 1000 ma więcej sensu, jeśli szukasz poważnego kandydata do walidacji i możesz poczekać dłużej. 2000+ zostawiłbym dopiero na deep run po znalezieniu obiecującego regionu."
            : "For one symbol and one timeframe, I would start with 500 combinations. 50-100 is only a smoke test. 200 is lightweight exploration. 500 is the best first-pass compromise. 1000 is better when you want a serious validation candidate and can wait longer. 2000+ should come after a promising region is found.",
          confidence: { label: "high", reason: "General AH research planning guidance.", score: 86 },
          evidence: [
            "50-100: smoke/quick check.",
            "200: lightweight exploration.",
            "500: solid first research pass.",
            "1000: stronger search and better confidence.",
            "2000+: deep run after narrowing the search space.",
          ],
          intent: inferredIntent,
          nextAction: polish ? "Powiedz „zrób 500” albo „zrób 1000”, a AH przygotuje kartę potwierdzenia." : "Say “run 500” or “run 1000” and AH will prepare a confirmation card.",
          recommendation: polish ? "Na start: 500. Dla poważniejszego kandydata: 1000." : "Start with 500. Use 1000 for a more serious candidate.",
          risk: { label: "low", reasons: ["Planning only; no job has been queued."] },
        };
        await copilotMemory?.rememberInteraction?.({ message, response, run, workspaceContext });
        return { ok: true, response };
      }
      const pendingOperation = buildPendingResearchOperation({
        memory: effectiveMemory,
        message,
        options: body.options ?? {},
        researchIntent: updatedResearchIntent,
        workspaceContext,
      });
      const hasExecutableResearchPlan = Boolean(
        updatedResearchIntent?.range?.from &&
        updatedResearchIntent?.range?.to &&
        updatedResearchIntent?.symbol &&
        updatedResearchIntent?.timeframe &&
        updatedResearchIntent?.combinations &&
        updatedResearchIntent?.methodology
      );
      const shouldPrepare = pendingOperation.plan.requestedCombinationsExplicit ||
        isResearchConfirmationMessage(message) ||
        (Boolean(updatedResearchIntent?.combinations) && isResearchContinuationCommand(message)) ||
        (hasExecutableResearchPlan && hasResearchPriorityIntent(message));
      const clarification = clarificationForIntent(updatedResearchIntent ?? pendingOperation.plan.researchIntent, { polish });
      if (clarification) {
        const assumptionBlock = describeResearchAssumptions(updatedResearchIntent ?? {}, { polish });
        const session = planningSessionFromIntent({
          intent: updatedResearchIntent,
          lastQuestionAsked: clarification,
          previous: memory?.researchPlanningSession,
          status: "collecting_info",
        });
        const draftOperation = decoratePlanningOperation(
          buildPendingResearchOperation({
            memory: effectiveMemory,
            message,
            options: body.options ?? {},
            researchIntent: updatedResearchIntent,
            workspaceContext,
          }),
          { session, status: "collecting_info" },
        );
        session.pendingOperationId = draftOperation.id;
        await copilotMemory?.rememberResearchPlanningSession?.(session);
        const response = {
          answer: [
            polish ? "Rozumiem. Nie uruchamiam jeszcze testu." : "Understood. I am not starting the test yet.",
            polish ? `Założenia: ${assumptionBlock.assumptions.join("; ")}.` : `Assumptions: ${assumptionBlock.assumptions.join("; ")}.`,
            assumptionBlock.defaults.length
              ? (polish ? `Domyślnie: ${assumptionBlock.defaults.join("; ")}.` : `Defaults: ${assumptionBlock.defaults.join("; ")}.`)
              : "",
            assumptionBlock.missing.length
              ? (polish ? `Nieustalone: ${assumptionBlock.missing.join(", ")}.` : `Missing: ${assumptionBlock.missing.join(", ")}.`)
              : "",
            polish && !updatedResearchIntent?.baselineQuery && !updatedResearchIntent?.baselineExplicitlyDisabled
              ? "Chcesz zrobić czyste badanie bez baseline, czy użyć np. hubert?"
              : "",
            clarification,
          ].filter(Boolean).join(" "),
          confidence: { label: "high", reason: "AH extracted a research intent but needs one missing execution detail before creating a pending job.", score: 82 },
          evidence: [
            `Intent objective: ${updatedResearchIntent?.objective ?? "unknown"}`,
            `Range: ${updatedResearchIntent?.range?.from ?? "missing"} to ${updatedResearchIntent?.range?.to ?? "missing"}`,
            `Constraints: ${JSON.stringify(updatedResearchIntent?.constraints ?? {})}`,
            `Parameter ranges: ${JSON.stringify(updatedResearchIntent?.parameterRanges ?? {})}`,
          ],
          intent: "research-planning",
          nextAction: clarification,
          pendingOperation: draftOperation,
          recommendation: polish ? "Doprecyzuj tylko brakujący element; resztę zachowuję w planie rozmowy." : "Clarify only the missing item; I am keeping the rest in the conversation plan.",
          risk: { label: "low", reasons: ["No job was queued."] },
          sections: [
            {
              title: polish ? "Wyłapany plan" : "Extracted plan",
              bullets: [
                `Symbol/timeframe: ${updatedResearchIntent?.symbol ?? "--"} ${updatedResearchIntent?.timeframe ?? "--"}`,
                `Range: ${updatedResearchIntent?.range?.label ?? "--"}`,
                `Baseline: ${updatedResearchIntent?.baselineQuery || "none"}`,
                `Constraints: ${JSON.stringify(updatedResearchIntent?.constraints ?? {})}`,
                `Methodology: ${updatedResearchIntent?.methodology ?? "not selected"}`,
              ],
            },
          ],
        };
        await copilotMemory?.rememberInteraction?.({ message, response, run, workspaceContext });
        return { ok: true, response };
      }
      if (shouldPrepare) {
        const assumptionBlock = describeResearchAssumptions(pendingOperation.plan.researchIntent ?? updatedResearchIntent ?? {}, { polish });
        const objectiveLabels = researchObjectiveLabels(message, { polish });
        const sizingLabel = researchSizingLabel(message, pendingOperation.plan, { polish });
        const session = planningSessionFromIntent({
          intent: pendingOperation.plan.researchIntent ?? updatedResearchIntent,
          lastQuestionAsked: "",
          operationName: pendingOperation.name,
          pendingOperation,
          previous: memory?.researchPlanningSession,
          sizingInterpretationNote: pendingOperation.plan.sizingMode === "fixed-risk" ? "Fixed risk/MM risk per SL sizing selected." : "",
          status: "ready_to_confirm",
        });
        const readyOperation = decoratePlanningOperation(pendingOperation, {
          name: session.operationName,
          session,
          status: "ready_to_confirm",
        });
        await copilotMemory?.rememberResearchPlanningSession?.(session);
        const response = {
          answer: polish
            ? [
            "OK. Przygotowałem zadanie badawcze, ale go jeszcze nie uruchamiam.",
                `Cel: ${pendingOperation.plan.objective}.`,
                `Kategorie wyników: ${objectiveLabels.join("; ")}.`,
                `Zakres: ${rangeLabel(pendingOperation.plan.range)}.`,
                `Rynek: ${pendingOperation.plan.symbol} ${pendingOperation.plan.timeframe}.`,
                `Kombinacje: ${pendingOperation.plan.maxCombinations}.`,
                `Metoda: ${pendingOperation.plan.methodology}.`,
                `Sizing: ${sizingLabel}.`,
                pendingOperation.plan.baselineQuery ? `Użyję zapisanego backtestu „${pendingOperation.plan.baselineQuery}” jako baseline.` : "Baseline: brak, bo nie podałeś go jawnie.",
                pendingOperation.plan.constraints?.minProfitFactor ? `Filtr: PF minimum ${pendingOperation.plan.constraints.minProfitFactor}.` : "",
                pendingOperation.plan.constraints?.maxDrawdown ? `Filtr: DD max ${pendingOperation.plan.constraints.maxDrawdown}.` : "",
                pendingOperation.plan.constraints?.minTrades ? `Filtr: minimum ${pendingOperation.plan.constraints.minTrades} transakcji.` : "",
                `Jawne założenia: ${assumptionBlock.assumptions.join("; ")}.`,
                "Nadaj nazwę badania i kliknij Zatwierdź, jeśli mam je wrzucić do kolejki.",
              ].join(" ")
            : [
                "OK. I prepared a research job, but I have not started it yet.",
                `Objective: ${pendingOperation.plan.objective}.`,
                `Result categories: ${objectiveLabels.join("; ")}.`,
                `Range: ${rangeLabel(pendingOperation.plan.range)}.`,
                `Market: ${pendingOperation.plan.symbol} ${pendingOperation.plan.timeframe}.`,
                `Combinations: ${pendingOperation.plan.maxCombinations}.`,
                `Method: ${pendingOperation.plan.methodology}.`,
                `Sizing: ${sizingLabel}.`,
                pendingOperation.plan.baselineQuery ? `I will use saved backtest “${pendingOperation.plan.baselineQuery}” as baseline.` : "Baseline: none, because you did not request one explicitly.",
                "Name it and confirm if you want me to queue it.",
              ].join(" "),
          confidence: { label: "high", reason: "AH prepared a pending research operation instead of launching a job silently.", score: 88 },
          evidence: [
            `Symbol: ${pendingOperation.plan.symbol}`,
            `Timeframe: ${pendingOperation.plan.timeframe}`,
            `Range: ${rangeLabel(pendingOperation.plan.range)}`,
            `Combinations: requested ${pendingOperation.plan.requestedCombinations}, planned ${pendingOperation.plan.plannedCombinations}`,
            `Provider: ${pendingOperation.plan.provider}`,
            `Methodology: ${pendingOperation.plan.methodology}`,
            `Objectives: ${objectiveLabels.join(", ")}`,
            `Sizing note: ${sizingLabel}`,
            `Constraints: ${JSON.stringify(pendingOperation.plan.constraints ?? {})}`,
            `Parameter ranges: ${JSON.stringify(pendingOperation.plan.parameters ?? {})}`,
          ],
          intent: "research-confirmation",
          nextAction: polish ? "Sprawdź kartę pending operation i kliknij Zatwierdź." : "Review the pending operation card and click Confirm.",
          pendingOperation: readyOperation,
          recommendation: polish ? "Najpierw potwierdź zakres i liczbę kombinacji." : "Confirm the range and combination count first.",
          risk: { label: pendingOperation.plan.maxCombinations > 1000 ? "moderate" : "low", reasons: pendingOperation.riskNotes },
        };
        await copilotMemory?.rememberInteraction?.({ message, response, run, workspaceContext });
        return { ok: true, response };
      }
      const response = {
        answer: polish
          ? "Mogę to zrobić. Najpierw wybierzmy rozmiar badania: 50-100 to szybki smoke test, 200 lekka eksploracja, 500 rozsądny pierwszy research, 1000 mocniejszy search do poważniejszej walidacji. Dla jednego symbolu i interwału polecam 500 na start albo 1000, jeśli chcesz mocniejszy kandydat i możesz poczekać."
          : "I can do that. First choose the research size: 50-100 is a smoke test, 200 is lightweight exploration, 500 is a solid first research pass, and 1000 is a stronger search for a serious validation candidate. For one symbol/timeframe, I recommend 500 first or 1000 if you can wait longer.",
        confidence: { label: "high", reason: "Research-run intent detected before result reasoning.", score: 84 },
        evidence: ["Detected research/backtest/sweep planning intent.", "No job has been queued because AH requires confirmation first."],
        intent: inferredIntent,
        nextAction: polish ? "Napisz „zrób 500” albo „zrób 1000”, a AH przygotuje kartę potwierdzenia." : "Say “run 500” or “run 1000” and AH will prepare a confirmation card.",
        recommendation: polish ? "Dla pierwszego przejścia: 500. Dla mocniejszego kandydata: 1000." : "First pass: 500. Stronger candidate search: 1000.",
        risk: { label: "moderate", reasons: ["Large jobs should be explicit and cancellable."] },
        sections: [
          {
            title: polish ? "Co doprecyzować" : "What to clarify",
            bullets: polish
              ? ["symbol", "timeframe", "zakres dat", "fill mode", "sizing mode", "liczba kombinacji"]
              : ["symbol", "timeframe", "date range", "fill mode", "sizing mode", "combination count"],
          },
        ],
      };
      await copilotMemory?.rememberInteraction?.({ message, response, run, workspaceContext });
      return { ok: true, response };
    }

    const wantsPlatformEvidence = (
      inferredIntent !== "current-research-result" ||
      mode === "platform-diagnosis" ||
      mode === "code-evidence" ||
      mode === "platform" ||
      body.evidenceMode === true
    );

    if (wantsPlatformEvidence && typeof tools.answerFromPlatformEvidence === "function") {
      const platformEvidence = await tools.answerFromPlatformEvidence({
        mode: inferredIntent === "code-platform-diagnosis" ? "code-evidence" : inferredIntent,
        question: message,
        runId: run?.id ?? null,
        workspaceContext,
      });
      const confidenceLabel = platformEvidence.confidence ?? "medium";
      const response = {
        answer: platformEvidence.answer,
        confidence: {
          label: confidenceLabel,
          reason: "Answer generated from backend code/runtime evidence tools.",
          score: confidenceLabel === "high" ? 82 : confidenceLabel === "medium" ? 62 : 38,
        },
        evidence: [
          ...(platformEvidence.inspected ?? []).map((item) => `Inspected: ${item}`),
          ...(platformEvidence.evidence ?? []),
        ].slice(0, 36),
        intent: inferredIntent,
        nextAction: platformEvidence.suggestedVerification?.[0] ?? "Verify the traced path in the relevant platform panel.",
        recommendation: "Use this as read-only platform diagnosis. AI cannot place orders or modify execution.",
        risk: {
          label: platformEvidence.confidence === "high" ? "low" : "moderate",
          reasons: platformEvidence.unknown ?? [],
        },
        sections: [
          {
            title: "Files/functions/routes inspected",
            bullets: platformEvidence.inspected ?? [],
          },
          {
            title: "What is unknown",
            bullets: platformEvidence.unknown ?? [],
          },
          {
            title: "Suggested verification",
            bullets: platformEvidence.suggestedVerification ?? [],
          },
        ],
        platformEvidence,
        memory,
        runId: run?.id ?? null,
      };

      if (run) {
        await runStore.update(run.id, {
          messages: [
            ...(run.messages ?? []),
            {
              role: "user",
              text: message,
              time: new Date().toISOString(),
            },
            {
              evidence: response.evidence,
              confidence: response.confidence,
              role: "assistant",
              sections: response.sections,
              text: response.answer,
              time: new Date().toISOString(),
              platformEvidence,
            },
          ].slice(-40),
        });
      }
      await copilotMemory?.rememberInteraction?.({
        message,
        response,
        run,
        workspaceContext,
      });

      return {
        ok: true,
        response,
      };
    }

    if (!run) {
      return {
        ok: true,
        response: {
          answer: "I do not have a completed run to reference yet. Start a research or sweep run first.",
          evidence: [],
          intent: inferredIntent,
          nextAction: "Run a small research prompt, then ask a follow-up about the result.",
        },
      };
    }
    const rows = rowsForRun(run);
    const configMatch = message.match(/config\s*#?\s*(\d+)/i);
    const rowIndex = configMatch ? Math.max(0, Number(configMatch[1]) - 1) : 0;
    const explicitRow = body.rowId || body.rowIndex !== undefined || body.configIndex !== undefined
      ? resolveRow(run, body)
      : null;
    const row = explicitRow ?? rows[rowIndex] ?? rows[0];
    const normalizedRows = rows.map((item, index) => normalizeResearchResult(item, {
      index,
      output: run.resultSummary ?? {},
      plan: run.plan,
      run,
    }));
    const normalizedRow = row
      ? normalizeResearchResult(row, {
        index: rowIndex,
        output: run.resultSummary ?? {},
        plan: run.plan,
        run,
      })
      : null;
    const reasoning = buildReasoningResponse({ question: message, row: normalizedRow, rows: normalizedRows, run });
    const baselineName = inferBaselineName(message, memory);
    const baselineComparison = baselineName
      ? await compareAgentResultToBacktest(run.id, { backtestNameOrId: baselineName, rowId: row?.id, rowIndex })
      : null;
    const evidence = [
      `Run: ${run.id}`,
      `Intent: ${run.parsedIntent}`,
      `Range: ${run.plan?.range?.from} to ${run.plan?.range?.to}`,
      `Provider: ${run.plan?.provider}`,
      ...(memory?.preferences?.metrics?.length ? [`Remembered preferred metrics: ${memory.preferences.metrics.join(", ")}`] : []),
      ...(memory?.baselines?.length ? [`Remembered baseline: ${memory.baselines[0].name}`] : []),
      normalizedRow ? `Selected row: rank ${normalizedRow.rank ?? rowIndex + 1}` : "No ranked row available.",
      ...(baselineComparison?.ok ? [
        `Compared with saved backtest: ${baselineComparison.baseline?.name}`,
        `Baseline PF: ${baselineComparison.metricDiff?.profitFactor?.saved}`,
        `AI PF: ${baselineComparison.metricDiff?.profitFactor?.ai}`,
      ] : baselineComparison ? [`Baseline comparison failed: ${baselineComparison.message}`] : []),
      ...(reasoning.evidence ?? []),
    ];
    const polish = isPolishQuestion(message);
    const asksPolishDeepAnalysis = polish && /(pelna analiz|pełna analiz|pokaz|pokaż)/i.test(message);
    const answer = baselineComparison?.ok
      ? polish
        ? [
            `Porównałem wybrany wynik AI z zapisanym backtestem „${baselineComparison.baseline?.name}”.`,
            `AI: net ${baselineComparison.metricDiff?.netProfit?.ai ?? "n/a"}, PF ${baselineComparison.metricDiff?.profitFactor?.ai ?? "n/a"}, trades ${baselineComparison.metricDiff?.trades?.ai ?? "n/a"}.`,
            `Hubert: net ${baselineComparison.metricDiff?.netProfit?.saved ?? "n/a"}, PF ${baselineComparison.metricDiff?.profitFactor?.saved ?? "n/a"}, trades ${baselineComparison.metricDiff?.trades?.saved ?? "n/a"}.`,
            baselineComparison.parity?.allContextMatch
              ? "Kontekst testu wygląda zgodnie, więc metryki można porównać bezpośrednio."
              : "Kontekst nie jest identyczny, więc nie wolno traktować różnicy metryk jako czystej przewagi jednej konfiguracji.",
            (() => {
              const different = Object.entries(baselineComparison.contextDiff ?? {})
                .filter(([, value]) => value && value.match === false)
                .map(([key]) => key)
                .slice(0, 8);
              return different.length ? `Różnice kontekstu: ${different.join(", ")}.` : "";
            })(),
            Number(baselineComparison.metricDiff?.netProfit?.ai ?? 0) < Number(baselineComparison.metricDiff?.netProfit?.saved ?? 0)
              ? "Wynik AI jest słabszy od hubert pod względem net PnL i musi to jasno przyznać."
              : "Wynik AI ma wyższy net PnL niż hubert w zapisanych metrykach, ale nadal trzeba sprawdzić zgodność kontekstu.",
            `PF: AI ${baselineComparison.metricDiff?.profitFactor?.ai ?? "n/a"} vs hubert ${baselineComparison.metricDiff?.profitFactor?.saved ?? "n/a"}.`,
            baselineComparison.parity?.warnings?.length ? `Ostrzeżenia: ${baselineComparison.parity.warnings.join(" ")}` : "",
          ].join(" ")
        : `${baselineComparison.explanation} ${reasoning.answer ?? ""}`.trim()
      : asksPolishDeepAnalysis && normalizedRow
        ? [
            `Pełna analiza aktualnego wyniku: konfiguracja ma net ${normalizedRow.canonical?.metrics?.netPnl ?? "n/a"} USDT, PF ${normalizedRow.canonical?.metrics?.profitFactor ?? "n/a"}, drawdown ${normalizedRow.canonical?.metrics?.maxDrawdown ?? "n/a"} i ${normalizedRow.canonical?.metrics?.trades ?? "n/a"} transakcji.`,
            `Zakres: ${normalizedRow.canonical?.range?.from ?? run.plan?.range?.from} → ${normalizedRow.canonical?.range?.to ?? run.plan?.range?.to}, ${normalizedRow.canonical?.symbol ?? run.plan?.symbol} ${normalizedRow.canonical?.timeframe ?? run.plan?.timeframe}.`,
            `Wniosek: to nadal kandydat badawczy, nie gotowy sygnał do live. Najważniejsze ryzyko to jakość próbki i zgodność kontekstu z baseline.`,
            `Co sprawdzić dalej: Conservative fill, porównanie z hubert, test miesięczny/kwartalny oraz sąsiednie parametry wokół tej konfiguracji.`,
          ].join(" ")
      : reasoning.answer ?? run.resultSummary?.message ?? "This run completed, but no compact summary is available.";
    const responseRow = compactRow(reasoning.row ?? normalizedRow);
    const responseVerifiedFrom = verifiedFrom(run, reasoning.row ?? normalizedRow);
    if (baselineComparison?.ok) {
      await copilotMemory?.rememberBaseline?.({
        id: baselineComparison.baseline?.id,
        name: baselineComparison.baseline?.name ?? baselineName,
        source: "saved-backtest",
        summary: baselineComparison.explanation,
      });
    }

    const nextMessages = [
      ...(run.messages ?? []),
      {
        context: {
          rowId: row?.id ?? null,
          rowRank: normalizedRow?.rank ?? null,
          workspaceContext,
        },
        role: "user",
        text: message,
        time: new Date().toISOString(),
      },
      {
        evidence,
        confidence: reasoning.confidence,
        critique: reasoning.critique,
        risk: reasoning.risk,
        role: "assistant",
        sections: reasoning.sections,
        text: answer,
        time: new Date().toISOString(),
        baselineComparison: baselineComparison?.ok ? baselineComparison : null,
        row: responseRow,
        verifiedFrom: responseVerifiedFrom,
        memory,
      },
    ].slice(-40);
    await runStore.update(run.id, { messages: nextMessages });
    await copilotMemory?.rememberInteraction?.({
      message,
      response: {
        answer,
        runId: run.id,
      },
      row: reasoning.row ?? normalizedRow,
      run,
      workspaceContext,
    });

    return {
      ok: true,
      response: {
        answer,
        confidence: reasoning.confidence,
        critique: reasoning.critique,
        evidence,
        intent: baselineComparison?.ok ? "current-research-result" : reasoning.intent ?? inferredIntent,
        nextAction: reasoning.nextAction ?? "Use Re-run exact config if you want a manual backtest check against this AI row.",
        recommendation: reasoning.recommendation,
        risk: reasoning.risk,
        row: responseRow,
        runId: run.id,
        sections: reasoning.sections,
        baselineComparison: baselineComparison?.ok ? baselineComparison : null,
        verifiedFrom: responseVerifiedFrom,
        memory: copilotMemory?.summary?.() ?? memory,
      },
    };
  }

  async function verifyIntegrity(id, body = {}) {
    const run = runStore.get(id);
    if (!run) {
      return { ok: false, message: "That agent run was not found.", statusCode: 404 };
    }
    const row = resolveRow(run, body);
    if (!row?.params) {
      return {
        ok: false,
        message: "This run does not include an exact config row to verify.",
        statusCode: 400,
      };
    }

    const rerun = await rerunExact(id, { ...body, rowId: row.id });
    if (!rerun.ok) return rerun;

    return {
      ok: true,
      result: {
        ai: {
          canonical: rerun.row?.canonical,
          integrity: rerun.integrity?.ai,
        },
        diff: rerun.metricDiff,
        passed: Boolean(rerun.integrity?.passed),
        rerun: {
          canonical: rerun.rerunRow?.canonical,
          integrity: rerun.integrity?.rerun,
        },
        warnings: rerun.integrity?.warnings ?? [],
      },
    };
  }

  return {
    agentOSToolCatalog,
    cancelRun,
    chat,
    exportRun,
    getArtifacts(id) {
      const run = runStore.get(id);
      return run
        ? { artifacts: (run.artifacts ?? []).map(({ content, ...artifact }) => artifact), ok: true }
        : { message: "That agent run was not found.", ok: false, statusCode: 404 };
    },
    getRun(id) {
      const run = runStore.get(id);
      return run
        ? { ok: true, run: runStore.publicRun(run) }
        : { message: "That agent run was not found.", ok: false, statusCode: 404 };
    },
    getRunDebug(id) {
      const run = runStore.get(id);
      if (!run) {
        return { message: "That agent run was not found.", ok: false, statusCode: 404 };
      }
      const heartbeatMs = run.heartbeatAt ? Date.now() - Date.parse(run.heartbeatAt) : null;
      return {
        debug: {
          cacheStats: run.cacheStats ?? {},
          currentStage: run.currentStep,
          errors: run.errors ?? [],
          heartbeatAgeSeconds: Number.isFinite(heartbeatMs) ? Math.round(heartbeatMs / 1000) : null,
          heartbeatAt: run.heartbeatAt,
          id: run.id,
          lastUnresolvedTask: {
            config: run.progress?.worker?.currentConfig ?? null,
            index: run.progress?.worker?.currentCombinationIndex ?? null,
            message: run.progress?.worker?.lastMessage ?? "",
            promiseState: run.progress?.worker?.promiseState ?? "",
            timeoutState: run.progress?.worker?.timeoutState ?? "",
            workerId: run.progress?.worker?.workerId ?? "",
          },
          memory: memorySnapshot(),
          progress: run.progress,
          status: run.status,
          warnings: run.warnings ?? [],
          worker: run.progress?.worker ?? {},
          workerId: run.workerId,
        },
        ok: true,
      };
    },
    listRuns() {
      return {
        ok: true,
        queue: jobQueue.status(),
        runs: runStore.list(),
      };
    },
    rerunExact,
    restartRun,
    startRun,
    compareAgentResultToBacktest,
    verifyIntegrity,
  };
}
