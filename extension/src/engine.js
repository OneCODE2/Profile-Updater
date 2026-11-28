/**
 * Extension state machine. The service worker is the only writer; this module is pure
 * so recovery, scheduling, and storage rules can be tested without Chrome.
 */

const { emptyCustomMessage, planFieldUpdate, uploadedToday } = require("../../shared/bump");
const { describeIdentity, identityFromResumePath } = require("../../shared/filename");
const { parseCustomSlots, normalizeSlot } = require("../../shared/slots");
const {
  localParts,
  systemTimeZone,
  zoneSignature,
} = require("../../shared/time");
const {
  HANDLED_SLOT_STATES,
  MAX_ATTEMPTS,
  effectiveSlots,
  catchUpPlan,
  markPastOnConfig,
  pruneSlotRecords,
  planAlarms,
  evaluateAlarm,
  clockEvent,
  pauseRemaining,
  resumeFutureToday,
} = require("../../shared/schedule");
const { screenPdf, reconcileResume, resumeMetaFrom } = require("../../shared/pdf");
const { appendLog, pushHistory, redact } = require("../../shared/text");

const STALE_LEASE_MS = 10 * 60 * 1000;
const MAX_RUN_MS = 10 * 60 * 1000;
const COOLDOWN_MS = 10 * 60 * 1000;
const SCHEMA_VERSION = 2;

const STEP_LABELS = {
  headline: "Updating headline",
  summary: "Updating profile summary",
  resume: "Uploading resume",
};

const defaultSettings = () => ({
  bumpMode: "dot",
  customHeadlineText: "",
  customSummaryText: "",
  actions: { headline: true, summary: true, resume: true },
  firstName: "",
  lastName: "",
  role: "",
  scheduleEnabled: true,
  scheduleMode: "custom",
  customSlots: ["09:00", "11:30", "14:00", "16:00"],
  intervalAnchor: "09:00",
  revision: 1,
  pauseDay: null,
  termsAcknowledged: true,
  manualCooldown: false,
  accountConfirmed: true,
});

const defaultConnection = () => ({
  status: "not_connected",
  verifiedAt: null,
  accountRef: null,
  identityReliable: false,
});

const defaultState = () => ({
  schemaVersion: SCHEMA_VERSION,
  settings: defaultSettings(),
  resumeMeta: null,
  connection: defaultConnection(),
  slotRecords: {},
  activeRun: null,
  pendingJournal: null,
  suffixState: {},
  history: [],
  logTail: "",
  lastResult: null,
  lastSuccessCheckAt: null,
  lastConfirmedMutationAt: null,
  scheduleRevision: 1,
  automationSuspended: false,
  reviewRequired: false,
  runtime: {
    alarmMeta: [],
    lastClockAt: null,
    zoneSignature: null,
    lastBlockedNotice: null,
    resumeReleasedFor: null,
  },
});

