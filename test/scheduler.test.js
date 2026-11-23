const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  MAX_SLOTS,
  normalizeSlot,
  normalizeSlots,
  slotsDueNow,
  nextSlotAfter,
  slotsEveryHours,
} = require("../electron/scheduler");

describe("normalizeSlot", () => {
  it("pads and validates HH:MM", () => {
    assert.equal(normalizeSlot("9:05"), "09:05");
    assert.equal(normalizeSlot("23:59"), "23:59");
    assert.equal(normalizeSlot("24:00"), null);
    assert.equal(normalizeSlot("nope"), null);
  });
});

describe("normalizeSlots", () => {
  it("dedupes, sorts, and caps at MAX_SLOTS", () => {
    assert.equal(MAX_SLOTS, 4);
    assert.deepEqual(
      normalizeSlots(["14:00", "09:00", "14:00", "11:30", "08:00", "07:00"]),
      ["08:00", "09:00", "11:30", "14:00"],
    );
  });

  it("throws on invalid slot", () => {
    assert.throws(() => normalizeSlots(["25:00"]), /invalid time slot/);
  });
});

describe("slotsDueNow", () => {
  it("returns matching unfired slots for this minute", () => {
    const now = new Date(2026, 10, 23, 9, 30, 12);
    const fired = new Set();
    assert.deepEqual(slotsDueNow(["09:30", "18:00"], fired, now), ["09:30"]);
  });

  it("skips slots already fired today", () => {
    const now = new Date(2026, 10, 23, 9, 30, 0);
    const fired = new Set(["2026-11-23|09:30"]);
    assert.deepEqual(slotsDueNow(["09:30"], fired, now), []);
  });
});

describe("slotsEveryHours", () => {
  it("fills 4 slots every 4 hours from start", () => {
    assert.deepEqual(slotsEveryHours("09:00", 4), [
      "09:00",
      "13:00",
      "17:00",
      "21:00",
    ]);
  });

  it("wraps past midnight", () => {
    assert.deepEqual(slotsEveryHours("20:00", 4), [
      "00:00",
      "04:00",
      "08:00",
      "20:00",
    ]);
  });
});

describe("nextSlotAfter", () => {
  it("picks the next later slot today", () => {
    const now = new Date(2026, 10, 23, 10, 0, 0);
    assert.deepEqual(nextSlotAfter(["09:00", "14:00"], now), {
      day: "2026-11-23",
      slot: "14:00",
    });
  });

  it("rolls to tomorrow when all slots passed", () => {
    const now = new Date(2026, 10, 23, 20, 0, 0);
    assert.deepEqual(nextSlotAfter(["09:00", "14:00"], now), {
      day: "2026-11-24",
      slot: "09:00",
    });
  });
});
