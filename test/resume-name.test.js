const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  sanitizePart,
  identityFromResumePath,
  resolveIdentity,
  buildResumeFileName,
  prepareResumeCopy,
} = require("../electron/resume-name");

describe("sanitizePart", () => {
  it("replaces spaces and strips junk", () => {
    assert.equal(sanitizePart("  Jane Doe  "), "Jane_Doe");
    assert.equal(sanitizePart("A/B*C"), "ABC");
  });

  it("falls back to X for empty", () => {
    assert.equal(sanitizePart(""), "X");
    assert.equal(sanitizePart("   "), "X");
  });
});

describe("identityFromResumePath / resolveIdentity", () => {
  it("parses our standard renamed pattern", () => {
    assert.deepEqual(
      identityFromResumePath(
        "C:\\tmp\\Ada_Lovelace_Software_Engineer_Resume_23-11-2026.pdf",
      ),
      {
        firstName: "Ada",
        lastName: "Lovelace",
        role: "Software_Engineer",
      },
    );
  });

  it("still parses legacy YYYY-MM-DD resume names", () => {
    assert.deepEqual(
      identityFromResumePath(
        "C:\\tmp\\Ada_Lovelace_Software_Engineer_Resume_2026-11-23.pdf",
      ),
      {
        firstName: "Ada",
        lastName: "Lovelace",
        role: "Software_Engineer",
      },
    );
  });

  it("fills blank typed fields from the resume file name", () => {
    assert.deepEqual(
      resolveIdentity(
        { firstName: "", lastName: "Override", role: "" },
        "/resumes/Ada_Lovelace_Dev.pdf",
      ),
      { firstName: "Ada", lastName: "Override", role: "Dev" },
    );
  });
});

describe("buildResumeFileName", () => {
  it("builds FirstName_LastName_Role_Resume_DD-MM-YYYY.pdf from local now", () => {
    const now = new Date(2026, 10, 23); // local Nov 23, 2026
    assert.equal(
      buildResumeFileName(
        { firstName: "Ada", lastName: "Lovelace", role: "Software Engineer" },
        now,
      ),
      "Ada_Lovelace_Software_Engineer_Resume_23-11-2026.pdf",
    );
  });

  it("rolls the date with the clock (not hard-coded)", () => {
    const today = buildResumeFileName(
      { firstName: "A", lastName: "B", role: "C" },
      new Date(2026, 10, 23),
    );
    const tomorrow = buildResumeFileName(
      { firstName: "A", lastName: "B", role: "C" },
      new Date(2026, 10, 24),
    );
    assert.equal(today, "A_B_C_Resume_23-11-2026.pdf");
    assert.equal(tomorrow, "A_B_C_Resume_24-11-2026.pdf");
  });
});

describe("prepareResumeCopy", () => {
  it("copies PDF under the standard name", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-name-"));
    const src = path.join(dir, "source.pdf");
    fs.writeFileSync(src, "%PDF-1.4");
    const destDir = path.join(dir, "out");
    const now = new Date(2026, 0, 5);
    const dest = prepareResumeCopy(
      src,
      destDir,
      { firstName: "Ada", lastName: "Lovelace", role: "Dev" },
      now,
    );
    assert.equal(path.basename(dest), "Ada_Lovelace_Dev_Resume_05-01-2026.pdf");
    assert.ok(fs.existsSync(dest));
  });

  it("rejects non-PDF", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-name-"));
    const src = path.join(dir, "source.txt");
    fs.writeFileSync(src, "nope");
    assert.throws(
      () =>
        prepareResumeCopy(src, dir, {
          firstName: "A",
          lastName: "B",
          role: "C",
        }),
      /PDF/i,
    );
  });
});
