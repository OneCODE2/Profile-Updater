/** Scheduling plans. Pure: no Chrome alarms, no mutation of inputs. */

const { anchorSlots } = require("./slots");
const {
  localParts,
  addCalendarDays,
  epochFromLocal,
  localTimeExists,
  systemTimeZone,
} = require("./time");

const HANDLED_SLOT_STATES = new Set([
  "success",
  "failed_final",
  "skipped_past_on_config",
  "skipped_coalesced",
  "skipped_overlap",
  "skipped_paused",
  "skipped_cooldown",
]);

const MAX_ATTEMPTS = 2;
const RECONCILE_MS = 15 * 60 * 1000;

const effectiveSlots = (settings) => {
  if (!settings) return [];
  if (settings.scheduleMode === "interval") {
    try {
      return anchorSlots(settings.intervalAnchor || "09:00");
    } catch {
      return [];
    }
  }
  return Array.isArray(settings.customSlots) ? [...settings.customSlots] : [];
};

const isHandled = (record) =>
  !!record && HANDLED_SLOT_STATES.has(record.state);

const eligibleRecord = (record) => {
  if (!record) return true;
  if (isHandled(record)) return false;
  if ((record.attempts || 0) >= MAX_ATTEMPTS) return false;
  if (record.state === "unverified") return false;
  if (record.state === "running") return false;
  return true;
};

/**
 * Latest eligible same-day slot, plus earlier missed keys.
 * Does not mutate `records`. Earlier keys are marked by the caller only after a mutation starts.
 */
const catchUpPlan = ({
  now,
  timeZone = systemTimeZone(),
  effectiveSlots: slots = [],
  enabled = false,
  records = {},
  pauseDay = null,
  activeRun = null,
} = {}) => {
  const parts = localParts(now, timeZone);
  const base = { day: parts.day, hhmm: parts.hhmm, earlierMissed: [], selected: null };
  if (!enabled) return { ...base, reason: "disabled" };
  if (pauseDay && pauseDay === parts.day) return { ...base, reason: "paused" };

  const due = [];
  for (const slot of slots) {
    if (slot > parts.hhmm) continue;
    const key = `${parts.day}|${slot}`;
    const record = records[key];
    if (!eligibleRecord(record)) continue;
    due.push({ slot, key, attempts: record?.attempts || 0 });
  }
  due.sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
  if (!due.length) return { ...base, reason: "none" };
  const selected = due[due.length - 1];
  const earlierMissed = due.slice(0, -1).map((row) => row.key);
  if (activeRun) {
    return {
      ...base,
      selected: null,
      deferred: selected.key,
      earlierMissed: [],
      reason: "active_run",
    };
  }
  return {
    ...base,
    selected: selected.key,
    earlierMissed,
    reason: "eligible",
  };
};

/**
 * Newly added slots at or before the current minute are skipped for today.
 * Existing records, including handled ones, are kept. Unchanged slots are not rewritten.
 */
const markPastOnConfig = ({
  prevSlots = [],
  nextSlots = [],
  records = {},
  now,
  timeZone = systemTimeZone(),
} = {}) => {
  const parts = localParts(now, timeZone);
  const prev = new Set(prevSlots);
  const next = { ...records };
  for (const slot of nextSlots) {
    if (prev.has(slot)) continue;
    const key = `${parts.day}|${slot}`;
    if (next[key]) continue;
    if (slot <= parts.hhmm) {
      next[key] = { state: "skipped_past_on_config", attempts: 0 };
    }
  }
  return next;
};

const pruneSlotRecords = (records = {}, today, keepDays = 14) => {
  const cutoff = addCalendarDays(today, -(keepDays - 1));
  const out = {};
  for (const [key, value] of Object.entries(records)) {
    const day = String(key).split("|")[0];
    if (day >= cutoff) out[key] = value;
  }
  return out;
};

const nextFutureSlot = (slots, records, now, timeZone) => {
  const parts = localParts(now, timeZone);
  const sorted = [...slots].sort();
  for (const slot of sorted) {
    if (slot <= parts.hhmm) continue;
    if (!localTimeExists(parts.day, slot, timeZone)) continue;
    const key = `${parts.day}|${slot}`;
    if (isHandled(records[key])) continue;
    return { slotKey: key, when: epochFromLocal(parts.day, slot, timeZone) };
  }
  if (!sorted.length) return null;
  const tomorrow = addCalendarDays(parts.day, 1);
  const slot = sorted[0];
  if (!localTimeExists(tomorrow, slot, timeZone)) return null;
  return {
    slotKey: `${tomorrow}|${slot}`,
    when: epochFromLocal(tomorrow, slot, timeZone),
  };
};

