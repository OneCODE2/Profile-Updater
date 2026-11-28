const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  nextHeadline,
  applyBump,
  uploadedToday,
} = require("../electron/naukri-helpers");

describe("nextHeadline", () => {
  it("cycles trailing dots and never no-ops", () => {
    assert.equal(nextHeadline("Full stack dev"), "Full stack dev.");
    assert.equal(nextHeadline("Full stack dev."), "Full stack dev..");
    assert.equal(nextHeadline("Full stack dev.."), "Full stack dev");
    assert.equal(nextHeadline("Full stack dev  "), "Full stack dev.");
    for (const h of ["", "x", "x.", "x..", "x...", "Ends with a sentence."]) {
      assert.notEqual(nextHeadline(h), h.trimEnd());
    }
  });

  it("respects maxLen while still changing the value", () => {
    assert.equal(nextHeadline("abc", 3), "ab.");
    assert.equal(nextHeadline("ab.", 3), "a..");
    assert.equal(nextHeadline("a..", 3), "a");
    assert.ok(nextHeadline("x".repeat(250), 250).length <= 250);
    assert.notEqual(nextHeadline("x".repeat(250), 250), "x".repeat(250));
  });
});

describe("applyBump", () => {
  it("dot mode cycles trailing dots", () => {
    const r = applyBump("Full stack", { mode: "dot" });
    assert.equal(r.next, "Full stack.");
    assert.match(r.changeMsg, /dot/i);
  });

  it("custom mode strips trailing dots then appends", () => {
    const r = applyBump("Full stack developer ready for roles..", {
      mode: "custom",
      customText: "SDE",
    });
    assert.equal(r.next, "Full stack developer ready for roles SDE");
    assert.match(r.changeMsg, /appended/i);
  });

  it("custom mode rejects empty addon", () => {
    assert.throws(
      () => applyBump("Same", { mode: "custom", customText: "" }),
      /empty/i,
    );
  });
});

describe("uploadedToday", () => {
  const now = new Date("2026-08-12T10:00:00");

  it("parses Uploaded on dates", () => {
    assert.equal(uploadedToday("Uploaded on Aug 12, 2026", now), true);
    assert.equal(uploadedToday("Uploaded on Aug 09, 2026", now), false);
    assert.equal(uploadedToday("Uploaded on: August 12, 2026", now), true);
    assert.equal(uploadedToday("Uploaded on 12 Aug 2026", now), true);
    assert.equal(uploadedToday("Uploaded on 12-08-2026", now), true);
    assert.equal(uploadedToday("Uploaded on today", now), true);
    assert.equal(uploadedToday("Uploaded on 09-08-2026", now), false);
  });

  it("ignores other today dates on the page", () => {
    assert.equal(
      uploadedToday(
        "Profile last updated Aug 12, 2026\nResume\nUploaded on Aug 09, 2026",
        now,
      ),
      false,
    );
  });

  it("returns false when unparseable", () => {
    assert.equal(uploadedToday("Uploaded on", now), false);
    assert.equal(uploadedToday("", now), false);
  });
});
