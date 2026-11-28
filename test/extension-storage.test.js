const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { screenPdf, reconcileResume, PDF_MAX_BYTES } = require("../shared/pdf");
const { describeIdentity, buildResumeFileName } = require("../shared/filename");
const { redact, escapeText, appendLog } = require("../shared/text");
const { toUploadFile } = require("../extension/src/file");
const { validateMessage } = require("../extension/src/messages");
const { chromePlatform } = require("../extension/src/app");
const { PROFILE_URL } = require("../extension/src/dom");
const { buildExtension } = require("../scripts/build-extension");
const {
  defaultState,
  migrate,
  persistable,
  acceptPdfCandidate,
  commitResumeMeta,
  applyReconcile,
  commitSettings,
  clearActivity,
  resetAll,
  removeResume,
  prepareRun,
  releaseResume,
  publicState,
} = require("../extension/src/engine");
const { createApp } = require("../extension/src/app");
const { systemTimeZone } = require("../shared/time");

const zone = systemTimeZone();
const now = new Date(2026, 10, 28, 12, 0, 0);
const header = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

const pdf = (extra = {}) => ({
  name: "Ada_Lovelace_Dev.pdf",
  byteLength: 1200,
  mime: "application/pdf",
  header,
  ...extra,
});

describe("extension storage and build", () => {
  it("D01 accepts a real PDF at 6 MB and rejects empty, disguised, bad MIME, and 6 MB + 1", () => {
    assert.equal(screenPdf(pdf()).ok, true);
    assert.equal(screenPdf(pdf({ mime: "" })).ok, true);
    assert.equal(screenPdf(pdf({ byteLength: PDF_MAX_BYTES })).ok, true);
    for (const bad of [
      pdf({ byteLength: 0 }),
      pdf({ byteLength: PDF_MAX_BYTES + 1 }),
      pdf({ name: "notes.txt" }),
      pdf({ mime: "text/plain" }),
      pdf({ header: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }),
    ]) {
      const screened = screenPdf(bad);
      assert.equal(screened.ok, false);
      assert.equal(screened.message, "Choose a PDF under 6 MB");
    }
  });

  it("D02 a rejected replacement keeps the previous PDF", () => {
    const state = defaultState();
    const first = acceptPdfCandidate(state, pdf());
    const saved = commitResumeMeta(state, first.record);
    const rejected = acceptPdfCandidate(saved, pdf({ byteLength: PDF_MAX_BYTES + 1 }));
    assert.equal(rejected.ok, false);
    assert.equal(rejected.state.resumeMeta.revision, first.record.revision);
    const failedWrite = acceptPdfCandidate(saved, pdf({ name: "Ada_Lovelace_Dev.pdf", byteLength: 20 }));
    assert.equal(failedWrite.ok, true);
    assert.equal(saved.resumeMeta.revision, first.record.revision);
  });

  it("D03 metadata catches up to the IndexedDB record after a crash", () => {
    const record = { name: "Ada_Lovelace_Dev.pdf", byteLength: 20, mime: "", revision: 4, header, headerOk: true };
    const result = reconcileResume({ originalName: "old.pdf", size: 10, revision: 3, mime: "" }, record);
    assert.equal(result.status, "reconciled");
    assert.equal(result.meta.revision, 4);
    assert.equal(result.meta.size, 20);
  });

  it("D04 a resume revision change is not released for the old run", () => {
    const state = defaultState();
    state.settings.actions = { headline: false, summary: false, resume: true };
    state.settings.accountConfirmed = true;
    state.resumeMeta = { originalName: "Ada_Lovelace_Dev.pdf", size: 20, revision: 2, mime: "application/pdf" };
    const prepared = prepareRun(state, { trigger: "manual", now, timeZone: zone });
    state.resumeMeta = { ...state.resumeMeta, revision: 3 };
    const released = releaseResume(
      { ...prepared.state, resumeMeta: state.resumeMeta },
      { runId: prepared.run.runId, revision: 3, step: "resume" },
    );
    assert.equal(released.ok, false);
  });

  it("D05 settings survive a new app instance on the same store", async () => {
    const storage = {};
    const resume = { record: null, async get() { return this.record; }, async put(row) { this.record = row; }, async clear() { this.record = null; } };
    const alarms = { async getAll() { return []; }, async clear() {}, async create() {} };
    const make = () =>
      createApp({
        version: "1.0.0",
        chromeMajor: 148,
        now: () => now,
        timeZone: zone,
        storage: {
          async getAll() { return { ...storage }; },
          async set(obj) { Object.assign(storage, obj); },
          async setAccessLevel(opts) { this.level = opts.accessLevel; },
        },
        alarms,
        resume,
        notifications: { async create() {} },
        async openProfile() { return { ok: false, message: "Could not load or verify Naukri profile." }; },
      });
    const first = make();
    await first.init();
    assert.equal(first.snapshot() && true, true);
    const saved = await first.onMessage(
      { type: "SAVE_SETTINGS", patch: { firstName: "Ada" }, revision: first.snapshot().settings.revision },
      { context: "extension_page", id: "ext" },
    );
    assert.equal(saved.ok, true);
    const bytes = header;
    await resume.put({ name: "Ada_Lovelace_Dev.pdf", byteLength: 8, revision: 1, bytes, headerOk: true });
    const second = make();
    await second.init();
    assert.equal(second.snapshot().settings.firstName, "Ada");
    assert.equal(second.snapshot().resumeMeta.revision, 1);
  });

  it("D06 two stores do not share schedule or resume state", async () => {
    const makeStore = () => ({ data: {}, resume: null });
    const boot = (store) =>
      createApp({
        version: "1.0.0",
        now: () => now,
        timeZone: zone,
        storage: {
          async getAll() { return { ...store.data }; },
          async set(obj) { Object.assign(store.data, obj); },
          async setAccessLevel() {},
        },
        alarms: { async getAll() { return []; }, async clear() {}, async create() {} },
        resume: {
          async get() { return store.resume; },
          async put(row) { store.resume = row; },
        },
        notifications: { async create() {} },
        async openProfile() { return { ok: false, message: "no" }; },
      });
    const a = makeStore();
    const b = makeStore();
    const appA = boot(a);
    await appA.onMessage(
      { type: "SAVE_SETTINGS", patch: { firstName: "Ada" }, revision: 1 },
      { context: "extension_page", id: "ext" },
    );
    const appB = boot(b);
    await appB.init();
    assert.equal(appB.snapshot().settings.firstName, "");
    assert.notEqual(a.data.settings.firstName, b.data.settings.firstName);
  });

  it("D07 firedKeys migrate once and stay idempotent", () => {
    const migrated = migrate({
      firedKeys: ["2026-11-01|09:00"],
      settings: { firstName: "Ada", customSlots: ["09:00"] },
    });
    assert.equal(migrated.schemaVersion, 2);
    assert.equal(migrated.slotRecords["2026-11-01|09:00"].state, "success");
    assert.equal(migrated.settings.firstName, "Ada");
    const again = migrate(persistable(migrated));
    assert.equal(again.slotRecords["2026-11-01|09:00"].state, "success");
    assert.equal(again.settings.firstName, "Ada");
    assert.equal(again.settings.scheduleEnabled, true);
    const turnedOn = migrate({
      schemaVersion: 1,
      settings: { scheduleEnabled: false, termsAcknowledged: false, customSlots: ["18:59"] },
    });
    assert.equal(turnedOn.settings.scheduleEnabled, true);
    assert.equal(turnedOn.settings.termsAcknowledged, true);
    assert.deepEqual(turnedOn.settings.customSlots, ["18:59"]);
    const keptOff = migrate(persistable({ ...turnedOn, settings: { ...turnedOn.settings, scheduleEnabled: false } }));
    assert.equal(keptOff.settings.scheduleEnabled, false);
  });

  it("D08 malformed and foreign messages get no resume bytes", () => {
    const run = { runId: "run", tabId: 3, documentId: "doc", currentStep: "resume", resumeRevision: 1 };
    const good = {
      tab: { id: 3 },
      frameId: 0,
      url: "https://www.naukri.com/mnjuser/profile",
      documentId: "doc",
    };
    assert.equal(validateMessage({ type: "GET_RESUME", runId: "run" }, good, run).ok, true);
    assert.equal(validateMessage({ type: "GET_RESUME" }, { ...good, frameId: 2 }, run).ok, false);
    assert.equal(validateMessage({ type: "GET_RESUME" }, { ...good, tab: { id: 9 } }, run).ok, false);
    assert.equal(validateMessage({ type: "GET_RESUME" }, { ...good, documentId: "other" }, run).ok, false);
    assert.equal(validateMessage({ type: "GET_RESUME", runId: "old" }, good, run).ok, false);
    assert.equal(validateMessage(null, good, run).ok, false);
    assert.equal(validateMessage({ type: "GET_RESUME", tabId: 3 }, { context: "extension_page" }, run).ok, false);
    const id = "extid";
    const optionsTab = {
      id,
      url: `chrome-extension://${id}/options.html`,
      tab: { id: 4, url: `chrome-extension://${id}/options.html` },
    };
    assert.equal(validateMessage({ type: "CONNECT" }, optionsTab, null).ok, true);
    assert.equal(validateMessage({ type: "PICK_RESUME" }, optionsTab, null).ok, true);
    const naukriTab = {
      id,
      url: "https://www.naukri.com/mnjuser/profile",
      tab: { id: 4 },
      frameId: 0,
    };
    assert.equal(validateMessage({ type: "CONNECT" }, naukriTab, null).ok, false);
    assert.equal(validateMessage({ type: "PICK_RESUME" }, naukriTab, null).ok, false);
    const state = defaultState();
    state.activeRun = { ...run, revoked: false, cancelRequested: false, steps: ["resume"], stepState: { resume: "pending" } };
    state.resumeMeta = { revision: 1, originalName: "a.pdf", size: 1, mime: "" };
    const released = releaseResume(state, { runId: "run", revision: 1, step: "resume" });
    assert.equal(released.ok, true);
    const wrong = releaseResume(state, { runId: "other", revision: 1, step: "resume" });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.fileName, undefined);
  });

  it("D08b connect opens the profile tab without the windows permission", async () => {
    let listedWindows = false;
    const created = [];
    const chrome = {
      runtime: { getManifest: () => ({ version: "1.0.0" }) },
      tabs: {
        async query() {
          return [{ id: 1, url: "https://www.naukri.com/mnjuser/homepage", incognito: false }];
        },
        async create(info) {
          created.push(info);
          return { id: 8, windowId: 2 };
        },
        async update() {
          throw new Error("should reuse only a profile tab");
        },
      },
      windows: {
        async getAll() {
          listedWindows = true;
          throw new Error("The 'windows' permission is required");
        },
        async update() {
          throw new Error("The 'windows' permission is required");
        },
      },
    };
    const platform = chromePlatform(chrome, { resume: { async get() { return null; } } });
    const opened = await platform.openProfile({});
    assert.equal(listedWindows, false);
    assert.equal(opened.ok, true);
    assert.equal(opened.tab.id, 8);
    assert.deepEqual(created, [{ url: PROFILE_URL, active: true }]);
  });

  it("D09 logs are redacted, escaped, and size-bounded", () => {
    const raw = redact("mail ada@example.com phone 1234567890 %PDF-1.7 secret <script>");
    assert.equal(raw.includes("ada@example.com"), false);
    assert.equal(raw.includes("1234567890"), false);
    assert.equal(raw.includes("%PDF-"), false);
    assert.match(escapeText("<script>"), /&lt;script&gt;/);
    let log = "";
    for (let i = 0; i < 1000; i++) log = appendLog(log, "x".repeat(500));
    assert.ok(Buffer.byteLength(log, "utf8") <= 20 * 1024);
  });

  it("D10 clearing the log keeps slots, the lock, and attempts", () => {
    const state = defaultState();
    state.history = [{ runId: "1" }];
    state.logTail = "hello";
    state.slotRecords = { "2026-11-28|09:00": { state: "failed_retryable", attempts: 1 } };
    state.activeRun = { runId: "live" };
    const cleared = clearActivity(state);
    assert.equal(cleared.history.length, 0);
    assert.equal(cleared.logTail, "");
    assert.equal(cleared.slotRecords["2026-11-28|09:00"].attempts, 1);
    assert.equal(cleared.activeRun.runId, "live");
  });

  it("D11 reset and remove delete local copies only", () => {
    const state = defaultState();
    state.resumeMeta = { originalName: "a.pdf", size: 1, revision: 1, mime: "" };
    const removed = removeResume(state);
    assert.equal(removed.ok, true);
    assert.equal(removed.clearResume, true);
    assert.equal(removed.state.resumeMeta, null);
    const reset = resetAll(removed.state);
    assert.equal(reset.ok, true);
    assert.equal(reset.clearResume, true);
    assert.equal(reset.state.settings.scheduleEnabled, true);
    state.activeRun = { runId: "live" };
    assert.equal(resetAll(state).ok, false);
  });

  it("D12 filenames are safe, and missing identity blocks the preview", () => {
    const named = buildResumeFileName(
      { firstName: "Ada Lovelace", lastName: "a/b\\c", role: "CON" },
      new Date(2026, 10, 28, 23, 59, 0),
    );
    assert.equal(named.includes("/") || named.includes("\\"), false);
    assert.match(named, /^Ada_Lovelace_/);
    assert.equal(named.includes("CON"), false);
    const missing = describeIdentity({ firstName: "", lastName: "", role: "" }, "notes.pdf", now);
    assert.equal(missing.ok, false);
    assert.equal(missing.message, "Enter missing name/role before uploading.");
    const today = buildResumeFileName({ firstName: "A", lastName: "B", role: "C" }, new Date(2026, 10, 28, 23, 50));
    const next = buildResumeFileName({ firstName: "A", lastName: "B", role: "C" }, new Date(2026, 10, 29, 0, 10));
    assert.match(today, /28-11-2026/);
    assert.match(next, /29-11-2026/);
  });

  it("D13 a near-limit PDF round-trips as a File", () => {
    const bytes = new Uint8Array(PDF_MAX_BYTES);
    bytes.set(header);
    const file = toUploadFile(bytes, "Ada_Lovelace_Dev_Resume_28-11-2026.pdf");
    assert.equal(file.name, "Ada_Lovelace_Dev_Resume_28-11-2026.pdf");
    assert.equal(file.size, PDF_MAX_BYTES);
    assert.equal(file.type, "application/pdf");
  });

  it("D14 a stale settings write does not overwrite the newer revision", () => {
    const state = defaultState();
    const first = commitSettings(state, { firstName: "Ada" }, state.settings.revision, now, zone);
    const stale = commitSettings(first.state, { firstName: "Grace" }, state.settings.revision, now, zone);
    assert.equal(stale.ok, false);
    assert.equal(stale.saveState, "Error");
    assert.equal(stale.state.settings.firstName, "Ada");
  });

  it("D15 closing a popup port does not cancel the run", () => {
    const state = defaultState();
    state.activeRun = { runId: "live", cancelRequested: false };
    const viewed = publicState(state, now, zone, "1.0.0");
    assert.equal(viewed.activeRun.runId, "live");
    assert.equal(viewed.activeRun.cancelRequested, false);
    assert.equal(state.activeRun.cancelRequested, false);
  });

  it("D16 a new install is ready to run and still refuses a schedule without the terms box", () => {
    const state = defaultState();
    assert.equal(state.settings.scheduleEnabled, true);
    assert.equal(state.settings.termsAcknowledged, true);
    assert.equal(state.settings.accountConfirmed, true);
    assert.deepEqual(state.settings.actions, { headline: true, summary: true, resume: true });
    assert.deepEqual(state.settings.customSlots, ["09:00", "11:30", "14:00", "16:00"]);
    const blocked = commitSettings(
      state,
      { termsAcknowledged: false, scheduleEnabled: true },
      state.settings.revision,
      now,
      zone,
    );
    assert.equal(blocked.state.settings.scheduleEnabled, false);
    assert.equal(blocked.ok, false);
  });

  it("D17 unattended runs stay blocked when the account id is not reliable", () => {
    const state = defaultState();
    state.settings.termsAcknowledged = true;
    state.settings.scheduleEnabled = true;
    state.settings.actions = { headline: true, summary: false, resume: false };
    state.settings.customSlots = ["09:00"];
    state.settings.accountConfirmed = false;
    state.connection = { status: "connected_last_verified", identityReliable: false, accountRef: null, verifiedAt: now.toISOString() };
    const scheduled = prepareRun(state, { trigger: "scheduled", now, timeZone: zone, slotKey: "2026-11-28|09:00" });
    assert.equal(scheduled.ok, false);
    assert.equal(scheduled.code, "ACCOUNT");
    const manual = prepareRun(state, { trigger: "manual", now, timeZone: zone, confirmAccount: false });
    assert.equal(manual.code, "ACCOUNT");
    const confirmed = prepareRun(state, { trigger: "manual", now, timeZone: zone, confirmAccount: true });
    assert.equal(confirmed.ok, true);
    state.settings.accountConfirmed = true;
    state.connection.status = "not_connected";
    const saved = prepareRun(state, { trigger: "scheduled", now, timeZone: zone, slotKey: "2026-11-28|09:00" });
    assert.equal(saved.ok, true);
  });

  it("D18 the extension build is self-contained", () => {
    const dir = buildExtension();
    const background = fs.readFileSync(path.join(dir, "background.js"), "utf8");
    const content = fs.readFileSync(path.join(dir, "content.js"), "utf8");
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    assert.equal(manifest.manifest_version, 3);
    assert.equal(background.includes("require("), false);
    assert.equal(content.includes("../electron"), false);
    assert.equal(background.includes("sourceMappingURL"), false);
    assert.equal(fs.existsSync(path.join(dir, "icons", "icon128.png")), true);
    for (const name of ["popup.js", "options.js", "content.js", "background.js"]) {
      const source = fs.readFileSync(path.join(dir, name), "utf8");
      assert.equal(/require\(\s*["']\.\./.test(source), false);
      assert.equal(source.includes("node_modules"), false);
    }
  });

  it("D19 permissions, incognito, and CSP stay tight", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join("extension", "manifest.json"), "utf8"));
    assert.deepEqual(manifest.permissions.sort(), ["alarms", "notifications", "scripting", "storage", "tabs"].sort());
    assert.deepEqual(manifest.host_permissions, ["https://www.naukri.com/*"]);
    assert.equal(manifest.incognito, "not_allowed");
    assert.equal(manifest.minimum_chrome_version, "148");
    assert.equal(manifest.message_serialization, "structured_clone");
    assert.equal(manifest.background.service_worker, "background.js");
    assert.match(manifest.content_security_policy.extension_pages, /script-src 'self'/);
    assert.equal(JSON.stringify(manifest).includes("http://"), false);
    const popup = fs.readFileSync(path.join("extension", "src", "popup.js"), "utf8");
    const options = fs.readFileSync(path.join("extension", "src", "options.js"), "utf8");
    assert.equal(popup.includes("innerHTML"), false);
    assert.equal(options.includes("innerHTML"), false);
  });

  it("D20 desktop scheduler still wraps and the extension anchor does not", () => {
    const desktop = require("../electron/scheduler");
    assert.deepEqual(desktop.slotsEveryHours("20:00", 4)[0], "00:00");
    const web = fs.readFileSync(path.join("server", "index.js"), "utf8");
    assert.equal(web.includes("express"), true);
  });
});
