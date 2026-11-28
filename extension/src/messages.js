/** Message boundary checks. Tab ids come from the sender, never the payload. */

const UI_TYPES = new Set([
  "GET_STATE",
  "SAVE_SETTINGS",
  "CONNECT",
  "CHECK_CONNECTION",
  "DISCONNECT",
  "REBIND",
  "RUN_NOW",
  "RETRY_RUN",
  "CANCEL_RUN",
  "PICK_RESUME",
  "REMOVE_RESUME",
  "CLEAR_LOG",
  "RESET_DATA",
  "DISCARD_JOURNAL",
  "PAUSE_TODAY",
  "RESUME_TODAY",
  "RESUME_AUTOMATION",
  "FLUSH_SETTINGS",
]);

const RUNNER_TYPES = new Set([
  "RUN_READY",
  "REQUEST_STEP_AUTH",
  "STEP_INTENT",
  "GET_RESUME",
  "STEP_RESULT",
  "RUN_HEARTBEAT",
  "RUN_FINISH",
  "FOCUS_CHANGED",
  "PAGE_STATUS",
]);

const isObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);

const validateEnvelope = (msg) => {
  if (!isObject(msg)) return { ok: false, message: "Rejected message." };
  if (typeof msg.type !== "string" || msg.type.length < 1 || msg.type.length > 64) {
    return { ok: false, message: "Rejected message." };
  }
  return { ok: true };
};

const ownPage = (sender, url) => {
  const id = sender.id || "";
  return !!id && String(url || "").startsWith(`chrome-extension://${id}/`);
};

/** Options opens in a tab, so sender.tab is set. A Naukri tab is not this extension. */
const extensionPage = (sender) => {
  if (!sender || sender.tab?.incognito) return false;
  if (ownPage(sender, sender.url) || ownPage(sender, sender.tab?.url)) return true;
  if (sender.tab) return false;
  return sender.context === "extension_page";
};

const runnerSender = (sender, run) => {
  if (!sender || !run) return false;
  if (!sender.tab || sender.tab.id == null) return false;
  if (sender.tab.incognito) return false;
  if (sender.frameId !== 0) return false;
  let url;
  try {
    url = new URL(sender.url || "");
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.hostname !== "www.naukri.com") return false;
  if (sender.tab.id !== run.tabId) return false;
  if (run.documentId && sender.documentId !== run.documentId) return false;
  return true;
};

const validateMessage = (msg, sender, activeRun) => {
  const envelope = validateEnvelope(msg);
  if (!envelope.ok) return envelope;
  if (UI_TYPES.has(msg.type)) {
    if (!extensionPage(sender)) return { ok: false, message: "Rejected message." };
    return { ok: true, audience: "ui" };
  }
  if (RUNNER_TYPES.has(msg.type)) {
    if (!runnerSender(sender, activeRun)) return { ok: false, message: "Rejected message." };
    if (msg.runId && activeRun && msg.runId !== activeRun.runId) {
      return { ok: false, message: "Rejected message.", ignored: true };
    }
    return { ok: true, audience: "runner", tabId: sender.tab.id, documentId: sender.documentId };
  }
  return { ok: false, message: "Rejected message." };
};

module.exports = {
  UI_TYPES,
  RUNNER_TYPES,
  validateEnvelope,
  validateMessage,
  extensionPage,
  runnerSender,
};
