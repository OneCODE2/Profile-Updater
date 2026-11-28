const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { parseCustomSlots, anchorSlots, slotsEveryHours } = require("../shared/slots");
const { localTimeExists, epochFromLocal, systemTimeZone, addCalendarDays } = require("../shared/time");
const {
  catchUpPlan,
  markPastOnConfig,
  planAlarms,
  pruneSlotRecords,
  effectiveSlots,
} = require("../shared/schedule");
const {
  defaultState,
  prepareRun,
  commitMutation,
  finishRun,
  commitSettings,
  pauseToday,
  resumeToday,
  startupPlan,
  decideAlarm,
  catchUpAllowed,
  noteSlotDuringRun,
  persistable,
} = require("../extension/src/engine");
const { createApp } = require("../extension/src/app");

const zone = systemTimeZone();
const at = (y, m, d, h, min, sec = 0) => new Date(y, m - 1, d, h, min, sec);

const ready = (extra = {}) => {
  const state = defaultState();
  state.settings.termsAcknowledged = true;
  state.settings.scheduleEnabled = true;
  state.settings.accountConfirmed = true;
  state.settings.actions = { headline: true, summary: false, resume: false };
  state.settings.customSlots = ["09:00", "13:00", "17:00", "21:00"];
  state.connection = {
    status: "connected_last_verified",
    identityReliable: true,
    accountRef: "acct-1",
    verifiedAt: "2026-11-28T00:00:00.000Z",
  };
  return { ...state, ...extra, settings: { ...state.settings, ...(extra.settings || {}) }, connection: { ...state.connection, ...(extra.connection || {}) } };
};