const makeId = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `id-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
};

const selectedSteps = (settings) => {
  const actions = settings?.actions || {};
  const steps = [];
  if (actions.headline) steps.push("headline");
  if (actions.summary) steps.push("summary");
  if (actions.resume) steps.push("resume");
  return steps;
};

const boundString = (value, max = 2000) => {
  const text = String(value ?? "");
  return text.length > max ? null : text;
};

const clone = (value) => JSON.parse(JSON.stringify(value));

const migrate = (raw) => {
  const src = raw && typeof raw === "object" ? raw : {};
  const fresh = !src.schemaVersion && !src.settings && !src.firedKeys && !src.slotRecords;
  if (fresh) return defaultState();

  const state = defaultState();
  state.schemaVersion = SCHEMA_VERSION;
  state.settings = { ...defaultSettings(), ...(src.settings || {}) };
  state.settings.actions = {
    headline: state.settings.actions?.headline !== false,
    summary: state.settings.actions?.summary !== false,
    resume: state.settings.actions?.resume !== false,
  };
  state.settings.customSlots = Array.isArray(state.settings.customSlots)
    ? state.settings.customSlots
    : [];
  if (Number(src.schemaVersion || 0) < 2) {
    state.settings.scheduleEnabled = true;
    state.settings.termsAcknowledged = true;
    state.settings.accountConfirmed = true;
    if (!state.settings.customSlots.length) {
      state.settings.customSlots = ["09:00", "11:30", "14:00", "16:00"];
    }
  }
  state.resumeMeta = src.resumeMeta || null;
  state.connection = { ...defaultConnection(), ...(src.connection || {}) };
  state.slotRecords = { ...(src.slotRecords || {}) };
  const fired = Array.isArray(src.firedKeys) ? src.firedKeys : [];
  for (const key of fired) {
    if (!state.slotRecords[key]) {
      state.slotRecords[key] = { state: "success", attempts: 1, migrated: true };
    }
  }
  state.activeRun = src.activeRun || null;
  state.pendingJournal = src.pendingJournal || null;
  state.suffixState = src.suffixState || {};
  state.history = Array.isArray(src.history) ? src.history.slice(0, 50) : [];
  state.logTail = typeof src.logTail === "string" ? src.logTail : "";
  state.lastResult = src.lastResult || null;
  state.lastSuccessCheckAt = src.lastSuccessCheckAt || null;
  state.lastConfirmedMutationAt = src.lastConfirmedMutationAt || null;
  state.scheduleRevision = Number(src.scheduleRevision || state.settings.revision || 1);
  state.automationSuspended = !!src.automationSuspended;
  state.reviewRequired = !!src.reviewRequired;
  state.runtime = { ...state.runtime, ...(src.runtime || {}) };
  state.schemaVersion = SCHEMA_VERSION;
  return state;
};

const persistable = (state) => ({
  schemaVersion: state.schemaVersion,
  settings: state.settings,
  resumeMeta: state.resumeMeta,
  connection: state.connection,
  slotRecords: state.slotRecords,
  activeRun: state.activeRun,
  pendingJournal: state.pendingJournal,
  suffixState: state.suffixState,
  history: state.history,
  logTail: state.logTail,
  lastResult: state.lastResult,
  lastSuccessCheckAt: state.lastSuccessCheckAt,
  lastConfirmedMutationAt: state.lastConfirmedMutationAt,
  scheduleRevision: state.scheduleRevision,
  automationSuspended: state.automationSuspended,
  reviewRequired: state.reviewRequired,
  runtime: state.runtime,
});

const suffixBucketKey = (state) => {
  if (state.connection.identityReliable && state.connection.accountRef) {
    return state.connection.accountRef;
  }
  return "local";
};

const ownedSuffix = (state, step) =>
  state.suffixState?.[suffixBucketKey(state)]?.[step]?.suffix || "";

const rememberSuffix = (state, step, suffix) => {
  const key = suffixBucketKey(state);
  const bucket = { ...(state.suffixState[key] || {}) };
  bucket[step] = { suffix: suffix || "", at: new Date().toISOString() };
  return { ...state.suffixState, [key]: bucket };
};

const validateConfig = (state, trigger, confirmAccount) => {
  const settings = state.settings;
  const steps = selectedSteps(settings);
  if (!steps.length) {
    return { ok: false, code: "NO_ACTION", message: "Select at least one update action." };
  }
  if (steps.includes("headline") && settings.bumpMode === "custom" && !String(settings.customHeadlineText || "").trim()) {
    return { ok: false, code: "CUSTOM_EMPTY", message: emptyCustomMessage("headline") };
  }
  if (steps.includes("summary") && settings.bumpMode === "custom" && !String(settings.customSummaryText || "").trim()) {
    return { ok: false, code: "CUSTOM_EMPTY", message: emptyCustomMessage("summary") };
  }
  if (steps.includes("resume")) {
    if (!state.resumeMeta) {
      return { ok: false, code: "NO_PDF", message: "Choose a resume PDF before updating." };
    }
    const named = describeIdentity(settings, state.resumeMeta.originalName);
    if (!named.ok) return { ok: false, code: "IDENTITY", message: named.message };
  }
  if (trigger !== "manual") {
    if (!settings.termsAcknowledged) {
      return {
        ok: false,
        code: "TERMS",
        message: "Review the terms warning and confirm scheduling is allowed before enabling it.",
      };
    }
    if (!settings.scheduleEnabled) {
      return { ok: false, code: "SCHEDULE_OFF", message: "Schedule is off." };
    }
    if (state.connection.status === "session_expired" || state.connection.status === "awaiting_sign_in") {
      return { ok: false, code: "LOGIN", message: "Sign in to Naukri in this Chrome" };
    }
    if (!state.connection.identityReliable && !settings.accountConfirmed) {
      return { ok: false, code: "ACCOUNT", message: "Confirm the correct Naukri account." };
    }
    if (!settings.accountConfirmed && state.connection.status !== "connected_last_verified") {
      return { ok: false, code: "LOGIN", message: "Sign in to Naukri in this Chrome" };
    }
  } else if (!state.connection.identityReliable && !(confirmAccount || settings.accountConfirmed)) {
    return { ok: false, code: "ACCOUNT", message: "Confirm the correct Naukri account." };
  }
  if (state.connection.status === "account_changed") {
    return { ok: false, code: "ACCOUNT", message: "Confirm the correct Naukri account." };
  }
  return { ok: true, steps };
};

const scheduleGate = (settings, state) => {
  if (!settings.termsAcknowledged) {
    return {
      ok: false,
      code: "TERMS",
      message: "Review the terms warning and confirm scheduling is allowed before enabling it.",
    };
  }
  if (!effectiveSlots(settings).length) {
    return { ok: false, code: "NO_SLOTS", message: "Add a valid time before enabling the schedule." };
  }
  return validateConfig({ ...state, settings, connection: { ...state.connection, status: state.connection.status } }, "scheduled", false);
};

const leaseExpired = (run, now) => {
  if (!run) return false;
  const beat = Date.parse(run.heartbeatAt || run.startedAt);
  const start = Date.parse(run.startedAt);
  return now.getTime() - beat > STALE_LEASE_MS || now.getTime() - start > MAX_RUN_MS;
};

const blockedResult = (state, code, message, input) => {
  const timeZone = input.timeZone || systemTimeZone();
  const day = localParts(input.now, timeZone).day;
  const line = redact(`${code}: ${message}`);
  const duplicate = state.logTail.split("\n").includes(line);
  const logTail = duplicate ? state.logTail : appendLog(state.logTail, line);
  const lastResult = {
    status: "blocked",
    errorCode: code,
    message,
    at: input.now.toISOString(),
    trigger: input.trigger,
    slotKey: input.slotKey || null,
    runId: null,
  };
  const runtime = { ...state.runtime };
  const dedupeKey = `${day}|${code}|${input.slotKey || ""}`;
  const notify =
    input.trigger !== "manual" && runtime.lastBlockedNotice !== dedupeKey;
  if (notify) runtime.lastBlockedNotice = dedupeKey;
  return {
    ok: false,
    code,
    message,
    notify: notify ? notificationFor(lastResult, input.trigger) : null,
    state: { ...state, logTail, lastResult, runtime },
  };
};

const cooldownHit = (state, now) => {
  if (!state.settings.manualCooldown || !state.lastConfirmedMutationAt) return false;
  const delta = now.getTime() - Date.parse(state.lastConfirmedMutationAt);
  return delta >= 0 && delta <= COOLDOWN_MS;
};

const filenameFor = (state, now) => {
  const named = describeIdentity(
    state.settings,
    state.resumeMeta?.originalName || "",
    now,
  );
  return named.ok ? named.fileName : null;
};

const prepareRun = (state, input) => {
  const now = input.now;
  const timeZone = input.timeZone || systemTimeZone();
  const trigger = input.trigger || "manual";
  let current = state;

  if (input.chromeMajor != null && Number(input.chromeMajor) < 148) {
    return blockedResult(current, "BROWSER", "Update Chrome to version 148 or newer.", input);
  }

  if (current.activeRun) {
    const expired = leaseExpired(current.activeRun, now);
    if (input.liveRunner && expired) {
      return {
        ok: false,
        code: "ALREADY_ACTIVE",
        message: "A run is already in progress.",
        state: { ...current, activeRun: { ...current.activeRun, revoked: true } },
      };
    }
    if (!expired || input.liveRunner) {
      return {
        ok: false,
        code: "ALREADY_ACTIVE",
        message: "A run is already in progress.",
        state: current,
      };
    }
    if (current.pendingJournal?.uploadDispatched && !current.pendingJournal.resolved) {
      const closed = finishRun(
        current,
        {
          runId: current.activeRun.runId,
          status: "unverified",
          errorCode: "UPLOAD_UNVERIFIED",
          message: "Upload unverified",
        },
        now,
      );
      return {
        ok: false,
        code: "UNVERIFIED",
        message: "Upload unverified",
        state: { ...closed.state, reviewRequired: true },
      };
    }
    if (current.pendingJournal && !current.pendingJournal.resolved && current.activeRun.mutationStarted) {
      return {
        ok: false,
        code: "REVIEW",
        message: "Review unresolved update",
        state: { ...current, reviewRequired: true },
      };
    }
    current = { ...current, activeRun: null };
  }

  if (current.reviewRequired && trigger !== "retry") {
    const prior = current.lastResult?.status;
    if (prior === "unverified" || prior === "conflict") {
      current = {
        ...current,
        reviewRequired: false,
        pendingJournal: null,
        suffixState: prior === "conflict" ? {} : current.suffixState,
      };
    } else {
      return {
        ok: false,
        code: "REVIEW",
        message: "Review unresolved update",
        state: current,
      };
    }
  }

  if (current.automationSuspended && trigger !== "manual") {
    return blockedResult(
      current,
      "ACTION_REQUIRED",
      "Action required — resolve on Naukri and resume manually.",
      input,
    );
  }

  const config = validateConfig(current, trigger, !!input.confirmAccount);
  if (!config.ok) return blockedResult(current, config.code, config.message, input);

  if (trigger !== "manual" && cooldownHit(current, now) && input.slotKey) {
    const slotRecords = {
      ...current.slotRecords,
      [input.slotKey]: {
        state: "skipped_cooldown",
        attempts: current.slotRecords[input.slotKey]?.attempts || 0,
      },
    };
    return {
      ok: false,
      code: "COOLDOWN",
      message: "Skipped; the same update just completed.",
      state: { ...current, slotRecords },
    };
  }

  if (input.slotKey) {
    const attempts = current.slotRecords[input.slotKey]?.attempts || 0;
    if (attempts >= MAX_ATTEMPTS) {
      const slotRecords = {
        ...current.slotRecords,
        [input.slotKey]: {
          ...(current.slotRecords[input.slotKey] || {}),
          state: "failed_final",
          attempts,
        },
      };
      return {
        ok: false,
        code: "RETRY_EXHAUSTED",
        message: "Resume upload failed.",
        state: { ...current, slotRecords },
      };
    }
  }

  const parts = localParts(now, timeZone);
  const run = {
    runId: input.runId || makeId(),
    trigger,
    slotKey: trigger === "manual" ? null : input.slotKey || null,
    earlierMissed: trigger === "manual" ? [] : input.earlierMissed || [],
    settingsRevision: current.settings.revision,
    scheduleRevision: current.scheduleRevision,
    resumeRevision: current.resumeMeta?.revision || null,
    accountRef: current.connection.accountRef || null,
    startedAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    localDay: parts.day,
    frozenAt: now.toISOString(),
    timeZone,
    stage: "preflight",
    mutationStarted: false,
    cancelRequested: false,
    revoked: false,
    pausedForFocus: false,
    steps: config.steps,
    stepState: Object.fromEntries(config.steps.map((step) => [step, "pending"])),
    currentStep: config.steps[0] || null,
    tabId: input.tabId || null,
    windowId: input.windowId || null,
    documentId: null,
    filename: config.steps.includes("resume") ? filenameFor(current, now) : null,
    mutated: false,
  };

  return { ok: true, state: { ...current, activeRun: run }, run };
};

const startupPlan = (state, now, timeZone = systemTimeZone()) => {
  const slots = effectiveSlots(state.settings);
  return catchUpPlan({
    now,
    timeZone,
    effectiveSlots: slots,
    enabled: state.settings.scheduleEnabled && !state.automationSuspended,
    records: state.slotRecords,
    pauseDay: state.settings.pauseDay,
    activeRun: state.activeRun,
  });
};

const commitMutation = (state, now) => {
  const run = state.activeRun;
  if (!run) return { ok: false, code: "NO_RUN", message: "Run interrupted", state };
  if (run.revoked || run.cancelRequested) {
    return {
      ok: false,
      code: "CANCELLED",
      message: "Run cancelled; completed changes may remain.",
      state,
    };
  }
  if (run.mutationStarted) return { ok: true, state };
  const slotRecords = { ...state.slotRecords };
  if (run.slotKey) {
    const prev = slotRecords[run.slotKey] || { attempts: 0 };
    slotRecords[run.slotKey] = {
      state: "running",
      attempts: (prev.attempts || 0) + 1,
      runId: run.runId,
    };
  }
  for (const key of run.earlierMissed || []) {
    const prev = slotRecords[key];
    if (!prev || !HANDLED_SLOT_STATES.has(prev.state)) {
      slotRecords[key] = {
        state: "skipped_coalesced",
        attempts: prev?.attempts || 0,
        runId: run.runId,
      };
    }
  }
  return {
    ok: true,
    state: {
      ...state,
      slotRecords,
      activeRun: {
        ...run,
        mutationStarted: true,
        stage: "editing",
        heartbeatAt: now.toISOString(),
      },
    },
  };
};

const sameRun = (state, runId) =>
  !!state.activeRun && state.activeRun.runId === runId && !state.activeRun.revoked;

const authorizeStep = (state, { runId, step, documentId, tabId } = {}) => {
  const run = state.activeRun;
  if (!run || run.runId !== runId) return { ok: false, state, ignored: true };
  if (run.revoked || run.cancelRequested) {
    return {
      ok: false,
      state,
      code: "CANCELLED",
      message: "Run cancelled; completed changes may remain.",
    };
  }
  if (run.pausedForFocus) return { ok: false, state, code: "PAUSED", message: "Run paused" };
  if (documentId && run.documentId && documentId !== run.documentId) {
    return { ok: false, state, ignored: true };
  }
  if (tabId && run.tabId && tabId !== run.tabId) return { ok: false, state, ignored: true };
  if (step !== run.currentStep) return { ok: false, state, code: "STEP", message: "Unexpected step" };
  return {
    ok: true,
    state: {
      ...state,
      activeRun: {
        ...run,
        stage: step,
        stepState: { ...run.stepState, [step]: "in_progress" },
      },
    },
  };
};

const noteIntent = (state, { runId, step, before, target, upload = false } = {}) => {
  if (!sameRun(state, runId)) return { ok: false, state, ignored: true };
  if (state.activeRun.cancelRequested) {
    return { ok: false, state, code: "CANCELLED", message: "Run cancelled; completed changes may remain." };
  }
  const run = state.activeRun;
  const journal = {
    ...(state.pendingJournal || {}),
    runId,
    localDay: run.localDay,
    settingsRevision: run.settingsRevision,
    resumeRevision: run.resumeRevision,
    accountRef: run.accountRef,
    resolved: false,
    steps: { ...(state.pendingJournal?.steps || {}) },
  };
  journal.steps[step] = {
    before: before == null ? null : String(before),
    target: target == null ? null : String(target),
    status: "intent",
  };
  if (upload) journal.uploadPrepared = true;
  return { ok: true, state: { ...state, pendingJournal: journal } };
};

const markUploadDispatched = (state, runId) => {
  if (!sameRun(state, runId) || !state.pendingJournal) return { ok: false, state };
  if (state.activeRun.cancelRequested) {
    return { ok: false, state, code: "CANCELLED", message: "Run cancelled; completed changes may remain." };
  }
  return {
    ok: true,
    state: {
      ...state,
      pendingJournal: { ...state.pendingJournal, uploadDispatched: true },
    },
  };
};

const advance = (run, step, status) => {
  const stepState = { ...run.stepState, [step]: status };
  const index = run.steps.indexOf(step);
  const nextStep = run.steps[index + 1] || null;
  return {
    ...run,
    stepState,
    currentStep: nextStep,
    stage: nextStep || "finishing",
    mutated: run.mutated || status === "verified",
  };
};

const noteStepResult = (state, { runId, step, status, suffix } = {}) => {
  if (!sameRun(state, runId)) return { ok: false, state, ignored: true };
  let next = state;
  if ((status === "verified" || status === "no_change") && suffix != null && step !== "resume") {
    next = { ...next, suffixState: rememberSuffix(next, step, suffix) };
  }
  if (next.pendingJournal?.steps?.[step]) {
    const journal = {
      ...next.pendingJournal,
      steps: {
        ...next.pendingJournal.steps,
        [step]: { ...next.pendingJournal.steps[step], status },
      },
    };
    next = { ...next, pendingJournal: journal };
  }
  const run = advance(next.activeRun, step, status);
  return { ok: true, state: { ...next, activeRun: run } };
};

const publicSteps = (run) => {
  const out = {};
  for (const step of run?.steps || []) out[step] = run.stepState?.[step] || "pending";
  return out;
};

const slotStateFor = (status) => {
  if (status === "success" || status === "no_changes") return "success";
  if (status === "failed_retryable") return "failed_retryable";
  if (status === "failed_final") return "failed_final";
  if (status === "blocked") return "blocked";
  if (status === "unverified") return "unverified";
  if (status === "conflict") return "conflict";
  if (status === "cancelled") return "cancelled";
  if (status === "interrupted") return "interrupted";
  return status;
};

const applyOverlap = (state, run, records) => {
  const next = { ...records };
  const day = run.localDay;
  for (const [key, rec] of Object.entries(next)) {
    if (!key.startsWith(`${day}|`) || key === run.slotKey) continue;
    if (rec && HANDLED_SLOT_STATES.has(rec.state)) continue;
    if (run.settingsRevision === state.settings.revision && run.accountRef === state.connection.accountRef) {
      next[key] = { state: "skipped_overlap", attempts: rec?.attempts || 0, runId: run.runId };
    }
  }
  return next;
};

const defaultStatusMessage = (status) => {
  switch (status) {
    case "success":
      return "Profile update completed";
    case "no_changes":
      return "No changes needed";
    case "failed_retryable":
    case "failed_final":
      return "Resume upload failed.";
    case "unverified":
      return "Upload unverified";
    case "conflict":
      return "Profile changed outside this run; review before retrying.";
    case "interrupted":
      return "Run interrupted";
    case "cancelled":
      return "Run cancelled; completed changes may remain.";
    case "blocked":
      return "Could not load or verify Naukri profile.";
    default:
      return "Profile update needs attention";
  }
};

const notificationFor = (result, trigger) => {
  if (!result || trigger === "manual") return null;
  if (result.status === "blocked") {
    return {
      title: "Profile update needs attention",
      message: redact(result.message || "Profile update needs attention"),
    };
  }
  const title =
    result.status === "success"
      ? "Profile update completed"
      : result.status === "no_changes"
        ? "No changes needed"
        : result.status === "unverified" || result.status === "conflict"
          ? "Profile update needs attention"
          : result.status === "failed_retryable" ||
              result.status === "failed_final" ||
              result.status === "interrupted"
            ? "Profile update failed"
            : "Profile update needs attention";
  return { title, message: redact(result.message || title) };
};

const finishRun = (state, result, now) => {
  const runId = result.runId || state.activeRun?.runId;
  if (state.history.some((row) => row.runId === runId)) {
    return { ok: true, state, duplicate: true, notify: null };
  }
  const run = state.activeRun;
  if (!run || run.runId !== runId) return { ok: false, state, ignored: true, notify: null };

  let status = result.status;
  const slotRecords = { ...state.slotRecords };
  if (run.slotKey && run.mutationStarted && slotRecords[run.slotKey]) {
    let slotState = slotStateFor(status);
    const attempts = slotRecords[run.slotKey].attempts || 0;
    if (attempts >= MAX_ATTEMPTS && status === "failed_retryable") {
      status = "failed_final";
      slotState = "failed_final";
    }
    if (status === "interrupted" || status === "cancelled") {
      slotState = status === "cancelled" ? "failed_retryable" : "failed_retryable";
      if (result.uncertain || state.pendingJournal?.uploadDispatched) {
        status = "unverified";
        slotState = "unverified";
      }
    }
    slotRecords[run.slotKey] = {
      state: slotState,
      attempts,
      runId: run.runId,
      reason: result.errorCode || null,
    };
  } else if (run.slotKey && !run.mutationStarted) {
    const prev = slotRecords[run.slotKey];
    if (prev?.state === "running") {
      slotRecords[run.slotKey] = { state: "pending", attempts: prev.attempts || 0, runId: run.runId };
    }
  }

  let records = slotRecords;
  if (status === "success") records = applyOverlap(state, run, slotRecords);

  const message = redact(result.message || defaultStatusMessage(status));
  const historyItem = {
    runId: run.runId,
    trigger: run.trigger,
    slotKey: run.slotKey,
    startedAt: run.startedAt,
    finishedAt: now.toISOString(),
    status,
    steps: { ...publicSteps(run), ...(result.steps || {}) },
    errorCode: result.errorCode || null,
    message,
  };
  const keepJournal =
    status === "unverified" ||
    status === "conflict" ||
    status === "failed_retryable" ||
    (status === "interrupted" && run.mutationStarted);
  let pendingJournal = keepJournal ? state.pendingJournal : null;
  if (pendingJournal) {
    pendingJournal = {
      runId: pendingJournal.runId,
      localDay: pendingJournal.localDay,
      settingsRevision: pendingJournal.settingsRevision,
      resumeRevision: pendingJournal.resumeRevision,
      accountRef: pendingJournal.accountRef,
      uploadDispatched: !!pendingJournal.uploadDispatched,
      resolved: false,
      steps: Object.fromEntries(
        Object.entries(pendingJournal.steps || {}).map(([key, value]) => [
          key,
          {
            status: value.status || "intent",
            before: value.before ?? null,
            target: value.target ?? null,
          },
        ]),
      ),
    };
  }
  const checked = status === "success" || status === "no_changes";
  const confirmed = status === "success" && (run.mutated || result.mutated);
  const runtime = { ...state.runtime };
  let notify = notificationFor({ status, message }, run.trigger);
  if (status === "blocked") {
    const key = `${run.localDay}|${result.errorCode || ""}|${run.slotKey || ""}`;
    if (runtime.lastBlockedNotice === key) notify = null;
    else runtime.lastBlockedNotice = key;
  }
  return {
    ok: true,
    notify,
    duplicate: false,
    state: {
      ...state,
      activeRun: null,
      slotRecords: records,
      pendingJournal,
      history: pushHistory(state.history, historyItem),
      lastResult: {
        status,
        errorCode: historyItem.errorCode,
        message,
        at: historyItem.finishedAt,
        runId: run.runId,
        trigger: run.trigger,
        slotKey: run.slotKey,
      },
      lastSuccessCheckAt: checked ? historyItem.finishedAt : state.lastSuccessCheckAt,
      lastConfirmedMutationAt: confirmed ? historyItem.finishedAt : state.lastConfirmedMutationAt,
      reviewRequired: status === "unverified" || status === "conflict",
      runtime,
      logTail: appendLog(state.logTail, `${status}${historyItem.errorCode ? ` ${historyItem.errorCode}` : ""}`),
    },
  };
};

const notePage = (state, { runId, assessment, documentId, tabId } = {}, now) => {
  if (!sameRun(state, runId)) return { ok: false, state, ignored: true };
  const run = {
    ...state.activeRun,
    documentId: documentId || state.activeRun.documentId,
    tabId: tabId || state.activeRun.tabId,
    heartbeatAt: now.toISOString(),
  };
  if (!assessment || assessment.status !== "ready") {
    const code = assessment?.code || "PAGE";
    const message = assessment?.message || "Could not load or verify Naukri profile.";
    let next = { ...state, activeRun: run, connection: { ...state.connection } };
    if (assessment?.status === "awaiting_sign_in" || assessment?.status === "session_expired") {
      next.connection = {
        ...next.connection,
        status: assessment.status,
        verifiedAt: null,
        identityReliable: false,
      };
    }
    if (assessment?.status === "action_required") {
      next.automationSuspended = true;
      next.connection = { ...next.connection, status: "action_required", verifiedAt: null };
    }
    const finished = finishRun(
      next,
      { runId, status: "blocked", errorCode: code, message },
      now,
    );
    return { ...finished, ok: false, code, message: message };
  }
  return { ok: true, state: { ...state, activeRun: { ...run, stage: "ready" } } };
};

const heartbeat = (state, { runId, now }) => {
  if (!state.activeRun || state.activeRun.runId !== runId) return { ok: false, state, ignored: true };
  if (leaseExpired(state.activeRun, now)) {
    return {
      ok: false,
      code: "EXPIRED",
      state: { ...state, activeRun: { ...state.activeRun, revoked: true } },
    };
  }
  return {
    ok: true,
    state: {
      ...state,
      activeRun: { ...state.activeRun, heartbeatAt: now.toISOString() },
    },
  };
};

const setFocus = (state, { runId, focused }) => {
  if (!sameRun(state, runId)) return { ok: false, state, ignored: true };
  return {
    ok: true,
    state: { ...state, activeRun: { ...state.activeRun, pausedForFocus: !focused } },
  };
};

const cancelRun = (state, now = new Date()) => {
  if (!state.activeRun) return { ok: false, state, message: "No active run." };
  const runId = state.activeRun.runId;
  const finished = finishRun(
    { ...state, activeRun: { ...state.activeRun, cancelRequested: true } },
    {
      runId,
      status: "cancelled",
      errorCode: "CANCELLED",
      message: "Run cancelled; completed changes may remain.",
      uncertain: !!state.pendingJournal?.uploadDispatched,
    },
    now,
  );
  return { ...finished, message: "Run cancelled; completed changes may remain." };
};

const onTabRemoved = (state, tabId, now) => {
  if (!state.activeRun || state.activeRun.tabId !== tabId) return { ok: true, state, ignored: true };
  const revoked = { ...state, activeRun: { ...state.activeRun, revoked: true } };
  return finishRun(
    revoked,
    {
      runId: state.activeRun.runId,
      status: "interrupted",
      errorCode: "TAB_CLOSED",
      message: "Run interrupted",
      uncertain: !!state.pendingJournal?.uploadDispatched,
    },
    now,
  );
};

const noteSlotDuringRun = (state, slotKey) => {
  if (!state.activeRun || !slotKey) return state;
  const prev = state.slotRecords[slotKey];
  if (prev && HANDLED_SLOT_STATES.has(prev.state)) return state;
  return {
    ...state,
    slotRecords: {
      ...state.slotRecords,
      [slotKey]: { state: "pending", attempts: prev?.attempts || 0, deferred: true },
    },
  };
};

const fieldPlanFor = (state, step, current, maxLen) => {
  const settings = state.settings;
  const mode = settings.bumpMode === "custom" ? "custom" : "dot";
  const customText = step === "summary" ? settings.customSummaryText : settings.customHeadlineText;
  return planFieldUpdate({
    current,
    mode,
    customText,
    ownedSuffix: ownedSuffix(state, step),
    maxLen,
    field: step,
  });
};

const releaseResume = (state, { runId, revision, step } = {}) => {
  const run = state.activeRun;
  if (!run || run.runId !== runId || run.revoked || run.cancelRequested) {
    return { ok: false, state };
  }
  if (step !== "resume" || run.currentStep !== "resume") return { ok: false, state };
  if (!state.resumeMeta || revision !== state.resumeMeta.revision) return { ok: false, state };
  if (run.resumeRevision !== state.resumeMeta.revision) return { ok: false, state };
  if (state.runtime.resumeReleasedFor === runId) return { ok: false, state };
  return {
    ok: true,
    state: {
      ...state,
      runtime: { ...state.runtime, resumeReleasedFor: runId },
    },
    fileName: run.filename,
  };
};

const classifyFailure = ({ mutationStarted = false, uploadDispatched = false, reason = "" } = {}) => {
  if (uploadDispatched || reason === "timeout_after_write") {
    return { status: "unverified", errorCode: "UPLOAD_UNVERIFIED", message: "cv upload did not stick" };
  }
  if (!mutationStarted) {
    return { status: "failed_retryable", errorCode: "NETWORK", message: "Could not load or verify Naukri profile." };
  }
  if (reason === "save_failed") {
    return { status: "failed_retryable", errorCode: "SAVE_FAILED", message: "field did not save" };
  }
  return { status: "unverified", errorCode: "UNCERTAIN", message: "Profile update needs attention" };
};

const resumeNameIn = (text, filename) => {
  if (!filename || !text) return "";
  const ext = (String(filename).match(/\.[A-Za-z0-9]+$/) || [".pdf"])[0];
  const stem = String(filename).slice(0, -ext.length).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found = new RegExp(`${stem}(?:-\\d+)?\\${ext}`, "i").exec(String(text));
  return found ? found[0] : "";
};

const judgeUpload = ({ before = {}, after = {}, filename } = {}) => {
  const fresh =
    after.freshSignal === true &&
    after.signalId &&
    after.signalId !== before.signalId;
  const beforeName = before.visibleName || resumeNameIn(before.pageText, filename);
  const afterName = after.visibleName || resumeNameIn(after.pageText, filename);
  const nameOk = !!afterName && !!resumeNameIn(afterName, filename);
  const nameChanged = nameOk && beforeName.toLowerCase() !== afterName.toLowerCase();
  const stampChanged =
    !!before.uploadedLine && !!after.uploadedLine && before.uploadedLine !== after.uploadedLine;
  if ((fresh && (nameOk || after.timestampChanged === true)) || nameChanged || stampChanged) {
    return { status: "verified" };
  }
  return { status: "unverified", message: "cv upload did not stick" };
};

/** True when the profile already shows a resume dated today (used only as a soft signal). */
const resumeCurrentToday = (view = {}, _filename, now = new Date()) => {
  const text = `${view.visibleName || ""}\n${view.uploadedLine || ""}\n${view.pageText || ""}`;
  return uploadedToday(text, now);
};

/**
 * After a real file dispatch, accept the same evidence the desktop runner uses:
 * the expected name is on the page, or Uploaded-on is today.
 * judgeUpload stays strict for pre-dispatch compares (R17).
 */
const uploadAccepted = ({ before = {}, after = {}, filename, now = new Date() } = {}) => {
  if (judgeUpload({ before, after, filename }).status === "verified") return true;
  const text = `${after.visibleName || ""}\n${after.uploadedLine || ""}\n${after.pageText || ""}`;
  return !!resumeNameIn(text, filename) || uploadedToday(text, now);
};

const commitSettings = (state, patch, baseRevision, now, timeZone = systemTimeZone()) => {
  if (baseRevision !== state.settings.revision) {
    return {
      ok: false,
      code: "STALE",
      message: "Settings changed in another view. Reload and try again.",
      saveState: "Error",
      state,
    };
  }
  const next = { ...state.settings };
  const schedulePatch = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (key === "revision" || key === "scheduleRevision") continue;
    if (
      key === "scheduleEnabled" ||
      key === "scheduleMode" ||
      key === "customSlots" ||
      key === "intervalAnchor" ||
      key === "pauseDay" ||
      key === "termsAcknowledged" ||
      key === "manualCooldown"
    ) {
      schedulePatch[key] = value;
    } else if (key === "actions" && value && typeof value === "object") {
      next.actions = {
        headline: value.headline !== false,
        summary: value.summary !== false,
        resume: value.resume !== false,
      };
    } else {
      next[key] = value;
    }
  }
  for (const key of ["customHeadlineText", "customSummaryText", "firstName", "lastName", "role", "bumpMode"]) {
    if (next[key] != null && boundString(next[key]) == null) {
      return {
        ok: false,
        code: "INVALID",
        message: "Could not save local extension data.",
        saveState: "Error",
        state,
      };
    }
  }
  if (next.bumpMode !== "dot" && next.bumpMode !== "custom") next.bumpMode = "dot";

  const prevSlots = effectiveSlots(state.settings);
  let slotsChanged = false;
  if (schedulePatch.customSlots !== undefined) {
    try {
      next.customSlots = parseCustomSlots(schedulePatch.customSlots);
      slotsChanged = true;
    } catch (err) {
      return { ok: false, code: "INVALID", message: err.message, saveState: "Error", state };
    }
  }
  if (schedulePatch.intervalAnchor !== undefined) {
    const anchor = normalizeSlot(schedulePatch.intervalAnchor);
    if (!anchor) {
      return {
        ok: false,
        code: "INVALID",
        message: `invalid time slot: ${schedulePatch.intervalAnchor}`,
        saveState: "Error",
        state,
      };
    }
    next.intervalAnchor = anchor;
    slotsChanged = true;
  }
  if (schedulePatch.scheduleMode !== undefined) {
    if (schedulePatch.scheduleMode !== "custom" && schedulePatch.scheduleMode !== "interval") {
      return { ok: false, code: "INVALID", message: "invalid schedule mode", saveState: "Error", state };
    }
    next.scheduleMode = schedulePatch.scheduleMode;
    slotsChanged = true;
  }
  if (schedulePatch.termsAcknowledged !== undefined) {
    next.termsAcknowledged = !!schedulePatch.termsAcknowledged;
  }
  if (schedulePatch.manualCooldown !== undefined) next.manualCooldown = !!schedulePatch.manualCooldown;
  if (schedulePatch.pauseDay !== undefined) next.pauseDay = schedulePatch.pauseDay;

  let warning = null;
  const slots = effectiveSlots(next);
  // No times → schedule off. Adding times turns it back on (even if the box was unchecked).
  // Explicit uncheck with times kept still turns it off.
  if (!slots.length) {
    next.scheduleEnabled = false;
  } else if (schedulePatch.scheduleEnabled === false && !slotsChanged) {
    next.scheduleEnabled = false;
  } else {
    const gate = scheduleGate({ ...next, scheduleEnabled: true }, state);
    if (gate.ok) next.scheduleEnabled = true;
    else {
      next.scheduleEnabled = false;
      if (schedulePatch.scheduleEnabled === true || slotsChanged) warning = gate.message;
    }
  }

  next.revision = state.settings.revision + 1;
  const scheduleTouched =
    slotsChanged ||
    schedulePatch.scheduleEnabled !== undefined ||
    schedulePatch.pauseDay !== undefined ||
    schedulePatch.termsAcknowledged !== undefined ||
    schedulePatch.manualCooldown !== undefined;
  let scheduleRevision = state.scheduleRevision;
  let slotRecords = state.slotRecords;
  if (scheduleTouched) {
    scheduleRevision += 1;
    if (slotsChanged) {
      slotRecords = markPastOnConfig({
        prevSlots,
        nextSlots: effectiveSlots(next),
        records: slotRecords,
        now,
        timeZone,
      });
    }
  }
  const saved = {
    ...state,
    settings: next,
    scheduleRevision,
    slotRecords,
  };
  if (warning) {
    return { ok: false, code: "GATE", message: warning, saveState: "Error", state: saved };
  }
  return { ok: true, saveState: "Saved", state: saved };
};

const pauseToday = (state, now, timeZone = systemTimeZone()) => {
  const parts = localParts(now, timeZone);
  const slots = effectiveSlots(state.settings);
  return {
    ok: true,
    state: {
      ...state,
      settings: { ...state.settings, pauseDay: parts.day, revision: state.settings.revision + 1 },
      scheduleRevision: state.scheduleRevision + 1,
      slotRecords: pauseRemaining(state.slotRecords, slots, parts.day, parts.hhmm),
    },
  };
};

const resumeToday = (state, now, timeZone = systemTimeZone()) => {
  const parts = localParts(now, timeZone);
  const slots = effectiveSlots(state.settings);
  const sameDay = state.settings.pauseDay === parts.day;
  return {
    ok: true,
    state: {
      ...state,
      settings: { ...state.settings, pauseDay: null, revision: state.settings.revision + 1 },
      scheduleRevision: state.scheduleRevision + 1,
      slotRecords: sameDay
        ? resumeFutureToday(state.slotRecords, slots, parts.day, parts.hhmm)
        : state.slotRecords,
    },
  };
};

const clearActivity = (state) => ({ ...state, history: [], logTail: "" });

const resetAll = (state) => {
  if (state.activeRun) {
    return { ok: false, state, message: "Cancel the active run first." };
  }
  return { ok: true, state: defaultState(), clearResume: true, clearAlarms: true };
};

const removeResume = (state) => {
  if (state.activeRun) return { ok: false, state, message: "A run is already in progress." };
  return { ok: true, state: { ...state, resumeMeta: null }, clearResume: true };
};

const disconnectAccount = (state) => {
  if (state.activeRun) return { ok: false, state, message: "Cancel the active run first." };
  return {
    ok: true,
    state: {
      ...state,
      connection: defaultConnection(),
      settings: {
        ...state.settings,
        scheduleEnabled: false,
        accountConfirmed: false,
        revision: state.settings.revision + 1,
      },
      scheduleRevision: state.scheduleRevision + 1,
    },
  };
};

const noteConnection = (state, observed, now) => {
  const at = now.toISOString();
  if (!observed || observed.status !== "ready") {
    const status = observed?.status || "unable_to_verify";
    return {
      ...state,
      automationSuspended: status === "action_required" ? true : state.automationSuspended,
      connection: {
        ...state.connection,
        status,
        verifiedAt: null,
        identityReliable: false,
        accountRef: status === "account_changed" ? state.connection.accountRef : null,
      },
    };
  }
  if (!observed.identityReliable || !observed.accountRef) {
    return {
      ...state,
      connection: {
        status: "connected_last_verified",
        verifiedAt: at,
        identityReliable: false,
        accountRef: null,
      },
    };
  }
  if (state.connection.accountRef && state.connection.accountRef !== observed.accountRef) {
    return {
      ...state,
      reviewRequired: true,
      settings: { ...state.settings, scheduleEnabled: false },
      connection: {
        status: "account_changed",
        verifiedAt: at,
        identityReliable: true,
        accountRef: state.connection.accountRef,
      },
    };
  }
  return {
    ...state,
    connection: {
      status: "connected_last_verified",
      verifiedAt: at,
      identityReliable: true,
      accountRef: observed.accountRef,
    },
  };
};

const resumeAutomation = (state) => ({
  ...state,
  automationSuspended: false,
  connection:
    state.connection.status === "action_required"
      ? { ...state.connection, status: "not_connected", verifiedAt: null }
      : state.connection,
});

const discardJournal = (state) => {
  if (state.activeRun) return { ok: false, state, message: "Cancel the active run first." };
  return {
    ok: true,
    state: { ...state, pendingJournal: null, reviewRequired: false, suffixState: {} },
  };
};

const acceptPdfCandidate = (state, candidate) => {
  if (state.activeRun) {
    return { ok: false, state, message: "A run is already in progress." };
  }
  const screened = screenPdf(candidate);
  if (!screened.ok) {
    return { ok: false, state, message: screened.message, detail: screened.detail };
  }
  const revision = (state.resumeMeta?.revision || 0) + 1;
  const record = {
    name: candidate.name,
    byteLength: candidate.byteLength,
    mime: candidate.mime || "",
    header: candidate.header,
    revision,
    selectedAt: candidate.selectedAt || new Date().toISOString(),
  };
  return { ok: true, state, record, previous: state.resumeMeta };
};

const commitResumeMeta = (state, record) => {
  const fromFile = identityFromResumePath(record?.name || "");
  const settings = { ...state.settings };
  let filled = false;
  for (const key of ["firstName", "lastName", "role"]) {
    if (!String(settings[key] || "").trim() && fromFile[key]) {
      settings[key] = fromFile[key];
      filled = true;
    }
  }
  return {
    ...state,
    resumeMeta: resumeMetaFrom(record),
    settings: filled
      ? { ...settings, revision: state.settings.revision + 1 }
      : state.settings,
  };
};

const applyReconcile = (state, record) => {
  const result = reconcileResume(state.resumeMeta, record);
  return { ...result, state: { ...state, resumeMeta: result.meta } };
};

const pruneState = (state, now, timeZone = systemTimeZone()) => {
  const day = localParts(now, timeZone).day;
  return { ...state, slotRecords: pruneSlotRecords(state.slotRecords, day) };
};

const alarmPlanFor = (state, now, timeZone = systemTimeZone()) =>
  planAlarms({
    enabled: !!state.settings.scheduleEnabled && !state.automationSuspended,
    pauseDay: state.settings.pauseDay,
    slots: effectiveSlots(state.settings),
    records: state.slotRecords,
    now,
    timeZone,
    scheduleRevision: state.scheduleRevision,
    activeRun: state.activeRun,
  });

const rememberAlarms = (state, alarms, now, timeZone) => ({
  ...state,
  runtime: {
    ...state.runtime,
    alarmMeta: alarms,
    lastClockAt: now.toISOString(),
    zoneSignature: zoneSignature(now, timeZone),
  },
});

const decideAlarm = (state, alarmName, now, timeZone = systemTimeZone()) => {
  const meta = (state.runtime.alarmMeta || []).find((row) => row.name === alarmName) || {
    name: alarmName,
  };
  const decision = evaluateAlarm(state, meta, now, timeZone);
  const jump = clockEvent(state.runtime.lastClockAt, now);
  const zoneChanged =
    state.runtime.zoneSignature &&
    state.runtime.zoneSignature !== zoneSignature(now, timeZone);
  return { ...decision, jump, zoneChanged, meta };
};

const catchUpAllowed = (decision) => {
  if (!decision) return false;
  if (decision.type === "fire" || decision.type === "prior_day") return decision.type === "fire";
  if (decision.type === "stale") return false;
  if (decision.zoneChanged || decision.type === "zone_change") return true;
  if (decision.jump === "forward_jump" || decision.jump === "backward_jump") return true;
  if (decision.type === "reconcile" && decision.missingSlotAlarm) return true;
  return false;
};

const progressLabel = (run) => {
  if (!run?.steps?.length) return "";
  const total = run.steps.length || 1;
  const index = Math.max(0, run.steps.indexOf(run.currentStep));
  const step = run.currentStep || run.steps[run.steps.length - 1];
  const label = STEP_LABELS[step] || "Updating profile";
  return `${Math.min(total, index + 1)} of ${total}: ${label}`;
};

const todaySlots = (state, now, timeZone = systemTimeZone()) => {
  const parts = localParts(now, timeZone);
  return effectiveSlots(state.settings).map((slot) => {
    const key = `${parts.day}|${slot}`;
    const record = state.slotRecords[key];
    let status = "scheduled";
    if (record?.state) status = record.state;
    else if (slot <= parts.hhmm) status = "due";
    return { slot, key, status };
  });
};

const publicRun = (run) =>
  run && {
    runId: run.runId,
    trigger: run.trigger,
    slotKey: run.slotKey,
    stage: run.stage,
    currentStep: run.currentStep,
    steps: run.steps,
    stepState: run.stepState,
    startedAt: run.startedAt,
    cancelRequested: !!run.cancelRequested,
    pausedForFocus: !!run.pausedForFocus,
    progress: progressLabel(run),
    filename: run.filename,
    localDay: run.localDay,
  };

const journalSummary = (journal) =>
  journal && {
    runId: journal.runId,
    localDay: journal.localDay,
    uploadDispatched: !!journal.uploadDispatched,
    steps: Object.fromEntries(
      Object.entries(journal.steps || {}).map(([key, value]) => [key, value.status || "intent"]),
    ),
  };

const publicState = (state, now, timeZone = systemTimeZone(), version = "1.0.0") => ({
  version,
  settings: state.settings,
  resumeMeta: state.resumeMeta,
  connection: {
    status: state.connection.status,
    verifiedAt: state.connection.verifiedAt,
    identityReliable: !!state.connection.identityReliable,
    accountBound: !!state.connection.accountRef,
  },
  slotRecords: state.slotRecords,
  activeRun: publicRun(state.activeRun),
  history: state.history,
  logTail: state.logTail,
  lastResult: state.lastResult,
  lastSuccessCheckAt: state.lastSuccessCheckAt,
  lastConfirmedMutationAt: state.lastConfirmedMutationAt,
  reviewRequired: !!state.reviewRequired,
  automationSuspended: !!state.automationSuspended,
  journal: journalSummary(state.pendingJournal),
  scheduleRevision: state.scheduleRevision,
  today: todaySlots(state, now, timeZone),
  timeZone,
  effectiveSlots: effectiveSlots(state.settings),
  nextRun: (() => {
    const next = alarmPlanFor(state, now, timeZone).find(
      (alarm) => alarm.kind === "slot" || alarm.kind === "resume",
    );
    return next ? { slotKey: next.slotKey, when: next.when } : null;
  })(),
});

const runNowDisabled = (state) => {
  if (state.activeRun) return { disabled: true, reason: "A run is already in progress." };
  const reviewed = state.lastResult?.status;
  if (state.reviewRequired && reviewed !== "unverified" && reviewed !== "conflict") {
    return { disabled: true, reason: "Review unresolved update" };
  }
  const config = validateConfig(state, "manual", state.settings.accountConfirmed);
  if (!config.ok) return { disabled: true, reason: config.message };
  return { disabled: false, reason: "" };
};

const chooseTab = (tabs, { preferredWindowId } = {}) => {
  const list = (tabs || []).filter((tab) => tab && !tab.incognito);
  const profile = list.filter((tab) => /\/mnjuser\/profile/.test(tab.url || ""));
  const pool = profile.length ? profile : [];
  if (!pool.length) return { tab: null, windowId: preferredWindowId || list.find((tab) => tab.active)?.windowId || null };
  const preferred = pool.find((tab) => tab.windowId === preferredWindowId);
  return { tab: preferred || pool[0], windowId: (preferred || pool[0]).windowId };
};

const recoverStartup = (state, { now, timeZone = systemTimeZone(), liveRunner = false, observed = {} } = {}) => {
  if (!state.activeRun) {
    if (state.pendingJournal && !state.pendingJournal.resolved) {
      const day = localParts(now, timeZone).day;
      if (state.pendingJournal.localDay !== day) {
        return { state: { ...state, reviewRequired: true }, action: "review" };
      }
    }
    return { state, action: "none" };
  }
  if (liveRunner) return { state, action: "reattach" };
  if (state.pendingJournal?.uploadDispatched) {
    const finished = finishRun(
      { ...state, activeRun: { ...state.activeRun, revoked: true } },
      {
        runId: state.activeRun.runId,
        status: "unverified",
        errorCode: "UPLOAD_UNVERIFIED",
        message: "Upload unverified",
        uncertain: true,
      },
      now,
    );
    return { state: { ...finished.state, reviewRequired: true }, action: "unverified" };
  }
  if (state.pendingJournal && state.activeRun.mutationStarted) {
    const day = localParts(now, timeZone).day;
    const journal = state.pendingJournal;
    const mismatch =
      journal.localDay !== day ||
      journal.settingsRevision !== state.settings.revision ||
      journal.accountRef !== state.connection.accountRef;
    if (mismatch) {
      return {
        state: { ...state, activeRun: null, reviewRequired: true },
        action: "review",
      };
    }
    const step = Object.keys(journal.steps || {}).find((key) => journal.steps[key].status === "intent");
    if (step && observed[step] != null) {
      const row = journal.steps[step];
      const { journalDecision } = require("../../shared/bump");
      const decision = journalDecision({
        current: observed[step],
        before: row.before,
        target: row.target,
      });
      if (decision === "verified") {
        const noted = noteStepResult(state, { runId: state.activeRun.runId, step, status: "verified" });
        return { state: noted.state, action: "recovered" };
      }
      if (decision === "conflict") {
        return { state: { ...state, reviewRequired: true }, action: "review" };
      }
    }
    return { state, action: "retry_same" };
  }
  const finished = finishRun(
    state,
    {
      runId: state.activeRun.runId,
      status: "interrupted",
      errorCode: "INTERRUPTED",
      message: "Run interrupted",
    },
    now,
  );
  return { state: finished.state, action: "cleared" };
};

module.exports = {
  SCHEMA_VERSION,
  STALE_LEASE_MS,
  MAX_RUN_MS,
  COOLDOWN_MS,
  STEP_LABELS,
  defaultState,
  defaultSettings,
  migrate,
  persistable,
  selectedSteps,
  effectiveSlots,
  validateConfig,
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
  noteSlotDuringRun,
  fieldPlanFor,
  releaseResume,
  classifyFailure,
  judgeUpload,
  resumeCurrentToday,
  uploadAccepted,
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
  acceptPdfCandidate,
  commitResumeMeta,
  applyReconcile,
  pruneState,
  alarmPlanFor,
  rememberAlarms,
  decideAlarm,
  catchUpAllowed,
  progressLabel,
  publicState,
  publicRun,
  runNowDisabled,
  todaySlots,
  chooseTab,
  recoverStartup,
  notificationFor,
  ownedSuffix,
  clone,
};
