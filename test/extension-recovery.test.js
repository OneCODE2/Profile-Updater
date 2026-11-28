const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { planFieldUpdate, journalDecision } = require("../shared/bump");
const { El, documentFrom } = require("./mini-dom");
const { waitForProfile } = require("../extension/src/dom");
const { runSteps } = require("../extension/src/runner");
const { judgeUpload, classifyFailure } = require("../extension/src/engine");
const {
  defaultState,
  prepareRun,
  commitMutation,
  finishRun,
  noteIntent,
  noteStepResult,
  markUploadDispatched,
  recoverStartup,
  authorizeStep,
  releaseResume,
  onTabRemoved,
  setFocus,
  cancelRun,
  notePage,
  noteConnection,
  fieldPlanFor,
  persistable,
} = require("../extension/src/engine");
const { createApp } = require("../extension/src/app");
const { systemTimeZone } = require("../shared/time");

const zone = systemTimeZone();
const at = (y, m, d, h, min) => new Date(y, m - 1, d, h, min, 0);

const ready = () => {
  const state = defaultState();
  state.settings.accountConfirmed = true;
  state.settings.termsAcknowledged = true;
  state.settings.scheduleEnabled = true;
  state.settings.actions = { headline: true, summary: true, resume: false };
  state.settings.customSlots = ["09:00"];
  state.connection = {
    status: "connected_last_verified",
    identityReliable: true,
    accountRef: "acct-1",
    verifiedAt: "2026-11-28T00:00:00.000Z",
  };
  return state;
};

const profile = ({ headline = "Full stack", summary = "Building reliable software for teams", saves = 1, attach = false, extraEdit = false, wordError = false } = {}) => {
  const headlineField = new El("textarea", { id: "resumeHeadlineTxt", value: headline });
  const summaryField = new El("textarea", { id: "profileSummaryTxt", value: summary });
  const editorKids = [headlineField, summaryField];
  for (let i = 0; i < saves; i++) editorKids.push(new El("button", { text: "Save" }));
  if (wordError) editorKids.push(new El("p", { text: "Minimum 5 words are required" }));
  const editor = new El("div", { class: "editor" }, editorKids);
  const headKids = [new El("span", { class: "edit icon" })];
  const head = new El("div", { id: "lazyResumeHead" }, headKids);
  const summaryEdit = new El("span", { class: "edit icon", "aria-label": "Edit profile summary" });
  const summaryWrap = new El("div", { id: "lazyProfileSummary" }, [summaryEdit]);
  const kids = [head, summaryWrap, editor];
  if (extraEdit) kids.push(new El("span", { class: "edit icon" }));
  if (attach) kids.push(new El("input", { id: "attachCV", type: "file" }));
  const name = new El("span", { "data-resume-name": "", text: "" });
  const signal = new El("span", { "data-upload-signal": "old" });
  kids.push(name, signal);
  const body = new El("body", {}, kids);
  const doc = documentFrom(body);
  doc.nameNode = name;
  doc.signalNode = signal;
  return { doc, headlineField, summaryField, saves: editorKids.filter((el) => el.tagName === "BUTTON") };
};

const bind = (state) => ({
  authorize: async (step) => {
    const result = authorizeStep(state.current, { runId: state.current.activeRun.runId, step });
    if (result.state) state.current = result.state;
    return result;
  },
  intent: async (body) => {
    const result = noteIntent(state.current, { runId: state.current.activeRun.runId, ...body });
    state.current = result.state;
    return result;
  },
  dispatched: async () => {
    const result = markUploadDispatched(state.current, state.current.activeRun.runId);
    if (result.state) state.current = result.state;
    return result;
  },
  resumeFile: async () => ({ ok: true, file: { name: "cv.pdf" } }),
  assignFile(input, file) {
    input.assigned = file;
  },
  stepResult: async (body) => {
    const result = noteStepResult(state.current, { runId: state.current.activeRun.runId, ...body });
    state.current = result.state;
    return result;
  },
});

