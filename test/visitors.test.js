const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "visitors-test-"));
process.env.DATA_DIR = dir;
const v = require("../server/visitors");

const sid = () => crypto.randomUUID();

describe("local visitor storage", () => {
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("creates defaults and persists them to disk", async () => {
    const id = sid();
    const row = await v.getOrCreateVisitor(id);
    assert.equal(row.settings.scheduleEnabled, false);
    assert.ok(fs.existsSync(path.join(dir, "visitors", `${id}.json`)));
  });

  it("persists settings, slots and timer state across reads", async () => {
    const id = sid();
    await v.patchSettings(id, {
      firstName: "Asha",
      scheduleEnabled: true,
      slots: ["18:30", "09:00"],
    });
    await v.updateVisitor(id, { storage_state: { cookies: [] } });
    const row = await v.getOrCreateVisitor(id);
    assert.equal(row.settings.firstName, "Asha");
    assert.deepEqual(row.settings.slots, ["09:00", "18:30"]);
    assert.deepEqual(row.storage_state, { cookies: [] });
  });

  it("saveStorageState sets connected_at", async () => {
    const id = sid();
    const row = await v.saveStorageState(id, { cookies: [{ name: "a" }] });
    assert.ok(row.connected_at);
    assert.equal(row.settings.connectedAt, row.connected_at);
  });

  it("keeps only the last 80 log lines and clears", async () => {
    const id = sid();
    for (let i = 0; i < 90; i++) await v.appendLog(id, `line ${i}`);
    const row = await v.getOrCreateVisitor(id);
    const lines = row.log_tail.split("\n");
    assert.equal(lines.length, 80);
    assert.match(lines[79], /line 89$/);
    assert.equal((await v.clearLog(id)).log_tail, "");
  });

  it("stores and returns a resume", async () => {
    const id = sid();
    const buf = Buffer.from("%PDF-1.4 test");
    const p = await v.uploadResume(id, buf, "My Resume.pdf");
    const got = await v.downloadResume(id);
    assert.equal(got.storagePath, p);
    assert.deepEqual(got.buf, buf);
    assert.match(got.basename, /My_Resume\.pdf$/);
  });

  it("download without a resume fails", async () => {
    await assert.rejects(v.downloadResume(sid()), /Choose a resume/);
  });

  it("lists only visitors with schedule on and a session", async () => {
    const on = sid();
    const noSession = sid();
    await v.patchSettings(on, { scheduleEnabled: true, slots: ["10:00"] });
    await v.updateVisitor(on, { storage_state: { cookies: [] } });
    await v.patchSettings(noSession, { scheduleEnabled: true });
    const ids = (await v.listSchedulableVisitors()).map((x) => x.id);
    assert.ok(ids.includes(on));
    assert.ok(!ids.includes(noSession));
  });

  it("rejects ids that could escape the data directory", async () => {
    await assert.rejects(v.getOrCreateVisitor("../../etc/passwd"), /Invalid session id/);
    await assert.rejects(v.uploadResume("../x", Buffer.from("x"), "a.pdf"), /Invalid session id/);
  });

  it("rejects a tampered resume path", async () => {
    const id = sid();
    await v.updateVisitor(id, { resume_path: "../../visitors/escape.pdf" });
    await assert.rejects(v.downloadResume(id), /Invalid resume path/);
  });

  it("does not arm a time that is already past or current when it is saved", async () => {
    const id = sid();
    const now = new Date(2026, 10, 27, 10, 0, 30);
    await v.patchSettings(id, { scheduleEnabled: true, slots: ["09:00", "10:00", "11:00"] }, now);
    const { settings } = await v.getOrCreateVisitor(id);
    assert.equal(settings.firedDay, "2026-11-27");
    assert.deepEqual(settings.firedKeys.sort(), ["2026-11-27|09:00", "2026-11-27|10:00"]);
  });

  it("does not re-skip or reset anything when the same slots are saved again", async () => {
    const id = sid();
    const now = new Date(2026, 10, 27, 10, 0, 30);
    await v.patchSettings(id, { scheduleEnabled: true, slots: ["11:00"] }, now);
    await v.patchSettings(id, { scheduleEnabled: true, slots: ["11:00"], firstName: "A" }, now);
    const { settings } = await v.getOrCreateVisitor(id);
    assert.deepEqual(settings.firedKeys, []);
  });

  it("does not skip anything while the schedule is off", async () => {
    const id = sid();
    const now = new Date(2026, 10, 27, 10, 0, 30);
    await v.patchSettings(id, { scheduleEnabled: false, slots: ["10:00"] }, now);
    const { settings } = await v.getOrCreateVisitor(id);
    assert.deepEqual(settings.firedKeys, []);
  });

  it("treats existing slots as new when the schedule is switched on", async () => {
    const id = sid();
    const now = new Date(2026, 10, 27, 10, 0, 30);
    await v.patchSettings(id, { scheduleEnabled: false, slots: ["10:00"] }, now);
    await v.patchSettings(id, { scheduleEnabled: true }, now);
    const { settings } = await v.getOrCreateVisitor(id);
    assert.deepEqual(settings.firedKeys, ["2026-11-27|10:00"]);
  });
});
