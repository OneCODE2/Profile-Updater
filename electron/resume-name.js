const fs = require("fs");
const path = require("path");

/** Sanitize one name segment for a resume filename. */
const sanitizePart = (value) =>
  String(value || "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\w.-]+/g, "")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "") || "X";

/**
 * Guess first/last/role from a resume file name when the user left fields blank.
 * Understands our own `*_Resume_DD-MM-YYYY` pattern (and legacy `YYYY-MM-DD`)
 * plus plain `First_Last_Role` stems.
 */
const identityFromResumePath = (sourcePath) => {
  if (!sourcePath) return { firstName: "", lastName: "", role: "" };
  const stem = path.basename(String(sourcePath), path.extname(sourcePath));
  const cleaned = stem.replace(
    /_Resume_(\d{2}-\d{2}-\d{4}|\d{4}-\d{2}-\d{2})$/i,
    "",
  );
  const parts = cleaned.split(/[_\s]+/).filter(Boolean);
  if (parts.length >= 3) {
    return {
      firstName: parts[0],
      lastName: parts[1],
      role: parts.slice(2).join("_"),
    };
  }
  if (parts.length === 2) {
    return { firstName: parts[0], lastName: parts[1], role: "" };
  }
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: "", role: "" };
  }
  return { firstName: "", lastName: "", role: "" };
};

/** Prefer typed fields; fill blanks from the selected resume file name. */
const resolveIdentity = (identity = {}, sourcePath = "") => {
  const fromFile = identityFromResumePath(sourcePath);
  const pick = (key) => {
    const typed = String(identity[key] || "").trim();
    return typed || fromFile[key] || "";
  };
  return {
    firstName: pick("firstName"),
    lastName: pick("lastName"),
    role: pick("role"),
  };
};

/**
 * FirstName_LastName_Role_Resume_DD-MM-YYYY.pdf
 * Uses the user's local calendar date of `now` (never hard-coded).
 */
const buildResumeFileName = (
  { firstName, lastName, role },
  now = new Date(),
) => {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${sanitizePart(firstName)}_${sanitizePart(lastName)}_${sanitizePart(role)}_Resume_${d}-${m}-${y}.pdf`;
};

/**
 * Copy source PDF into destDir under the standard name. Returns absolute path.
 * Blank identity fields are filled from the source file name when possible.
 */
const prepareResumeCopy = (sourcePath, destDir, identity, now = new Date()) => {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error(`resume file missing: ${sourcePath || "(empty)"}`);
  }
  if (path.extname(sourcePath).toLowerCase() !== ".pdf") {
    throw new Error("resume must be a PDF file");
  }
  fs.mkdirSync(destDir, { recursive: true });
  const resolved = resolveIdentity(identity, sourcePath);
  const fileName = buildResumeFileName(resolved, now);
  const destPath = path.join(destDir, fileName);
  fs.copyFileSync(sourcePath, destPath);
  return destPath;
};

module.exports = {
  sanitizePart,
  identityFromResumePath,
  resolveIdentity,
  buildResumeFileName,
  prepareResumeCopy,
};
