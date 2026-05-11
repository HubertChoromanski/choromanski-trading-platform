import assert from "node:assert/strict";
import { __intentTestHooks } from "../src/ai/agent/agentOrchestrator.js";

const longResearchPrompt = "chce zebys zrobil potezny test kombinacji ustawien dla zakresu 2025.01.01 - 2026.01.01. celem jest znalezienie najlepszych ustawien pod katem pf, skutecznosci i niskiego dd osobno. to znaczy chce najlepsze ustawienia dla kazdej z tych kategorii plus najlepsze calosciowo czyli optymalne. oczekuje ze kazdy nazwiesz ze bede wiedzial ktore wyniki sa ktore. chce zebys zbadal to uzywajac 1% per position sl z atr sisingiem i uzyl metody adaptive testu ktory najpierw wybiera najlepsze zakresy ustawien a potem w ramach tych zakresow optymalizuje";

assert.equal(
  __intentTestHooks.inferCopilotIntent(longResearchPrompt, "research"),
  "research-request",
  "Long Polish research prompt must route to research-request."
);
assert.equal(
  __intentTestHooks.detectLiveExecutionIntent(longResearchPrompt),
  null,
  "Long Polish research prompt must not be parsed as live SL action."
);
assert.equal(
  __intentTestHooks.detectLiveExecutionIntent("zmień SL na 93.9")?.action,
  "MOVE_SL",
  "Explicit live SL command must still be detected."
);
assert.equal(
  __intentTestHooks.detectLiveExecutionIntent("zmień SL na 93.9")?.price,
  93.9,
  "Explicit live SL command must parse the requested price."
);
assert.equal(
  __intentTestHooks.detectLiveExecutionIntent("ustawienia strategii od 2025.01.01 do 2026.01.01 z SL z ATR"),
  null,
  "Dates and strategy SL references must not be parsed as live SL prices."
);

console.log("AI intent regression checks passed.");
