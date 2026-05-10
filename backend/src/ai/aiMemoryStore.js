const SESSION_LIMIT = 80;
const REPORT_LIMIT = 120;
const ALERT_LIMIT = 200;

export function createAiMemoryStore({ store }) {
  return {
    async appendSessionMessage(message) {
      const current = store.getCollection("aiSessions") ?? [];
      const next = [
        ...current,
        {
          id: `ai-session-${Date.now()}-${current.length}`,
          time: new Date().toISOString(),
          ...message,
        },
      ].slice(-SESSION_LIMIT);

      await store.setCollection("aiSessions", next);
      return next.at(-1);
    },

    getSessions() {
      return store.getCollection("aiSessions") ?? [];
    },

    async clearSessions() {
      await store.setCollection("aiSessions", []);
      return [];
    },

    async saveReport(report) {
      const current = store.getCollection("aiReports") ?? [];
      const nextReport = {
        createdAt: report.createdAt ?? new Date().toISOString(),
        id: report.id ?? `ai-report-${Date.now()}`,
        ...report,
      };
      const next = [nextReport, ...current.filter((item) => item.id !== nextReport.id)].slice(0, REPORT_LIMIT);

      await store.setCollection("aiReports", next);
      return nextReport;
    },

    getReports() {
      return store.getCollection("aiReports") ?? [];
    },

    async saveAlertDraft(draft) {
      const current = store.getCollection("aiAlertDrafts") ?? [];
      const nextDraft = {
        createdAt: draft.createdAt ?? new Date().toISOString(),
        id: draft.id ?? `alert-draft-${Date.now()}`,
        status: "draft",
        ...draft,
      };
      const next = [nextDraft, ...current.filter((item) => item.id !== nextDraft.id)].slice(0, ALERT_LIMIT);

      await store.setCollection("aiAlertDrafts", next);
      return nextDraft;
    },

    getAlertDrafts() {
      return store.getCollection("aiAlertDrafts") ?? [];
    },

    async deleteAlertDraft(id) {
      const next = (store.getCollection("aiAlertDrafts") ?? []).filter((item) => item.id !== id);
      await store.setCollection("aiAlertDrafts", next);
      return next;
    },
  };
}
