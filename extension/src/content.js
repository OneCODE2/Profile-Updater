const { assessDocument, waitForProfile } = require("./dom");
const { runSteps, requestStop, clearStop } = require("./runner");
const { toUploadFile } = require("./file");

const post = (message) => chrome.runtime.sendMessage(message);

const readHeader = async (bytes) => {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return u8.slice(0, 8);
};

const stateFromSteps = (steps) => {
  const settings = {
    bumpMode: "dot",
    customHeadlineText: "",
    customSummaryText: "",
    actions: { headline: false, summary: false, resume: false },
  };
  const suffix = {};
  let identityReliable = false;
  let accountRef = null;
  for (const step of steps) {
    settings.actions[step.step] = true;
    if (step.step === "headline" || step.step === "summary") {
      settings.bumpMode = step.mode || settings.bumpMode;
      if (step.step === "headline") settings.customHeadlineText = step.customText || "";
      if (step.step === "summary") settings.customSummaryText = step.customText || "";
      suffix[step.step] = { suffix: step.ownedSuffix || "" };
      identityReliable = !!step.identityReliable;
      accountRef = step.accountRef || null;
    }
  }
  const key = identityReliable && accountRef ? accountRef : "local";
  return {
    settings,
    suffixState: { [key]: suffix },
    connection: { identityReliable, accountRef },
  };
};

async function bindRun(doc, message) {
  const assessment = await waitForProfile(doc, () => doc.location?.href || "");
  const ready = await post({
    type: "RUN_READY",
    runId: message.runId,
    assessment,
  });
  if (!ready?.ok) return ready;
  const steps = message.steps || ready.steps || [];
  const timer = setInterval(() => {
    const focused = doc.visibilityState === "visible" && doc.hasFocus();
    void post({ type: "RUN_HEARTBEAT", runId: message.runId });
    void post({ type: "FOCUS_CHANGED", runId: message.runId, focused });
  }, 20000);
  let outcome;
  try {
  outcome = await runSteps(doc, {
    state: stateFromSteps(steps),
    run: {
      runId: message.runId,
      steps: steps.map((step) => step.step || step),
      filename: steps.find((step) => step.step === "resume")?.fileName || null,
      cancelRequested: false,
    },
    url: doc.location?.href || "",
    hooks: {
      authorize: (step) => post({ type: "REQUEST_STEP_AUTH", runId: message.runId, step }),
      intent: (body) => post({ type: "STEP_INTENT", runId: message.runId, ...body }),
      dispatched: () => post({ type: "STEP_INTENT", runId: message.runId, step: "resume", upload: true, dispatched: true }),
      resumeFile: async () => {
        const file = await post({
          type: "GET_RESUME",
          runId: message.runId,
          revision: steps.find((step) => step.step === "resume")?.revision,
        });
        if (!file?.ok) return { ok: false };
        return { ok: true, file: toUploadFile(file.bytes, file.fileName) };
      },
      assignFile: (input, file) => {
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      },
      stepResult: (body) => post({ type: "STEP_RESULT", runId: message.runId, ...body }),
    },
  });
  } finally {
    clearInterval(timer);
  }
  await post({
    type: "RUN_FINISH",
    runId: message.runId,
    status: outcome.status === "failed" ? "failed_retryable" : outcome.status,
    errorCode: outcome.errorCode || null,
    message: outcome.message || "",
    mutated: !!outcome.mutated,
    uncertain: outcome.status === "unverified",
    uploadDispatched: outcome.status === "unverified",
    steps: outcome.results || null,
  });
  return outcome;
}

function boot() {
  if (globalThis.__npuBound) return;
  globalThis.__npuBound = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || (message.type !== "BIND_RUN" && message.type !== "CHECK_PAGE" && message.type !== "CANCEL_RUN")) return;
    if (message.type === "CANCEL_RUN") {
      requestStop();
      sendResponse({ ok: true });
      return;
    }
    if (message.type === "BIND_RUN") {
      clearStop();
      sendResponse({ ok: true, started: true });
      void bindRun(document, message).catch((err) => {
        void post({
          type: "RUN_FINISH",
          runId: message.runId,
          status: "interrupted",
          errorCode: "RUNNER",
          message: err?.message || "Run interrupted",
        });
      });
      return;
    }
    Promise.resolve({
      ok: true,
      assessment: assessDocument(document, location.href),
    }).then(sendResponse, (err) => {
      sendResponse({ ok: false, message: err?.message || "Run interrupted" });
    });
    return true;
  });
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) boot();

module.exports = { bindRun, boot, readHeader };