describe("extension recovery", () => {
  it("R01 dots mode matches the desktop cycle", async () => {
    const { doc, headlineField } = profile();
    const state = { current: prepareRun(ready(), { trigger: "manual", now: at(2026, 11, 28, 10, 0), timeZone: zone }).state };
    const outcome = await runSteps(doc, {
      state: state.current,
      run: state.current.activeRun,
      url: "https://www.naukri.com/mnjuser/profile",
      hooks: bind(state),
    });
    assert.equal(outcome.status, "success");
    assert.equal(headlineField.value, "Full stack.");
    assert.equal(state.current.activeRun.stepState.headline, "verified");
  });

  it("R02 custom suffix does not accumulate and can be replaced", () => {
    const first = planFieldUpdate({ current: "Hello", mode: "custom", customText: "SDE", field: "headline" });
    assert.equal(first.next, "Hello SDE");
    const again = planFieldUpdate({
      current: first.next,
      mode: "custom",
      customText: "SDE",
      ownedSuffix: first.ownedSuffix,
      field: "headline",
    });
    assert.equal(again.status, "no_change");
    const changed = planFieldUpdate({
      current: "Hello SDE",
      mode: "custom",
      customText: "QA",
      ownedSuffix: "SDE",
      field: "headline",
    });
    assert.equal(changed.next, "Hello QA");
    const dots = planFieldUpdate({ current: "Hello SDE", mode: "dot", ownedSuffix: "SDE", field: "headline" });
    assert.equal(dots.next, "Hello.");
  });

  it("R03 an external edit is a conflict and is not stripped", () => {
    const plan = planFieldUpdate({
      current: "Hello completely rewritten",
      mode: "custom",
      customText: "SDE",
      ownedSuffix: "SDE",
    });
    assert.equal(plan.status, "conflict");
    assert.equal(plan.next, undefined);
  });

  it("R04 a word-count error stops before save and later steps", async () => {
    const { doc, saves } = profile({ wordError: true });
    const state = { current: prepareRun(ready(), { trigger: "manual", now: at(2026, 11, 28, 10, 0), timeZone: zone }).state };
    const outcome = await runSteps(doc, {
      state: state.current,
      run: state.current.activeRun,
      url: "https://www.naukri.com/mnjuser/profile",
      hooks: bind(state),
    });
    assert.equal(outcome.errorCode, "WORD_COUNT");
    assert.equal(saves[0].clicked, 0);
    assert.equal(state.current.activeRun.stepState.summary, "pending");
  });

  it("R05 duplicate saves and file inputs fail closed", async () => {
    const { doc, saves } = profile({ saves: 2, extraEdit: true });
    doc.body = doc.body;
    const decoy = new El("input", { type: "file" });
    doc.children[0].append(decoy);
    const state = { current: prepareRun(ready(), { trigger: "manual", now: at(2026, 11, 28, 10, 0), timeZone: zone }).state };
    const outcome = await runSteps(doc, {
      state: state.current,
      run: state.current.activeRun,
      url: "https://www.naukri.com/mnjuser/profile",
      hooks: bind(state),
    });
    assert.equal(outcome.errorCode, "SELECTOR");
    assert.equal(saves.every((button) => button.clicked === 0), true);
    assert.equal(decoy.assigned, undefined);
  });

  it("R06 only selected actions run and text-only needs no PDF", () => {
    const state = ready();
    state.settings.actions = { headline: false, summary: true, resume: false };
    const prepared = prepareRun(state, { trigger: "manual", now: at(2026, 11, 28, 10, 0), timeZone: zone });
    assert.deepEqual(prepared.run.steps, ["summary"]);
    state.settings.actions = { headline: false, summary: false, resume: false };
    const none = prepareRun(state, { trigger: "manual", now: at(2026, 11, 28, 10, 0), timeZone: zone });
    assert.equal(none.code, "NO_ACTION");
  });

  it("R07 empty custom text blocks the run", () => {
    const state = ready();
    state.settings.bumpMode = "custom";
    state.settings.customHeadlineText = "";
    const blocked = prepareRun(state, { trigger: "manual", now: at(2026, 11, 28, 10, 0), timeZone: zone });
    assert.equal(blocked.code, "CUSTOM_EMPTY");
    assert.match(blocked.message, /Resume headline/);
  });

  it("R08 a verified headline is not bumped again when summary fails", () => {
    let state = prepareRun(ready(), { trigger: "manual", now: at(2026, 11, 28, 10, 0), timeZone: zone }).state;
    state = noteIntent(state, { runId: state.activeRun.runId, step: "headline", before: "Full stack", target: "Full stack." }).state;
    state = noteStepResult(state, { runId: state.activeRun.runId, step: "headline", status: "verified", suffix: "." }).state;
    const retry = fieldPlanFor(state, "headline", "Full stack.", undefined);
    assert.equal(retry.status, "no_change");
    assert.equal(journalDecision({ current: "Full stack.", before: "Full stack", target: "Full stack." }), "verified");
  });

  it("R09 a save that landed is recovered without another write", () => {
    let state = prepareRun(ready(), { trigger: "scheduled", now: at(2026, 11, 28, 10, 0), timeZone: zone, slotKey: "2026-11-28|09:00" }).state;
    state = commitMutation(state, at(2026, 11, 28, 10, 0)).state;
    state = noteIntent(state, { runId: state.activeRun.runId, step: "headline", before: "A", target: "A." }).state;
    const recovered = recoverStartup(state, {
      now: at(2026, 11, 28, 10, 5),
      timeZone: zone,
      liveRunner: false,
      observed: { headline: "A." },
    });
    assert.equal(recovered.action, "recovered");
    assert.equal(recovered.state.activeRun.stepState.headline, "verified");
  });

  it("R10 a kill before mutation is not success", () => {
    const prepared = prepareRun(ready(), {
      trigger: "scheduled",
      now: at(2026, 11, 28, 10, 0),
      timeZone: zone,
      slotKey: "2026-11-28|09:00",
    });
    const recovered = recoverStartup(prepared.state, { now: at(2026, 11, 28, 10, 5), timeZone: zone, liveRunner: false });
    assert.equal(recovered.action, "cleared");
    assert.notEqual(recovered.state.lastResult.status, "success");
    assert.equal(recovered.state.slotRecords["2026-11-28|09:00"]?.attempts || 0, 0);
  });

  it("R11 a live runner is reattached instead of replaced", () => {
    const prepared = prepareRun(ready(), { trigger: "manual", now: at(2026, 11, 28, 10, 0), timeZone: zone });
    const recovered = recoverStartup(prepared.state, { now: at(2026, 11, 28, 10, 1), timeZone: zone, liveRunner: true });
    assert.equal(recovered.action, "reattach");
    assert.equal(recovered.state.activeRun.runId, prepared.run.runId);
  });

  it("R12 a journal from another day requires review", () => {
    let state = prepareRun(ready(), {
      trigger: "scheduled",
      now: at(2026, 11, 28, 10, 0),
      timeZone: zone,
      slotKey: "2026-11-28|09:00",
    }).state;
    state = commitMutation(state, at(2026, 11, 28, 10, 0)).state;
    state = noteIntent(state, { runId: state.activeRun.runId, step: "headline", before: "A", target: "A." }).state;
    const nextDay = recoverStartup(state, { now: at(2026, 11, 29, 9, 0), timeZone: zone, liveRunner: false, observed: { headline: "A" } });
    assert.equal(nextDay.action, "review");
    assert.equal(nextDay.state.reviewRequired, true);
  });

  it("R13 a stale final message cannot release the new lock", () => {
    const now = at(2026, 11, 28, 10, 0);
    let state = prepareRun(ready(), { trigger: "manual", now, timeZone: zone, runId: "run-1" }).state;
    const firstId = state.activeRun.runId;
    state = finishRun(state, { status: "success", mutated: true }, now).state;
    state = prepareRun(state, { trigger: "manual", now, timeZone: zone, runId: "run-2" }).state;
    const stale = finishRun(state, { runId: firstId, status: "failed_final" }, now);
    assert.equal(stale.state.activeRun.runId, "run-2");
    assert.equal(stale.duplicate || stale.ignored, true);
  });

  it("R14 a stale lock with a live runner is revoked and not replaced", () => {
    const old = at(2026, 11, 28, 9, 0);
    const now = at(2026, 11, 28, 9, 20);
    const prepared = prepareRun(ready(), { trigger: "manual", now: old, timeZone: zone });
    prepared.state.activeRun.heartbeatAt = old.toISOString();
    prepared.state.activeRun.startedAt = old.toISOString();
    const next = prepareRun(prepared.state, { trigger: "manual", now, timeZone: zone, liveRunner: true });
    assert.equal(next.ok, false);
    assert.equal(next.state.activeRun.revoked, true);
    assert.equal(next.state.activeRun.runId, prepared.run.runId);
  });

  it("R15 closing the profile tab interrupts and keeps a partial journal", () => {
    const now = at(2026, 11, 28, 10, 0);
    let state = prepareRun(ready(), { trigger: "manual", now, timeZone: zone }).state;
    state.activeRun.tabId = 4;
    state = commitMutation(state, now).state;
    state = noteIntent(state, { runId: state.activeRun.runId, step: "headline", before: "A", target: "A." }).state;
    const closed = onTabRemoved(state, 4, now);
    assert.equal(closed.state.lastResult.status, "interrupted");
    assert.equal(closed.state.lastResult.message, "Run interrupted");
    assert.ok(closed.state.pendingJournal);
    assert.equal(closed.state.activeRun, null);
  });

  it("R16 losing focus pauses before the next edit and cancel is a safe boundary", async () => {
    const { doc, headlineField } = profile();
    doc.hasFocus = () => false;
    const holder = { current: prepareRun(ready(), { trigger: "manual", now: at(2026, 11, 28, 10, 0), timeZone: zone }).state };
    const outcome = await runSteps(doc, {
      state: holder.current,
      run: holder.current.activeRun,
      url: "https://www.naukri.com/mnjuser/profile",
      hooks: bind(holder),
    });
    assert.equal(outcome.status, "paused");
    assert.equal(headlineField.value, "Full stack");
    const cancelled = cancelRun(holder.current);
    assert.equal(cancelled.state.activeRun, null);
    assert.equal(cancelled.state.lastResult.status, "cancelled");
  });

  it("R16b cancel blocks the next field write", () => {
    const now = at(2026, 11, 28, 10, 0);
    let state = prepareRun(ready(), { trigger: "manual", now, timeZone: zone }).state;
    state = commitMutation(state, now).state;
    const runId = state.activeRun.runId;
    state = cancelRun(state).state;
    const intent = noteIntent(state, {
      runId,
      step: "headline",
      before: "A",
      target: "A.",
    });
    assert.equal(state.activeRun, null);
    assert.equal(intent.ok, false);
    assert.equal(intent.state.pendingJournal, null);
  });

  it("R16g a cancelled page run can update on the next run", async () => {
    const { requestStop, clearStop } = require("../extension/src/runner");
    const { doc, headlineField } = profile();
    const url = "https://www.naukri.com/mnjuser/profile";
    const run = () => {
      const state = {
        current: prepareRun(ready(), { trigger: "manual", now: at(2026, 11, 28, 10, 0), timeZone: zone }).state,
      };
      return runSteps(doc, { state: state.current, run: state.current.activeRun, url, hooks: bind(state) });
    };
    requestStop();
    try {
      const stopped = await run();
      assert.equal(stopped.status, "cancelled");
      assert.equal(headlineField.value, "Full stack");
      clearStop();
      const outcome = await run();
      assert.equal(outcome.status, "success");
      assert.equal(headlineField.value, "Full stack.");
    } finally {
      clearStop();
    }
  });

  it("R16e a missing headline section is skipped and the summary still updates", async () => {
    const summaryField = new El("textarea", { id: "profileSummaryTxt", value: "Building reliable software for teams" });
    const save = new El("button", { text: "Save" });
    const editor = new El("div", { class: "editor" }, [summaryField, save]);
    const title = new El("span", { text: "Profile summary" });
    const edit = new El("span", { class: "edit icon" });
    const body = new El("body", {}, [new El("div", {}, [title, edit]), editor]);
    const state = {
      current: prepareRun(ready(), { trigger: "manual", now: at(2026, 11, 28, 10, 0), timeZone: zone }).state,
    };
    const outcome = await runSteps(documentFrom(body), {
      state: state.current,
      run: state.current.activeRun,
      url: "https://www.naukri.com/mnjuser/profile",
      hooks: bind(state),
    });
    assert.equal(outcome.status, "success");
    assert.equal(summaryField.value, "Building reliable software for teams.");
    assert.equal(outcome.results.headline, "missing");
  });

  it("R16f an aria-hidden edit icon still counts as the profile control", () => {
    const { assessDocument } = require("../extension/src/dom");
    const edit = new El("span", { class: "edit icon", "aria-hidden": "true" });
    const head = new El("div", { id: "lazyProfileSummary" }, [edit]);
    const body = new El("body", {}, [head]);
    const result = assessDocument(documentFrom(body), "https://www.naukri.com/mnjuser/profile");
    assert.equal(result.status, "ready");
  });

  it("R16d a profile summary heading is enough when the old headline id is gone", () => {
    const { assessDocument } = require("../extension/src/dom");
    const title = new El("span", { text: "Profile summary" });
    const edit = new El("span", { class: "edit icon" });
    const body = new El("body", {}, [new El("div", {}, [title, edit])]);
    const result = assessDocument(documentFrom(body), "https://www.naukri.com/mnjuser/profile");
    assert.equal(result.status, "ready");
  });

  it("R16c a loaded profile editor is accepted without waiting out the timeout", async () => {
    const { doc } = profile();
    const result = await waitForProfile(doc, "https://www.naukri.com/mnjuser/profile", 1000);
    assert.equal(result.status, "ready");
  });

  it("R17 the same filename and upload date do not prove a second upload", () => {
    const before = { signalId: "1", visibleName: "Ada_Lovelace_Dev_Resume_28-11-2026.pdf" };
    const after = {
      signalId: "1",
      visibleName: before.visibleName,
      freshSignal: false,
      text: "Uploaded on Nov 28, 2026",
    };
    assert.equal(judgeUpload({ before, after, filename: before.visibleName }).status, "unverified");
  });

  it("R18 a dispatched upload with no fresh result stays unverified", () => {
    const now = at(2026, 11, 28, 10, 0);
    let state = prepareRun(ready(), { trigger: "manual", now, timeZone: zone }).state;
    state = commitMutation(state, now).state;
    state = noteIntent(state, { runId: state.activeRun.runId, step: "resume", before: "", target: "a.pdf", upload: true }).state;
    state = markUploadDispatched(state, state.activeRun.runId).state;
    const recovered = recoverStartup(state, { now, timeZone: zone, liveRunner: false });
    assert.equal(recovered.action, "unverified");
    assert.equal(recovered.state.reviewRequired, true);
    assert.notEqual(recovered.state.lastResult.status, "success");
  });

  it("R19 a fresh confirmation and the persisted name verify the upload", () => {
    const judged = judgeUpload({
      before: { signalId: "1" },
      after: { signalId: "2", freshSignal: true, visibleName: "Ada.pdf", timestampChanged: true },
      filename: "Ada.pdf",
    });
    assert.equal(judged.status, "verified");
    const appeared = judgeUpload({
      before: { visibleName: "", uploadedLine: "Uploaded on Nov 27, 2026" },
      after: { visibleName: "Ada.pdf", uploadedLine: "Uploaded on Nov 28, 2026" },
      filename: "Ada.pdf",
    });
    assert.equal(appeared.status, "verified");
  });

  it("R20 timeout before a mutation is retryable and after a write is uncertain", () => {
    assert.equal(classifyFailure({ mutationStarted: false, reason: "timeout" }).status, "failed_retryable");
    assert.equal(classifyFailure({ mutationStarted: true, uploadDispatched: true }).status, "unverified");
  });

  it("R21 an account change stops the run before a PDF release", () => {
    const now = at(2026, 11, 28, 10, 0);
    let state = prepareRun(ready(), { trigger: "manual", now, timeZone: zone }).state;
    state = notePage(
      state,
      { runId: state.activeRun.runId, assessment: { status: "session_expired", code: "LOGIN", message: "Sign in to Naukri in this Chrome" } },
      now,
    ).state;
    const released = releaseResume(state, { runId: "gone", revision: 1, step: "resume" });
    assert.equal(released.ok, false);
    assert.equal(state.connection.status, "session_expired");
  });

  it("R22 a challenge suspends automatic runs", () => {
    const now = at(2026, 11, 28, 10, 0);
    let state = noteConnection(ready(), { status: "action_required" }, now);
    const blocked = prepareRun(state, {
      trigger: "scheduled",
      now,
      timeZone: zone,
      slotKey: "2026-11-28|09:00",
    });
    assert.equal(blocked.code, "ACTION_REQUIRED");
    assert.equal(blocked.state.slotRecords["2026-11-28|09:00"], undefined);
  });

  it("R23 a notification failure does not fail a verified update", async () => {
    const seed = ready();
    const storage = persistable(seed);
    const notifications = { calls: 0, async create() { this.calls += 1; throw new Error("denied"); } };
    const platform = {
      version: "1.0.0",
      chromeMajor: 148,
      now: () => at(2026, 11, 28, 10, 0),
      timeZone: zone,
      storage: {
        async getAll() { return { ...storage }; },
        async set(obj) { Object.assign(storage, obj); },
        async setAccessLevel() {},
      },
      alarms: { async getAll() { return []; }, async clear() {}, async create() {} },
      resume: { async get() { return null; } },
      notifications,
      async openProfile() { return { ok: true, tab: { id: 7, windowId: 1 } }; },
    };
    const app = createApp(platform);
    await app.onStartup();
    assert.equal(app.snapshot().activeRun.trigger, "catch_up");
    const finished = await app.onMessage(
      {
        type: "RUN_FINISH",
        runId: app.snapshot().activeRun.runId,
        status: "success",
        mutated: true,
        message: "Profile update completed",
      },
      { tab: { id: 7 }, frameId: 0, url: "https://www.naukri.com/mnjuser/profile", id: "ext" },
    );
    assert.equal(finished.ok, true);
    assert.equal(app.snapshot().lastResult.status, "success");
    assert.equal(notifications.calls, 1);
  });

  it("R24 finishing the same run twice stores one history row", () => {
    const now = at(2026, 11, 28, 10, 0);
    const prepared = prepareRun(ready(), { trigger: "manual", now, timeZone: zone, runId: "same" });
    const first = finishRun(commitMutation(prepared.state, now).state, { status: "success", mutated: true }, now);
    const second = finishRun(first.state, { runId: "same", status: "success", mutated: true }, now);
    assert.equal(second.duplicate, true);
    assert.equal(first.state.history.length, 1);
  });

  it("R25 an already-current field is a no-change, not a refresh", () => {
    const plan = planFieldUpdate({ current: "Hello SDE", mode: "custom", customText: "SDE" });
    assert.equal(plan.status, "no_change");
    const now = at(2026, 11, 28, 10, 0);
    const prepared = prepareRun(ready(), { trigger: "manual", now, timeZone: zone });
    const done = finishRun(prepared.state, { status: "no_changes", mutated: false, message: "No changes needed" }, now);
    assert.equal(done.state.lastResult.status, "no_changes");
    assert.equal(done.state.lastConfirmedMutationAt, null);
    assert.ok(done.state.lastSuccessCheckAt);
  });

  it("R16 focus flag is stored for the active run", () => {
    const prepared = prepareRun(ready(), { trigger: "manual", now: at(2026, 11, 28, 10, 0), timeZone: zone });
    const paused = setFocus(prepared.state, { runId: prepared.run.runId, focused: false });
    assert.equal(paused.state.activeRun.pausedForFocus, true);
    const auth = authorizeStep(paused.state, { runId: prepared.run.runId, step: "headline" });
    assert.equal(auth.ok, false);
  });
});