describe("extension schedule", () => {
  it("S01 desktop bump and filename helpers stay on the old import path", () => {
    const helpers = require("../electron/naukri-helpers");
    const names = require("../electron/resume-name");
    assert.equal(helpers.nextHeadline("Role"), "Role.");
    assert.equal(
      names.buildResumeFileName(
        { firstName: "Ada", lastName: "Lovelace", role: "Software Engineer" },
        new Date(2026, 10, 23),
      ),
      "Ada_Lovelace_Software_Engineer_Resume_23-11-2026.pdf",
    );
  });

  it("S02 rejects invalid and duplicate custom slots and sorts valid ones", () => {
    assert.deepEqual(parseCustomSlots(["14:00", "09:05", "11:00"]), ["09:05", "11:00", "14:00"]);
    assert.throws(() => parseCustomSlots(["09:00", "9:00"]), /duplicate/);
    assert.throws(() => parseCustomSlots(["25:00"]), /invalid/);
    assert.throws(() => parseCustomSlots(["09:00", "10:00", "11:00", "12:00", "13:00"]), /4/);
  });

  it("S03 four-hour anchor does not wrap past midnight", () => {
    assert.deepEqual(anchorSlots("09:00"), ["09:00", "13:00", "17:00", "21:00"]);
    assert.deepEqual(anchorSlots("15:00"), ["15:00", "19:00", "23:00"]);
    assert.deepEqual(anchorSlots("23:59"), ["23:59"]);
    assert.deepEqual(slotsEveryHours("20:00", 4), ["00:00", "04:00", "08:00", "20:00"]);
  });

  it("S04 a slot added at the current minute is skipped today", () => {
    const now = at(2026, 11, 28, 14, 30, 20);
    const records = markPastOnConfig({
      prevSlots: [],
      nextSlots: ["14:30", "16:00"],
      records: {},
      now,
      timeZone: zone,
    });
    assert.equal(records["2026-11-28|14:30"].state, "skipped_past_on_config");
    assert.equal(records["2026-11-28|16:00"], undefined);
    const plan = catchUpPlan({
      now,
      timeZone: zone,
      effectiveSlots: ["14:30", "16:00"],
      enabled: true,
      records,
    });
    assert.equal(plan.selected, null);
  });

  it("S05 unrelated text edits do not suppress a due slot", () => {
    const now = at(2026, 11, 28, 10, 0, 0);
    const state = ready();
    state.slotRecords["2026-11-28|09:00"] = { state: "failed_retryable", attempts: 1 };
    const saved = commitSettings(state, { customHeadlineText: "hello" }, state.settings.revision, now, zone);
    assert.equal(saved.ok, true);
    assert.equal(saved.state.slotRecords["2026-11-28|09:00"].state, "failed_retryable");
    assert.equal(saved.state.scheduleRevision, state.scheduleRevision);
  });

  it("S06 re-adding a handled slot does not clear it or schedule another run", () => {
    const now = at(2026, 11, 28, 12, 0, 0);
    const state = ready();
    state.slotRecords["2026-11-28|09:00"] = { state: "success", attempts: 1 };
    const saved = commitSettings(
      { ...state, settings: { ...state.settings, customSlots: [] } },
      { customSlots: ["09:00"] },
      state.settings.revision,
      now,
      zone,
    );
    assert.equal(saved.state.slotRecords["2026-11-28|09:00"].state, "success");
    const plan = catchUpPlan({
      now,
      timeZone: zone,
      effectiveSlots: ["09:00"],
      enabled: true,
      records: saved.state.slotRecords,
    });
    assert.equal(plan.selected, null);
  });

  it("S07 startup before the first slot arms the next alarm and does not catch up", () => {
    const now = at(2026, 11, 28, 8, 0, 0);
    const state = ready();
    const plan = startupPlan(state, now, zone);
    assert.equal(plan.selected, null);
    const alarms = planAlarms({
      enabled: true,
      slots: effectiveSlots(state.settings),
      records: {},
      now,
      timeZone: zone,
      scheduleRevision: 1,
    });
    assert.equal(alarms.find((alarm) => alarm.kind === "slot").slotKey, "2026-11-28|09:00");
  });

  it("S08 startup after one missed slot selects that slot", () => {
    const now = at(2026, 11, 28, 10, 0, 0);
    const plan = startupPlan(ready(), now, zone);
    assert.equal(plan.selected, "2026-11-28|09:00");
    assert.deepEqual(plan.earlierMissed, []);
  });

  it("S09 multiple missed slots select only the latest until mutation starts", () => {
    const now = at(2026, 11, 28, 18, 0, 0);
    const state = ready();
    const plan = startupPlan(state, now, zone);
    assert.equal(plan.selected, "2026-11-28|17:00");
    assert.deepEqual(plan.earlierMissed, ["2026-11-28|09:00", "2026-11-28|13:00"]);
    assert.equal(state.slotRecords["2026-11-28|09:00"], undefined);
    const started = prepareRun(state, {
      trigger: "catch_up",
      now,
      timeZone: zone,
      slotKey: plan.selected,
      earlierMissed: plan.earlierMissed,
    });
    assert.equal(started.state.slotRecords["2026-11-28|09:00"], undefined);
    const committed = commitMutation(started.state, now);
    assert.equal(committed.state.slotRecords["2026-11-28|09:00"].state, "skipped_coalesced");
    assert.equal(committed.state.slotRecords["2026-11-28|13:00"].state, "skipped_coalesced");
    assert.equal(committed.state.slotRecords[plan.selected].attempts, 1);
  });

  it("S10 a multi-day gap does not catch up a prior day", () => {
    const now = at(2026, 11, 28, 12, 0, 0);
    const records = { "2026-11-25|09:00": { state: "pending", attempts: 0 } };
    const plan = catchUpPlan({
      now,
      timeZone: zone,
      effectiveSlots: ["09:00"],
      enabled: true,
      records,
    });
    assert.equal(plan.selected, "2026-11-28|09:00");
    assert.equal(records["2026-11-25|09:00"].state, "pending");
  });

  it("S11 wake after several slots coalesces one and keeps tomorrow's first time", () => {
    const now = at(2026, 11, 28, 22, 0, 0);
    const state = ready();
    const plan = startupPlan(state, now, zone);
    const committed = commitMutation(
      prepareRun(state, {
        trigger: "catch_up",
        now,
        timeZone: zone,
        slotKey: plan.selected,
        earlierMissed: plan.earlierMissed,
      }).state,
      now,
    );
    const done = finishRun(committed.state, { runId: committed.state.activeRun.runId, status: "success", mutated: true }, now);
    const alarms = planAlarms({
      enabled: true,
      slots: effectiveSlots(state.settings),
      records: done.state.slotRecords,
      now,
      timeZone: zone,
      scheduleRevision: state.scheduleRevision,
    });
    assert.equal(alarms.find((alarm) => alarm.kind === "slot").slotKey, "2026-11-29|09:00");
  });

  it("S12 a late alarm after midnight does not run the prior day", () => {
    const now = at(2026, 11, 28, 0, 10, 0);
    const state = ready();
    state.runtime.alarmMeta = [
      {
        name: "npu:slot:next",
        kind: "slot",
        slotKey: "2026-11-27|21:00",
        scheduleRevision: state.scheduleRevision,
        timeZone: zone,
      },
    ];
    const decision = decideAlarm(state, "npu:slot:next", now, zone);
    assert.equal(decision.type, "prior_day");
    assert.equal(catchUpAllowed(decision), false);
  });

  it("S13 a stale alarm after a schedule edit does not run", () => {
    const now = at(2026, 11, 28, 10, 0, 0);
    const state = ready();
    state.runtime.alarmMeta = [
      {
        name: "npu:slot:next",
        kind: "slot",
        slotKey: "2026-11-28|09:00",
        scheduleRevision: state.scheduleRevision - 1,
        timeZone: zone,
      },
    ];
    const decision = decideAlarm(state, "npu:slot:next", now, zone);
    assert.equal(decision.type, "stale");
    assert.equal(catchUpAllowed(decision), false);
  });

  it("S14 DST gap, fold, and zone change do not double-fire", () => {
    assert.equal(localTimeExists("2026-03-08", "02:30", "America/New_York"), false);
    assert.equal(localTimeExists("2026-03-08", "03:30", "America/New_York"), true);
    const gapNow = new Date(epochFromLocal("2026-03-08", "03:30", "America/New_York"));
    const gap = catchUpPlan({
      now: gapNow,
      timeZone: "America/New_York",
      effectiveSlots: ["02:30", "03:30"],
      enabled: true,
      records: {},
    });
    assert.equal(gap.selected, "2026-03-08|03:30");
    assert.deepEqual(gap.earlierMissed, ["2026-03-08|02:30"]);
    const foldKey = "2026-11-01|01:30";
    const foldNow = new Date(epochFromLocal("2026-11-01", "01:30", "America/New_York") + 60 * 60 * 1000);
    const fold = catchUpPlan({
      now: foldNow,
      timeZone: "America/New_York",
      effectiveSlots: ["01:30"],
      enabled: true,
      records: { [foldKey]: { state: "success", attempts: 1 } },
    });
    assert.equal(fold.selected, null);
    const state = ready();
    state.runtime.zoneSignature = "UTC|GMT";
    state.runtime.alarmMeta = [
      { name: "npu:reconcile", kind: "reconcile", scheduleRevision: state.scheduleRevision, timeZone: "UTC" },
    ];
    const decision = decideAlarm(state, "npu:reconcile", at(2026, 11, 28, 10, 0), zone);
    assert.equal(decision.type === "zone_change" || decision.zoneChanged, true);
  });

  it("S15 clock jumps do not repeat a handled local slot", () => {
    const now = at(2026, 11, 28, 18, 0, 0);
    const state = ready();
    state.slotRecords["2026-11-28|17:00"] = { state: "success", attempts: 1 };
    state.runtime.lastClockAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    const back = decideAlarm(state, "npu:reconcile", now, zone);
    assert.equal(back.jump, "backward_jump");
    const plan = catchUpPlan({
      now,
      timeZone: zone,
      effectiveSlots: effectiveSlots(state.settings),
      enabled: true,
      records: state.slotRecords,
    });
    assert.notEqual(plan.selected, "2026-11-28|17:00");
    state.runtime.lastClockAt = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString();
    assert.equal(decideAlarm(state, "npu:reconcile", now, zone).jump, "forward_jump");
  });

  it("S16 two starts serialize to one run", async () => {
    const seed = ready({ settings: { scheduleEnabled: false } });
    const storage = persistable(seed);
    const platform = fakePlatform(storage);
    const app = createApp(platform);
    const sender = { context: "extension_page", id: "ext" };
    const [first, second] = await Promise.all([
      app.onMessage({ type: "RUN_NOW" }, sender),
      app.onMessage({ type: "RUN_NOW" }, sender),
    ]);
    const oks = [first, second].filter((row) => row.ok);
    const denied = [first, second].filter((row) => !row.ok);
    assert.equal(oks.length, 1);
    assert.match(denied[0].message, /already in progress/i);
    assert.ok(app.snapshot().activeRun);
  });

  it("S17 a slot that arrives during a run is not started beside it", () => {
    const now = at(2026, 11, 28, 9, 5, 0);
    const started = prepareRun(ready(), {
      trigger: "scheduled",
      now,
      timeZone: zone,
      slotKey: "2026-11-28|09:00",
    });
    const pending = noteSlotDuringRun(started.state, "2026-11-28|13:00");
    const again = prepareRun(pending, { trigger: "scheduled", now, timeZone: zone, slotKey: "2026-11-28|13:00" });
    assert.equal(again.ok, false);
    assert.match(again.message, /already in progress/i);
    const done = finishRun(
      commitMutation(pending, now).state,
      { status: "success", mutated: true, runId: pending.activeRun.runId },
      now,
    );
    assert.equal(done.state.slotRecords["2026-11-28|13:00"].state, "skipped_overlap");
    assert.equal(done.state.activeRun, null);
  });

  it("S18 a retryable slot gets at most two mutation attempts", () => {
    const now = at(2026, 11, 28, 10, 0, 0);
    let state = ready();
    const runOnce = (attemptNow) => {
      const plan = startupPlan(state, attemptNow, zone);
      const prepared = prepareRun(state, {
        trigger: "catch_up",
        now: attemptNow,
        timeZone: zone,
        slotKey: plan.selected,
        earlierMissed: plan.earlierMissed,
      });
      assert.equal(prepared.ok, true);
      const committed = commitMutation(prepared.state, attemptNow);
      return finishRun(
        committed.state,
        { status: "failed_retryable", errorCode: "SAVE_FAILED", message: "field did not save" },
        attemptNow,
      ).state;
    };
    state = runOnce(now);
    assert.equal(state.slotRecords["2026-11-28|09:00"].attempts, 1);
    state = runOnce(at(2026, 11, 28, 11, 0, 0));
    assert.equal(state.slotRecords["2026-11-28|09:00"].state, "failed_final");
    const third = startupPlan(state, at(2026, 11, 28, 12, 0, 0), zone);
    assert.notEqual(third.selected, "2026-11-28|09:00");
  });

  it("S19 login and missing PDF block catch-up without consuming an attempt", () => {
    const now = at(2026, 11, 28, 10, 0, 0);
    const noPdf = ready({
      settings: { actions: { headline: false, summary: false, resume: true } },
    });
    const plan = startupPlan(noPdf, now, zone);
    const blocked = prepareRun(noPdf, {
      trigger: "catch_up",
      now,
      timeZone: zone,
      slotKey: plan.selected,
      earlierMissed: plan.earlierMissed,
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, "NO_PDF");
    assert.equal(blocked.state.slotRecords[plan.selected], undefined);
    assert.equal(blocked.state.activeRun, null);
    const signedOut = ready({ connection: { status: "session_expired", identityReliable: true, accountRef: "acct-1" } });
    const login = prepareRun(signedOut, {
      trigger: "catch_up",
      now,
      timeZone: zone,
      slotKey: "2026-11-28|09:00",
      earlierMissed: ["2026-11-28|08:00"],
    });
    assert.equal(login.code, "LOGIN");
    assert.equal(login.state.slotRecords["2026-11-28|08:00"], undefined);
  });

  it("S20 disabling the schedule during a run leaves the run and drops future alarms", () => {
    const now = at(2026, 11, 28, 9, 5, 0);
    const started = prepareRun(ready(), {
      trigger: "scheduled",
      now,
      timeZone: zone,
      slotKey: "2026-11-28|09:00",
    });
    const saved = commitSettings(started.state, { scheduleEnabled: false }, started.state.settings.revision, now, zone);
    assert.equal(saved.state.settings.scheduleEnabled, false);
    assert.ok(saved.state.activeRun);
    const alarms = planAlarms({
      enabled: false,
      slots: [],
      now,
      timeZone: zone,
      activeRun: saved.state.activeRun,
      scheduleRevision: saved.state.scheduleRevision,
    });
    assert.equal(alarms.some((alarm) => alarm.kind === "slot"), false);
    assert.equal(alarms.some((alarm) => alarm.kind === "watchdog"), true);
  });

  it("S21 pause today does not catch up those slots tomorrow", () => {
    const now = at(2026, 11, 28, 10, 0, 0);
    const paused = pauseToday(ready(), now, zone);
    assert.equal(paused.state.slotRecords["2026-11-28|17:00"].state, "skipped_paused");
    const tomorrow = at(2026, 11, 29, 10, 0, 0);
    const plan = startupPlan(paused.state, tomorrow, zone);
    assert.equal(plan.selected, "2026-11-29|09:00");
    const resumed = resumeToday(paused.state, now, zone);
    assert.equal(resumed.state.slotRecords["2026-11-28|17:00"], undefined);
    assert.equal(resumed.state.slotRecords["2026-11-28|09:00"].state, "skipped_paused");
  });

  it("S22 a run that crosses midnight keeps its slot and filename date", () => {
    const start = at(2026, 11, 28, 23, 50, 0);
    const end = at(2026, 11, 29, 0, 10, 0);
    const state = ready({
      settings: { actions: { headline: false, summary: false, resume: true } },
      resumeMeta: { originalName: "Ada_Lovelace_Dev.pdf", size: 10, revision: 2, mime: "application/pdf" },
    });
    const prepared = prepareRun(state, {
      trigger: "scheduled",
      now: start,
      timeZone: zone,
      slotKey: "2026-11-28|21:00",
    });
    assert.match(prepared.run.filename, /28-11-2026\.pdf$/);
    const done = finishRun(
      commitMutation(prepared.state, start).state,
      { status: "success", mutated: true },
      end,
    );
    assert.equal(done.state.history[0].slotKey, "2026-11-28|21:00");
    assert.equal(done.state.history[0].startedAt, start.toISOString());
  });

  it("S23 worker activation restores alarms and is not a browser startup", async () => {
    const seed = ready();
    const storage = persistable(seed);
    let clock = at(2026, 11, 28, 8, 0, 0);
    const platform = fakePlatform(storage, () => clock);
    const app = createApp(platform);
    await app.init();
    assert.equal(app.snapshot().activeRun, null);
    assert.ok([...platform._alarms.keys()].some((name) => name.startsWith("npu:")));
    clock = at(2026, 11, 28, 10, 0, 0);
    await app.onStartup();
    assert.equal(app.snapshot().activeRun.slotKey, "2026-11-28|09:00");
    assert.equal(app.snapshot().activeRun.trigger, "catch_up");
  });

  it("S24 slot records prune by local calendar day, including across a DST boundary", () => {
    const records = {
      "2026-02-28|09:00": { state: "success", attempts: 1 },
      "2026-03-01|09:00": { state: "success", attempts: 1 },
      "2026-03-08|09:00": { state: "success", attempts: 1 },
    };
    const pruned = pruneSlotRecords(records, "2026-03-14", 14);
    assert.equal(pruned["2026-02-28|09:00"], undefined);
    assert.ok(pruned["2026-03-01|09:00"]);
    assert.ok(pruned["2026-03-08|09:00"]);
    assert.equal(addCalendarDays("2026-03-08", 13), "2026-03-21");
  });

  it("S25 a manual run does not consume a slot unless cooldown is explicitly on", () => {
    const now = at(2026, 11, 28, 9, 1, 0);
    const state = ready();
    const manual = prepareRun(state, { trigger: "manual", now, timeZone: zone, confirmAccount: true });
    const done = finishRun(commitMutation(manual.state, now).state, { status: "success", mutated: true }, now);
    assert.equal(done.state.slotRecords["2026-11-28|09:00"], undefined);
    const cooled = ready({
      settings: { manualCooldown: true },
      lastConfirmedMutationAt: now.toISOString(),
    });
    const skipped = prepareRun(cooled, {
      trigger: "scheduled",
      now: at(2026, 11, 28, 9, 5, 0),
      timeZone: zone,
      slotKey: "2026-11-28|09:00",
    });
    assert.equal(skipped.state.slotRecords["2026-11-28|09:00"].state, "skipped_cooldown");
  });
});

function fakePlatform(initial, nowFn = () => at(2026, 11, 28, 10, 0, 0)) {
  const alarms = new Map();
  return {
    version: "1.0.0",
    chromeMajor: 148,
    now: nowFn,
    timeZone: zone,
    storage: {
      async getAll() {
        return { ...initial };
      },
      async set(obj) {
        Object.assign(initial, obj);
      },
      async setAccessLevel(opts) {
        this.access = opts.accessLevel;
      },
    },
    alarms: {
      async getAll() {
        return [...alarms.entries()].map(([name, info]) => ({ name, ...info }));
      },
      async clear(name) {
        alarms.delete(name);
      },
      async create(name, info) {
        alarms.set(name, info);
      },
    },
    resume: {
      async get() {
        return this.record || null;
      },
      async put(record) {
        this.record = record;
      },
      async clear() {
        this.record = null;
      },
    },
    notifications: {
      async create() {
        throw new Error("denied");
      },
    },
    async openProfile() {
      return { ok: true, tab: { id: 7, windowId: 1 } };
    },
    _alarms: alarms,
  };
}
