/**
 * Chrome adapter. Listeners are registered by background.js at top level.
 * All writes go through one queue. Worker wake is not treated as browser startup.
 */

const {
  migrate,
  persistable,
  prepareRun,
  startupPlan,
  commitMutation,
  authorizeStep,
  noteIntent,
  markUploadDispatched,
  noteStepResult,
  finishRun,
  notePage,
  heartbeat,
  setFocus,
  cancelRun,
  onTabRemoved,
  commitSettings,
  pauseToday,
  resumeToday,
  clearActivity,
  resetAll,
  removeResume,
  disconnectAccount,
  noteConnection,
  resumeAutomation,
  discardJournal,
  recoverStartup,
  ownedSuffix,
  acceptPdfCandidate,
  commitResumeMeta,
  applyReconcile,
  pruneState,
  alarmPlanFor,
  rememberAlarms,
  decideAlarm,
  catchUpAllowed,
  publicState,
  releaseResume,
  effectiveSlots,
  selectedSteps,
} = require("./engine");
const { validateMessage } = require("./messages");
const { PROFILE_URL } = require("./dom");
const { createResumeStore } = require("./resume-store");
const { systemTimeZone } = require("../../shared/time");

const stepPayload = (state, step) => {
  const settings = state.settings;
  if (step === "resume") {
    return {
      step,
      fileName: state.activeRun?.filename || null,
      revision: state.resumeMeta?.revision || null,
    };
  }
  return {
    step,
    mode: settings.bumpMode === "custom" ? "custom" : "dot",
    customText: step === "summary" ? settings.customSummaryText : settings.customHeadlineText,
    ownedSuffix: ownedSuffix(state, step),
    identityReliable: !!state.connection.identityReliable,
    accountRef: state.connection.accountRef || null,
  };
};