const planAlarms = ({
  enabled = false,
  pauseDay = null,
  slots = [],
  records = {},
  now,
  timeZone = systemTimeZone(),
  scheduleRevision = 0,
  activeRun = null,
} = {}) => {
  const alarms = [];
  const parts = localParts(now, timeZone);
  if (activeRun && !activeRun.revoked) {
    const beat = Date.parse(activeRun.heartbeatAt || activeRun.startedAt || now.toISOString());
    alarms.push({
      name: "npu:watchdog",
      when: beat + 30000,
      kind: "watchdog",
      scheduleRevision,
      timeZone,
      runId: activeRun.runId,
    });
  }
  if (!enabled) return alarms;
  if (pauseDay === parts.day) {
    const tomorrow = addCalendarDays(parts.day, 1);
    alarms.push({
      name: "npu:slot:next",
      when: epochFromLocal(tomorrow, "00:01", timeZone),
      kind: "resume",
      slotKey: `${tomorrow}|00:01`,
      scheduleRevision,
      timeZone,
    });
    return alarms;
  }
  const next = nextFutureSlot(slots, records, now, timeZone);
  if (next) {
    alarms.push({
      name: "npu:slot:next",
      when: next.when,
      kind: "slot",
      slotKey: next.slotKey,
      scheduleRevision,
      timeZone,
    });
  }
  alarms.push({
    name: "npu:reconcile",
    when: now.getTime() + RECONCILE_MS,
    periodInMinutes: 15,
    kind: "reconcile",
    scheduleRevision,
    timeZone,
  });
  return alarms;
};

const evaluateAlarm = (state, alarm, now, timeZone = systemTimeZone()) => {
  const meta = alarm || {};
  const name = meta.name || "";
  if (name && !name.startsWith("npu:")) return { type: "foreign" };
  if (name === "npu:watchdog") return { type: "watchdog" };
  if (
    meta.scheduleRevision != null &&
    meta.scheduleRevision !== state.scheduleRevision
  ) {
    return { type: "stale" };
  }
  if (meta.timeZone && meta.timeZone !== timeZone) return { type: "zone_change" };
  const today = localParts(now, timeZone).day;
  if (meta.slotKey) {
    const day = meta.slotKey.split("|")[0];
    if (day < today) return { type: "prior_day" };
  }
  if (name === "npu:reconcile" || meta.kind === "reconcile") return { type: "reconcile" };
  if (meta.kind === "resume") return { type: "resume" };
  return { type: "fire", slotKey: meta.slotKey || null };
};

/** steady | forward_jump | backward_jump */
const clockEvent = (previousIso, now) => {
  if (!previousIso) return "unknown";
  const delta = now.getTime() - Date.parse(previousIso);
  if (Number.isNaN(delta)) return "unknown";
  if (delta > 20 * 60 * 1000) return "forward_jump";
  if (delta < -60 * 1000) return "backward_jump";
  return "steady";
};

const pauseRemaining = (records, slots, day, hhmm) => {
  const next = { ...records };
  for (const slot of slots) {
    const key = `${day}|${slot}`;
    if (isHandled(next[key])) continue;
    next[key] = {
      state: "skipped_paused",
      attempts: next[key]?.attempts || 0,
    };
  }
  return next;
};

const resumeFutureToday = (records, slots, day, hhmm) => {
  const next = { ...records };
  for (const slot of slots) {
    const key = `${day}|${slot}`;
    if (next[key]?.state === "skipped_paused" && slot > hhmm) delete next[key];
  }
  return next;
};

module.exports = {
  HANDLED_SLOT_STATES,
  MAX_ATTEMPTS,
  RECONCILE_MS,
  effectiveSlots,
  isHandled,
  catchUpPlan,
  markPastOnConfig,
  pruneSlotRecords,
  planAlarms,
  evaluateAlarm,
  clockEvent,
  pauseRemaining,
  resumeFutureToday,
  nextFutureSlot,
};
