/** Pure resume-name helpers. No Node path/fs. Handles Windows and POSIX names. */

const RESERVED = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "lpt1",
  "lpt2",
  "lpt3",
]);

/** Sanitize one name segment for a resume filename. */
const sanitizePart = (value) =>
  String(value || "")
    .replace(/[\u0000-\u001f]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^\w.-]+/g, "")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "") || "X";

const safePart = (value) => {
  const cleaned = sanitizePart(value);
  return RESERVED.has(cleaned.toLowerCase()) ? "X" : cleaned;
};

/** Last path segment without extension. Accepts `/` and `\\`. */
const fileStem = (sourcePath) => {
  const raw = String(sourcePath || "");
  const slash = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
  const base = slash >= 0 ? raw.slice(slash + 1) : raw;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return base;
  return base.slice(0, dot);
};

/**
 * Guess first/last/role from a resume file name when the user left fields blank.
 * Understands our own `*_Resume_DD-MM-YYYY` pattern (and legacy `YYYY-MM-DD`)
 * plus plain `First_Last_Role` stems.
 */
const identityFromResumePath = (sourcePath) => {
  if (!sourcePath) return { firstName: "", lastName: "", role: "" };
  const stem = fileStem(sourcePath);
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
 * Uses the local calendar date of `now` (never hard-coded, never toISOString).
 */
const buildResumeFileName = (
  { firstName, lastName, role },
  now = new Date(),
) => {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const first = safePart(firstName);
  const last = safePart(lastName);
  let rolePart = safePart(role);
  const suffix = `_Resume_${d}-${m}-${y}.pdf`;
  let name = `${first}_${last}_${rolePart}${suffix}`;
  if (name.length > 180) {
    const room = 180 - (`${first}_${last}_`.length + suffix.length);
    rolePart = rolePart.slice(0, Math.max(1, room));
    name = `${first}_${last}_${rolePart}${suffix}`;
  }
  return name;
};

const describeIdentity = (identity = {}, sourcePath = "", now = new Date()) => {
  const resolved = resolveIdentity(identity, sourcePath);
  if (!resolved.firstName || !resolved.lastName || !resolved.role) {
    return {
      ok: false,
      resolved,
      message: "Enter missing name/role before uploading.",
    };
  }
  return {
    ok: true,
    resolved,
    fileName: buildResumeFileName(resolved, now),
  };
};

module.exports = {
  sanitizePart,
  safePart,
  fileStem,
  identityFromResumePath,
  resolveIdentity,
  buildResumeFileName,
  describeIdentity,
};
