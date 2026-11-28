/** Pure helpers — no browser, filesystem, or Chrome APIs. */

/**
 * Cycle the trailing dots: "" → "." → ".." → "" → ... Always differs from `current`.
 * When `maxLen` is set (Naukri headline/summary caps), shorten the base so the
 * result still fits and still differs — otherwise a full field silently no-ops.
 */
const nextHeadline = (current, maxLen) => {
  const cur = String(current).trimEnd();
  const base = cur.replace(/\.+$/, "");
  const dots = cur.length - base.length;
  let next = base + ".".repeat(dots >= 2 ? 0 : dots + 1);
  if (maxLen != null && next.length > maxLen) {
    const wantDots = dots >= 2 ? 0 : dots + 1;
    const trimmed = base
      .slice(0, Math.max(0, maxLen - wantDots))
      .replace(/\.+$/, "");
    next = trimmed + ".".repeat(wantDots);
    if (next === cur) {
      next = (cur.endsWith(".") ? cur.slice(0, -1) : cur + ".").slice(0, maxLen);
    }
  }
  return next;
};

/**
 * How to change headline/summary so Naukri sees an edit.
 * - mode "dot": cycle trailing dots (default)
 * - mode "custom": APPEND customText to the end of the current value
 *   (never replaces the whole field — Naukri rejects short replacements)
 */
const applyBump = (current, { mode = "dot", customText = "" } = {}, maxLen) => {
  const raw = String(current).trimEnd();
  if (mode === "custom") {
    const cur = raw.replace(/\.+$/, "");
    const addon = String(customText || "").trim();
    if (!addon) {
      throw new Error(
        "Custom bump text is empty — type a value or switch to Add trailing dots.",
      );
    }
    const gap = cur && !/\s$/.test(cur) ? " " : "";
    let next = `${cur}${gap}${addon}`;
    if (maxLen != null && next.length > maxLen) {
      const room = Math.max(0, maxLen - addon.length - (addon ? 1 : 0));
      const kept = cur.slice(0, room).trimEnd();
      next = kept ? `${kept} ${addon}` : addon.slice(0, maxLen);
      if (next.length > maxLen) next = next.slice(0, maxLen);
    }
    if (next === raw) {
      throw new Error(
        "Appending custom text did not change the field (max length?). Try a shorter addon or dot mode.",
      );
    }
    return {
      next,
      changeMsg: `stripped trailing dots (if any) and appended "${addon.slice(0, 40)}" (${raw.length} → ${next.length} chars)`,
    };
  }
  const next = nextHeadline(raw, maxLen);
  const dots = next.length - next.replace(/\.+$/, "").length;
  const prevDots = raw.length - raw.replace(/\.+$/, "").length;
  const changeMsg =
    dots > prevDots
      ? `added trailing dot (${prevDots} → ${dots})`
      : dots < prevDots
        ? `cleared trailing dots (${prevDots} → ${dots})`
        : "cycled trailing dots";
  return { next, changeMsg };
};

const MONTH_INDEX = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9,
  nov: 10, november: 10, dec: 11, december: 11,
};

/**
 * True when the profile's resume was uploaded today.
 * Parses the date that directly follows "Uploaded on".
 * Naukri shows "28 Nov 2026" and "28-11-2026" as well as "Nov 28, 2026".
 */
const uploadedToday = (text, now = new Date()) => {
  const marker = /Uploaded on\s*:?\s*([^\n]{0,40})/i.exec(String(text));
  if (!marker) return false;
  const rest = marker[1].trim();
  if (/^today\b/i.test(rest)) return true;
  const mdy = /^([A-Za-z]{3,9})\s+0?(\d{1,2}),?\s+(\d{4})/.exec(rest);
  const dmy = /^0?(\d{1,2})\s+([A-Za-z]{3,9}),?\s+(\d{4})/.exec(rest);
  const num = /^0?(\d{1,2})[/\-.]0?(\d{1,2})[/\-.](\d{4})/.exec(rest);
  let year;
  let month;
  let day;
  if (mdy) {
    month = MONTH_INDEX[mdy[1].toLowerCase()];
    day = Number(mdy[2]);
    year = Number(mdy[3]);
  } else if (dmy) {
    day = Number(dmy[1]);
    month = MONTH_INDEX[dmy[2].toLowerCase()];
    year = Number(dmy[3]);
  } else if (num) {
    day = Number(num[1]);
    month = Number(num[2]) - 1;
    year = Number(num[3]);
  } else {
    return false;
  }
  if (month == null || month < 0 || month > 11) return false;
  const d = new Date(year, month, day);
  return d.getFullYear() === year && d.getMonth() === month && d.getDate() === day
    && d.toDateString() === now.toDateString();
};

