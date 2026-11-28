const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createApp } = require("../extension/src/app");
const { systemTimeZone } = require("../shared/time");

const zone = systemTimeZone();
const now = new Date(2026, 10, 28, 18, 0, 0);
const header = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const ui = { context: "extension_page", id: "ext" };
const naukri = {
  tab: { id: 3 },
  frameId: 0,
  url: "https://www.naukri.com/mnjuser/profile",
};

describe("extension feature cycle", () => {
  it("walks add resume, custom times, run, cancel, run again, and a conflict review", async () => {
    const storage = {};
    const resume = {
      record: null,
      async get() {
        return this.record;
      },
      async put(row) {
        this.record = row;
      },
      async clear() {
        this.record = null;
      },
    };
    let opened = 0;
    const app = createApp({
      version: "1.0.0",
      chromeMajor: 148,
      now: () => now,
      timeZone: zone,
      storage: {
        async getAll() {
          return { ...storage };
        },
        async set(obj) {
          Object.assign(storage, obj);
        },
        async setAccessLevel() {},
      },
      alarms: { async getAll() { return []; }, async clear() {}, async create() {} },
      resume,
      notifications: { async create() {} },
      tabs: { async sendMessage() {} },
      async openProfile() {
        opened += 1;
        return { ok: true, tab: { id: 3, windowId: 1 } };
      },
    });

    await app.init();
    const fresh = app.snapshot();
    assert.equal(fresh.settings.scheduleEnabled, true);
    assert.equal(fresh.settings.termsAcknowledged, true);
    assert.equal(fresh.settings.accountConfirmed, true);
    assert.deepEqual(fresh.settings.actions, { headline: true, summary: true, resume: true });
    assert.equal(app.snapshot().connection.status === "connected_last_verified", false);

    const picked = await app.onMessage(
      {
        type: "PICK_RESUME",
        file: {
          name: "Aditya_Software_Engineer_.pdf",
          byteLength: header.length,
          mime: "application/pdf",
          header,
          bytes: header,
        },
      },
      ui,
    );
    assert.equal(picked.ok, true);
    assert.equal(app.snapshot().resumeMeta.originalName, "Aditya_Software_Engineer_.pdf");

    const times = await app.onMessage(
      {
        type: "SAVE_SETTINGS",
        revision: app.snapshot().settings.revision,
        patch: {
          firstName: "Aditya",
          lastName: "Sharma",
          role: "Engineer",
          scheduleEnabled: true,
          scheduleMode: "custom",
          customSlots: ["19:37", "19:38"],
          termsAcknowledged: true,
          accountConfirmed: true,
        },
      },
      ui,
    );
    assert.equal(times.ok, true);
    assert.deepEqual(app.snapshot().settings.customSlots, ["19:37", "19:38"]);
    assert.equal(app.snapshot().settings.scheduleEnabled, true);

    const started = await app.onMessage({ type: "RUN_NOW", confirmAccount: true }, ui);
    assert.equal(started.ok, true);
    assert.equal(opened, 1);
    assert.ok(app.snapshot().activeRun);

    const cancelled = await app.onMessage({ type: "CANCEL_RUN" }, ui);
    assert.equal(cancelled.ok, true);
    assert.equal(app.snapshot().activeRun, null);
    assert.equal(app.snapshot().lastResult.status, "cancelled");

    const again = await app.onMessage({ type: "RUN_NOW", confirmAccount: true }, ui);
    assert.equal(again.ok, true);
    assert.equal(opened, 2);
    const runId = app.snapshot().activeRun.runId;
    const finished = await app.onMessage(
      {
        type: "RUN_FINISH",
        runId,
        status: "conflict",
        errorCode: "CONFLICT",
        message: "Profile changed outside this run; review before retrying.",
      },
      naukri,
    );
    assert.equal(finished.ok, true);
    assert.equal(app.snapshot().reviewRequired, true);
    assert.equal(app.snapshot().activeRun, null);

    const afterConflict = await app.onMessage({ type: "RUN_NOW", confirmAccount: true }, ui);
    assert.equal(afterConflict.ok, true, afterConflict.message);
    assert.equal(app.snapshot().reviewRequired, false);
    assert.equal(opened, 3);
    await app.onMessage({ type: "CANCEL_RUN" }, ui);
    assert.equal(app.snapshot().activeRun, null);
  });
});