function createApp(platform) {
  let state = null;
  let chain = Promise.resolve();
  let started = false;

  const serial = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => {},
      () => {},
    );
    return run;
  };

  const now = () => platform.now();
  const zone = () => platform.timeZone || systemTimeZone();

  const save = async (next) => {
    try {
      await platform.storage.set(persistable(next));
    } catch {
      const err = new Error("Could not save local extension data.");
      err.code = "QUOTA";
      throw err;
    }
    state = next;
  };

  const syncAlarms = async () => {
    const desired = alarmPlanFor(state, now(), zone());
    const existing = await platform.alarms.getAll();
    for (const alarm of existing) {
      if (String(alarm.name).startsWith("npu:")) await platform.alarms.clear(alarm.name);
    }
    for (const alarm of desired) {
      const info = { when: alarm.when };
      if (alarm.periodInMinutes) info.periodInMinutes = alarm.periodInMinutes;
      await platform.alarms.create(alarm.name, info);
    }
    await save(rememberAlarms(state, desired, now(), zone()));
  };

  const init = async () => {
    if (started) return state;
    if (platform.chromeMajor != null && platform.chromeMajor < 148) {
      state = migrate(null);
      state.lastResult = {
        status: "blocked",
        errorCode: "BROWSER",
        message: "Update Chrome to version 148 or newer.",
        at: now().toISOString(),
      };
      started = true;
      return state;
    }
    if (platform.storage.setAccessLevel) {
      await platform.storage.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    }
    const raw = await platform.storage.getAll();
    state = pruneState(migrate(raw), now(), zone());
    let record = null;
    if (platform.resume) {
      try {
        record = await platform.resume.get();
      } catch {
        record = { byteLength: 0, headerOk: false };
      }
    }
    const reconciled = applyReconcile(state, record);
    state = reconciled.state;
    if (reconciled.status === "missing" || reconciled.status === "corrupt") {
      state = {
        ...state,
        logTail: require("../../shared/text").appendLog(state.logTail, reconciled.message),
      };
    }
    started = true;
    await save(state);
    await syncAlarms();
    return state;
  };

  const gate = () => init();

  const beginCatchUp = async (kind) => {
    if (state.activeRun) return { ok: false, reason: "active" };
    const plan = startupPlan(state, now(), zone());
    if (!plan.selected) return { ok: false, reason: plan.reason || "none", plan };
    if (kind === "reconcile_steady") return { ok: false, reason: "steady", plan };
    const prepared = prepareRun(state, {
      trigger: kind === "startup" ? "catch_up" : "scheduled",
      now: now(),
      timeZone: zone(),
      slotKey: plan.selected,
      earlierMissed: plan.earlierMissed,
      chromeMajor: platform.chromeMajor,
    });
    await save(prepared.state);
    if (!prepared.ok) return prepared;
    return openAndBind(prepared);
  };

  const openAndBind = async (prepared) => {
    const opened = await platform.openProfile({
      windowId: prepared.run.windowId,
    });
    if (!opened?.ok) {
      const cleared = finishRun(
        state,
        {
          runId: state.activeRun.runId,
          status: "blocked",
          errorCode: opened?.code || "NO_WINDOW",
          message: opened?.message || "Could not load or verify Naukri profile.",
        },
        now(),
      );
      await save(cleared.state);
      await syncAlarms();
      return { ok: false, message: opened?.message, state: cleared.state };
    }
    state = {
      ...state,
      activeRun: {
        ...state.activeRun,
        tabId: opened.tab.id,
        windowId: opened.tab.windowId,
      },
    };
    await save(state);
    await waitForNaukriTab(platform.tabs, opened.tab.id);
    if (platform.scripting?.executeScript) {
      await platform.scripting.executeScript({
        target: { tabId: opened.tab.id },
        files: ["content.js"],
      });
    }
    if (platform.tabs?.sendMessage) {
      await platform.tabs.sendMessage(opened.tab.id, {
        type: "BIND_RUN",
        runId: state.activeRun.runId,
        frozenAt: state.activeRun.frozenAt || null,
        steps: state.activeRun.steps.map((step) => stepPayload(state, step)),
      });
    }
    return { ok: true, state: publicState(state, now(), zone(), platform.version) };
  };

  const onInstalled = () => serial(async () => {
    await gate();
    await syncAlarms();
    return { catchUp: false };
  });

  const onStartup = () => serial(async () => {
    await gate();
    const recovered = recoverStartup(state, {
      now: now(),
      timeZone: zone(),
      liveRunner: false,
    });
    await save(recovered.state);
    const result = await beginCatchUp("startup");
    await syncAlarms();
    return result;
  });

  const onAlarm = (alarm) => serial(async () => {
    await gate();
    const decision = decideAlarm(state, alarm?.name, now(), zone());
    if (decision.type === "watchdog") {
      const beat = heartbeat(state, { runId: state.activeRun?.runId, now: now() });
      await save(beat.state);
      if (!beat.ok && state.activeRun?.revoked) {
        const finished = finishRun(
          state,
          {
            runId: state.activeRun.runId,
            status: state.pendingJournal?.uploadDispatched ? "unverified" : "interrupted",
            errorCode: "WATCHDOG",
            message: state.pendingJournal?.uploadDispatched ? "Upload unverified" : "Run interrupted",
            uncertain: !!state.pendingJournal?.uploadDispatched,
          },
          now(),
        );
        await save(finished.state);
      }
      await syncAlarms();
      return decision;
    }
    if (decision.type === "stale" || decision.type === "prior_day" || decision.type === "foreign") {
      await syncAlarms();
      return { ...decision, started: false };
    }
    const kind =
      decision.type === "fire"
        ? "alarm"
        : catchUpAllowed(decision)
          ? "clock"
          : "reconcile_steady";
    const result = await beginCatchUp(kind === "alarm" || kind === "clock" ? kind : "reconcile_steady");
    await syncAlarms();
    return { ...decision, result };
  });

  const onTabRemoved = (tabId) => serial(async () => {
    await gate();
    const result = onTabRemovedEngine(state, tabId, now());
    await save(result.state);
    await syncAlarms();
    return result;
  });

  function onTabRemovedEngine(current, tabId, at) {
    return onTabRemoved(current, tabId, at);
  }

  const handle = async (msg, sender) => {
    const checked = validateMessage(msg, sender, state?.activeRun);
    if (!checked.ok) return { ok: false, message: "Rejected message." };
    if (checked.audience === "ui") return handleUi(msg);
    return handleRunner(msg, checked);
  };

  const onMessage = (msg, sender) => serial(async () => {
    await gate();
    try {
      return await handle(msg, sender);
    } catch (err) {
      if (err.code === "QUOTA") {
        return { ok: false, message: "Could not save local extension data." };
      }
      return { ok: false, message: "Could not load or verify Naukri profile." };
    }
  });

  async function handleUi(msg) {
    if (msg.type === "GET_STATE") {
      return { ok: true, state: publicState(state, now(), zone(), platform.version) };
    }
    if (msg.type === "SAVE_SETTINGS" || msg.type === "FLUSH_SETTINGS") {
      const beforeRevision = state.scheduleRevision;
      const saved = commitSettings(state, msg.patch || {}, msg.revision, now(), zone());
      await save(saved.state);
      if (saved.state.scheduleRevision !== beforeRevision) await syncAlarms();
      return {
        ok: saved.ok,
        message: saved.message || "",
        saveState: saved.saveState,
        state: publicState(state, now(), zone(), platform.version),
      };
    }
    if (msg.type === "RUN_NOW") {
      const prepared = prepareRun(state, {
        trigger: "manual",
        now: now(),
        timeZone: zone(),
        confirmAccount: !!(msg.confirmAccount || state.settings.accountConfirmed),
        windowId: msg.windowId || null,
        chromeMajor: platform.chromeMajor,
      });
      await save(prepared.state);
      if (!prepared.ok) {
        return { ok: false, message: prepared.message, state: publicState(state, now(), zone(), platform.version) };
      }
      const opened = await openAndBind(prepared);
      return opened.ok
        ? opened
        : { ok: false, message: opened.message, state: publicState(state, now(), zone(), platform.version) };
    }
    if (msg.type === "RETRY_RUN") {
      if (!state.lastResult || !/failed_retryable|unverified|conflict/.test(state.lastResult.status)) {
        return { ok: false, message: "Review unresolved update" };
      }
      const prepared = prepareRun(
        { ...state, reviewRequired: false },
        {
          trigger: "retry",
          now: now(),
          timeZone: zone(),
          slotKey: state.lastResult.slotKey,
          confirmAccount: true,
          chromeMajor: platform.chromeMajor,
        },
      );
      await save(prepared.state);
      if (!prepared.ok) return { ok: false, message: prepared.message };
      return openAndBind(prepared);
    }
    if (msg.type === "CANCEL_RUN") {
      const tabId = state.activeRun?.tabId;
      const cancelled = cancelRun(state, now());
      if (cancelled.ok) await save(cancelled.state);
      if (tabId && platform.tabs?.sendMessage) {
        const sent = platform.tabs.sendMessage(tabId, { type: "CANCEL_RUN" });
        if (sent && typeof sent.catch === "function") sent.catch(() => {});
      }
      await syncAlarms();
      return {
        ok: cancelled.ok,
        message: cancelled.message || "",
        state: publicState(state, now(), zone(), platform.version),
      };
    }
    if (msg.type === "PICK_RESUME") {
      const accepted = acceptPdfCandidate(state, msg.file || {});
      if (!accepted.ok) return { ok: false, message: accepted.message, detail: accepted.detail };
      try {
        await platform.resume.put({ ...accepted.record, bytes: msg.file.bytes, headerOk: true });
      } catch {
        return { ok: false, message: "Could not save local extension data." };
      }
      await save(commitResumeMeta(state, accepted.record));
      return { ok: true, state: publicState(state, now(), zone(), platform.version) };
    }
    if (msg.type === "REMOVE_RESUME") {
      const removed = removeResume(state);
      if (!removed.ok) return { ok: false, message: removed.message };
      if (platform.resume?.clear) await platform.resume.clear();
      await save(removed.state);
      return { ok: true, state: publicState(state, now(), zone(), platform.version) };
    }
    if (msg.type === "CLEAR_LOG") {
      await save(clearActivity(state));
      return { ok: true, state: publicState(state, now(), zone(), platform.version) };
    }
    if (msg.type === "RESET_DATA") {
      const reset = resetAll(state);
      if (!reset.ok) return { ok: false, message: reset.message };
      if (platform.resume?.clear) await platform.resume.clear();
      await save(reset.state);
      await syncAlarms();
      return { ok: true, state: publicState(state, now(), zone(), platform.version) };
    }
    if (msg.type === "DISCONNECT" || msg.type === "REBIND") {
      const next = disconnectAccount(state);
      if (!next.ok) return { ok: false, message: next.message };
      await save(next.state);
      await syncAlarms();
      return { ok: true, state: publicState(state, now(), zone(), platform.version) };
    }
    if (msg.type === "PAUSE_TODAY") {
      const paused = pauseToday(state, now(), zone());
      await save(paused.state);
      await syncAlarms();
      return { ok: true, state: publicState(state, now(), zone(), platform.version) };
    }
    if (msg.type === "RESUME_TODAY") {
      const resumed = resumeToday(state, now(), zone());
      await save(resumed.state);
      await syncAlarms();
      return { ok: true, state: publicState(state, now(), zone(), platform.version) };
    }
    if (msg.type === "RESUME_AUTOMATION") {
      await save(resumeAutomation(state));
      await syncAlarms();
      return { ok: true, state: publicState(state, now(), zone(), platform.version) };
    }
    if (msg.type === "DISCARD_JOURNAL") {
      const discarded = discardJournal(state);
      if (!discarded.ok) return { ok: false, message: discarded.message };
      await save(discarded.state);
      return { ok: true, state: publicState(state, now(), zone(), platform.version) };
    }
    if (msg.type === "CONNECT" || msg.type === "CHECK_CONNECTION") {
      const opened = await platform.openProfile({ windowId: msg.windowId || null });
      if (!opened?.ok) {
        return { ok: false, message: opened?.message || "Could not load or verify Naukri profile." };
      }
      await waitUntilLoaded(platform.tabs, opened.tab.id);
      let assessment = null;
      try {
        if (platform.scripting?.executeScript) {
          await platform.scripting.executeScript({
            target: { tabId: opened.tab.id },
            files: ["content.js"],
          });
        }
        if (platform.tabs?.sendMessage) {
          const response = await platform.tabs.sendMessage(opened.tab.id, { type: "CHECK_PAGE" });
          assessment = response?.assessment || null;
        }
      } catch {
        assessment = null;
      }
      if (assessment) await save(noteConnection(state, assessment, now()));
      const status = state.connection.status;
      const message =
        status === "connected_last_verified"
          ? "Connected in this Chrome"
          : assessment?.message || "Sign in on the Naukri tab";
      return { ok: true, message, state: publicState(state, now(), zone(), platform.version) };
    }
    return { ok: false, message: "Rejected message." };
  }

  async function handleRunner(msg, checked) {
    const runId = msg.runId;
    if (msg.type === "PAGE_STATUS" || msg.type === "RUN_READY") {
      if (msg.purpose === "connect") {
        await save(noteConnection(state, msg.assessment, now()));
        const status = state.connection.status;
        const message =
          status === "connected_last_verified"
            ? "Connected in this Chrome"
            : msg.assessment?.message || "Sign in on the Naukri tab";
        return { ok: true, message, state: publicState(state, now(), zone(), platform.version) };
      }
      const noted = notePage(
        state,
        {
          runId,
          assessment: msg.assessment,
          documentId: checked.documentId,
          tabId: checked.tabId,
        },
        now(),
      );
      await save(noted.state);
      if (!noted.ok) {
        await notify(noted.notify);
        await syncAlarms();
        return { ok: false, message: noted.message };
      }
      const committed = commitMutation(state, now());
      await save(committed.state);
      if (!committed.ok) return { ok: false, message: committed.message };
      return {
        ok: true,
        steps: state.activeRun.steps.map((step) => stepPayload(state, step)),
      };
    }
    if (msg.type === "REQUEST_STEP_AUTH") {
      const auth = authorizeStep(state, {
        runId,
        step: msg.step,
        documentId: checked.documentId,
        tabId: checked.tabId,
      });
      await save(auth.state);
      if (!auth.ok) return { ok: false, code: auth.code || null, message: auth.message || "Run interrupted" };
      return { ok: true, config: stepPayload(state, msg.step) };
    }
    if (msg.type === "STEP_INTENT") {
      if (msg.dispatched) {
        const marked = markUploadDispatched(state, runId);
        await save(marked.state || state);
        return { ok: !!marked.ok, code: marked.code || null, message: marked.message || "" };
      }
      const intent = noteIntent(state, {
        runId,
        step: msg.step,
        before: msg.before,
        target: msg.target,
        upload: !!msg.upload,
      });
      await save(intent.state);
      return { ok: !!intent.ok, code: intent.code || null, message: intent.message || "" };
    }
    if (msg.type === "GET_RESUME") {
      const released = releaseResume(state, {
        runId,
        revision: msg.revision,
        step: "resume",
      });
      if (!released.ok) return { ok: false };
      const record = await platform.resume.get();
      if (!record?.bytes) return { ok: false, message: "Saved resume is unavailable. Please select it again." };
      await save(released.state);
      return {
        ok: true,
        fileName: released.fileName,
        mime: "application/pdf",
        bytes: record.bytes,
      };
    }
    if (msg.type === "STEP_RESULT") {
      const noted = noteStepResult(state, {
        runId,
        step: msg.step,
        status: msg.status,
        suffix: msg.suffix,
      });
      await save(noted.state || state);
      return { ok: !!noted.ok };
    }
    if (msg.type === "RUN_HEARTBEAT") {
      const beat = heartbeat(state, { runId, now: now() });
      await save(beat.state);
      return { ok: !!beat.ok };
    }
    if (msg.type === "FOCUS_CHANGED") {
      const focused = setFocus(state, { runId, focused: !!msg.focused });
      await save(focused.state);
      return { ok: true };
    }
    if (msg.type === "RUN_FINISH") {
      let working = state;
      if (msg.uploadDispatched) {
        const marked = markUploadDispatched(working, runId);
        working = marked.state || working;
      }
      const finished = finishRun(
        working,
        {
          runId,
          status: msg.status,
          errorCode: msg.errorCode || null,
          message: msg.message || "",
          steps: msg.steps || null,
          mutated: !!msg.mutated,
          uncertain: !!msg.uncertain,
        },
        now(),
      );
      await save(finished.state);
      await notify(finished.notify);
      await syncAlarms();
      return { ok: true, duplicate: !!finished.duplicate };
    }
    return { ok: false, message: "Rejected message." };
  }

  async function notify(note) {
    if (!note || !platform.notifications?.create) return;
    try {
      await platform.notifications.create(`npu-${Date.now()}`, {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: note.title,
        message: note.message,
      });
    } catch {
      /* notification failure must not change the run result */
    }
  }

  return {
    init: gate,
    onInstalled,
    onStartup,
    onAlarm,
    onMessage,
    onTabRemoved,
    syncAlarms: () => serial(async () => {
      await gate();
      await syncAlarms();
    }),
    snapshot: () => state,
    serial,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForNaukriTab = async (tabs, tabId) => {
  if (!tabs?.get || tabId == null) return null;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    let tab;
    try {
      tab = await tabs.get(tabId);
    } catch {
      return null;
    }
    if (tab?.status === "complete" && String(tab.url || "").startsWith("https://www.naukri.com/")) return tab;
    await sleep(300);
  }
  try {
    return await tabs.get(tabId);
  } catch {
    return null;
  }
};

