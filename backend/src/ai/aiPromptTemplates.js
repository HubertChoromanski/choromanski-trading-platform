export const AI_PROVIDER_MODES = {
  DISABLED: "disabled",
  MOCK: "mock",
  PLACEHOLDER: "local-placeholder",
};

export const AI_SECTIONS = [
  "Answer",
  "Evidence/Data Used",
  "Calculations/Stats",
  "Recommendation",
  "Risks/Warnings",
  "Next Action",
];

export function structuredResponse({
  answer,
  calculations = [],
  evidence = [],
  nextAction = "Use the relevant tool or panel to verify before changing live settings.",
  recommendation = "Treat this as analysis only. The AI Workbench cannot place orders.",
  risks = [],
} = {}) {
  return {
    sections: {
      Answer: answer ?? "AI Workbench is ready in mock mode. Connect an external provider later for natural language reasoning.",
      "Evidence/Data Used": evidence,
      "Calculations/Stats": calculations,
      Recommendation: recommendation,
      "Risks/Warnings": [
        "Analysis only. No automatic execution.",
        "No secrets are included in AI context.",
        ...risks,
      ],
      "Next Action": nextAction,
    },
  };
}

export function sectionsToMarkdown(response) {
  const sections = response?.sections ?? {};

  return AI_SECTIONS
    .map((section) => {
      const value = sections[section];
      const text = Array.isArray(value)
        ? value.length
          ? value.map((item) => `- ${item}`).join("\n")
          : "- None"
        : value || "None";

      return `**${section}**\n${text}`;
    })
    .join("\n\n");
}