const normField = (value) =>
  String(value ?? "")
    .replace(/\u00a0/g, " ")
    .trimEnd();

const EMPTY_HEADLINE =
  "Custom mode: fill \u201cResume headline\u201d text (or switch to Add trailing dots).";
const EMPTY_SUMMARY =
  "Custom mode: fill \u201cProfile summary\u201d text (or switch to Add trailing dots).";

const emptyCustomMessage = (field) =>
  field === "summary" ? EMPTY_SUMMARY : EMPTY_HEADLINE;

/** Remove only an extension-owned suffix sitting at the end of the field. */
const splitOwnedSuffix = (current, ownedSuffix) => {
  const raw = normField(current);
  const suffix = String(ownedSuffix || "");
  if (!suffix || !raw.endsWith(suffix)) return { base: raw, matched: false };
  let base = raw.slice(0, raw.length - suffix.length);
  if (base.endsWith(" ")) base = base.slice(0, -1);
  return { base, matched: true };
};

const alreadyHasSuffix = (current, addon) => {
  const raw = normField(current);
  const text = String(addon || "").trim();
  if (!text) return false;
  return raw === text || raw.endsWith(` ${text}`);
};

/**
 * Idempotent field plan. Does not mutate the profile.
 * status: change | no_change | conflict | invalid
 */
const planFieldUpdate = ({
  current,
  mode = "dot",
  customText = "",
  ownedSuffix = "",
  maxLen,
  field = "headline",
} = {}) => {
  const raw = normField(current);
  const owned = String(ownedSuffix || "");

  if (mode === "custom") {
    const addon = String(customText || "").trim();
    if (!addon) return { status: "invalid", message: emptyCustomMessage(field) };
    if (owned && !splitOwnedSuffix(raw, owned).matched) {
      return {
        status: "conflict",
        message: "Profile changed outside this run; review before retrying.",
      };
    }
    if (!owned && alreadyHasSuffix(raw, addon)) {
      return { status: "no_change", next: raw, ownedSuffix: addon };
    }
    const base = owned ? splitOwnedSuffix(raw, owned).base : raw;
    let planned;
    try {
      planned = applyBump(base, { mode: "custom", customText: addon }, maxLen);
    } catch (err) {
      if (normField(base) && alreadyHasSuffix(raw, addon)) {
        return { status: "no_change", next: raw, ownedSuffix: addon };
      }
      return { status: "invalid", message: err.message };
    }
    if (normField(planned.next) === raw) {
      return { status: "no_change", next: raw, ownedSuffix: addon };
    }
    return {
      status: "change",
      next: planned.next,
      ownedSuffix: addon,
    };
  }

  let working = raw;
  if (owned) {
    const split = splitOwnedSuffix(raw, owned);
    if (!split.matched) {
      return {
        status: "conflict",
        message: "Profile changed outside this run; review before retrying.",
      };
    }
    working = split.base;
  }
  const next = nextHeadline(working, maxLen);
  const dots = (next.match(/\.+$/) || [""])[0];
  if (normField(next) === raw) {
    return { status: "no_change", next: raw, ownedSuffix: dots };
  }
  return { status: "change", next, ownedSuffix: dots };
};

/**
 * Compare a live field with a journaled before/target pair.
 * Returns verified | retry | conflict.
 */
const journalDecision = ({ current, before, target } = {}) => {
  const now = normField(current);
  if (target != null && now === normField(target)) return "verified";
  if (before != null && now === normField(before)) return "retry";
  return "conflict";
};

module.exports = {
  nextHeadline,
  applyBump,
  uploadedToday,
  normField,
  emptyCustomMessage,
  planFieldUpdate,
  splitOwnedSuffix,
  journalDecision,
};