const waitUntilLoaded = async (tabs, tabId) => {
  if (!tabs?.get || tabId == null) return;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    let tab;
    try {
      tab = await tabs.get(tabId);
    } catch {
      return;
    }
    if (tab?.status === "complete") return;
    await sleep(200);
  }
};

const chromePlatform = (chrome, extras = {}) => ({
  version: chrome.runtime?.getManifest?.().version || "1.0.0",
  chromeMajor: extras.chromeMajor,
  now: extras.now || (() => new Date()),
  timeZone: extras.timeZone,
  storage: {
    async getAll() {
      return chrome.storage.local.get(null);
    },
    async set(obj) {
      return chrome.storage.local.set(obj);
    },
    async setAccessLevel(opts) {
      if (chrome.storage.local.setAccessLevel) return chrome.storage.local.setAccessLevel(opts);
    },
  },
  alarms: chrome.alarms,
  tabs: chrome.tabs,
  windows: chrome.windows,
  scripting: chrome.scripting,
  notifications: chrome.notifications,
  resume: extras.resume || (typeof indexedDB === "undefined" ? null : createResumeStore()),
  async openProfile({ windowId } = {}) {
    const tabs = await chrome.tabs.query({ url: "https://www.naukri.com/*" });
    const existing = (tabs || []).find(
      (tab) => !tab.incognito && /\/mnjuser\/profile/.test(tab.url || ""),
    );
    let tab = existing;
    if (!tab) {
      const create = { url: PROFILE_URL, active: true };
      if (windowId) create.windowId = windowId;
      try {
        tab = await chrome.tabs.create(create);
      } catch {
        return { ok: false, code: "NO_WINDOW", message: "Could not load or verify Naukri profile." };
      }
    } else {
      await chrome.tabs.update(tab.id, { active: true });
    }
    if (tab?.windowId != null && chrome.windows?.update) {
      try {
        await chrome.windows.update(tab.windowId, { focused: true });
      } catch {
        /* focusing the window is optional; the profile tab is already open */
      }
    }
    return tab?.id == null
      ? { ok: false, code: "NO_WINDOW", message: "Could not load or verify Naukri profile." }
      : { ok: true, tab };
  },
});

module.exports = {
  createApp,
  chromePlatform,
  stepPayload,
  selectedSteps,
  effectiveSlots,
};
