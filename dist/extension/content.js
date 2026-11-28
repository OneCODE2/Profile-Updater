(function(){
const __m={};
function __req(id){
if(!__m[id].exp){const module={exports:{}};__m[id].fn(module,module.exports,__req);__m[id].exp=module.exports;}
return __m[id].exp;
}
__m["extension/src/dom.js"]= {fn:function(module,exports,require){
/** Selectors from the desktop runner. Live pages are unverified — fail closed. */
const SELECTORS = {
  headlineEdit: [
    "#lazyResumeHead span.edit.icon",
    '[data-ga-track*="resumeHeadline"] .edit',
  ],
  headlineField: ["#resumeHeadlineTxt"],
  summaryEdit: [
    "#lazyProfileSummary span.edit.icon",
    '[aria-label="Edit profile summary"]',
  ],
  summaryField: ["#profileSummaryTxt"],
  resumeInput: ["#attachCV"],
};

const PROFILE_URL = "https://www.naukri.com/mnjuser/profile";

const textOf = (el) => String(el?.textContent || "").replace(/\s+/g, " ").trim();

const isVisible = (el) => {
  if (!el) return false;
  if (el.hidden || el.disabled) return false;
  if (typeof el.getAttribute === "function" && el.getAttribute("hidden") != null) return false;
  const style = el.style || {};
  if (style.display === "none" || style.visibility === "hidden") return false;
  return true;
};

const selectorMiss = () => ({
  ok: false,
  code: "SELECTOR",
  count: 0,
  message: "Profile layout could not be verified.",
});

/** Use the first known selector that points at one visible control. */
const queryUnique = (root, selectors) => {
  if (!root?.querySelectorAll) return selectorMiss();
  for (const selector of selectors) {
    const found = [...root.querySelectorAll(selector)].filter((el) => isVisible(el));
    if (found.length === 1) return { ok: true, el: found[0] };
  }
  return selectorMiss();
};

const directText = (el) => {
  if (!el) return "";
  if (el.childNodes) {
    let out = "";
    for (const node of el.childNodes) {
      if (node.nodeType === 3) out += node.textContent || "";
    }
    const trimmed = out.replace(/\s+/g, " ").trim();
    if (trimmed) return trimmed;
  }
  if (!el.children?.length) return textOf(el);
  return "";
};

const isEditControl = (el) => {
  if (!isVisible(el)) return false;
  const cls = `${el.className || ""} ${el.getAttribute?.("aria-label") || ""}`;
  return /edit/i.test(cls) || /^edit$/i.test(textOf(el));
};

/** Fallback when Naukri drops the old ids but still shows the section title. */
const findLabeledEdit = (doc, label) => {
  if (!doc?.querySelectorAll) return selectorMiss();
  const pattern = new RegExp(`^${label}$`, "i");
  for (const node of doc.querySelectorAll("span, div, h1, h2, h3, h4, p, label, a")) {
    if (!pattern.test(directText(node))) continue;
    let scope = node.parentElement;
    for (let depth = 0; scope && depth < 6; depth += 1, scope = scope.parentElement) {
      const edits = [...scope.querySelectorAll("span, button, a, i")].filter(isEditControl);
      if (edits.length === 1) return { ok: true, el: edits[0] };
    }
  }
  return selectorMiss();
};

const classifyLocation = (url) => {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "bad_url";
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "www.naukri.com") return "bad_host";
  if (parsed.pathname.startsWith("/nlogin")) return "login";
  if (
    parsed.pathname === "/mnjuser/profile" ||
    parsed.pathname.startsWith("/mnjuser/profile/")
  ) {
    return "profile_route";
  }
  if (parsed.pathname.startsWith("/mnjuser")) return "mnjuser_only";
  return "other";
};

const challengeText = (text) =>
  /access denied|captcha|are you a human|too many requests|rate limit/i.test(text || "");

const assessDocument = (doc, url) => {
  const text = textOf(doc.body || doc);
  if (challengeText(text)) {
    return {
      status: "action_required",
      code: "CHALLENGE",
      message: "Action required — resolve on Naukri and resume manually.",
    };
  }
  const where = classifyLocation(url);
  if (where === "bad_host" || where === "bad_url") {
    return {
      status: "unable_to_verify",
      code: "HOST",
      message: "Could not load or verify Naukri profile.",
    };
  }
  if (where === "login") {
    return {
      status: "awaiting_sign_in",
      code: "LOGIN",
      message: "Sign in on the Naukri tab",
    };
  }
  if (where !== "profile_route") {
    return {
      status: "unable_to_verify",
      code: "ROUTE",
      message: "Could not load or verify Naukri profile.",
    };
  }
  const headline =
    queryUnique(doc, SELECTORS.headlineEdit).ok || findLabeledEdit(doc, "Resume headline").ok;
  const summary =
    queryUnique(doc, SELECTORS.summaryEdit).ok || findLabeledEdit(doc, "Profile summary").ok;
  const resume = queryUnique(doc, SELECTORS.resumeInput).ok;
  if (!headline && !summary && !resume) {
    return {
      status: "unable_to_verify",
      code: "SELECTOR",
      message: "Profile layout could not be verified.",
    };
  }
  return { status: "ready", code: "READY", identityReliable: false, accountRef: null };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Naukri mounts the headline editor after scroll. Same wait the desktop runner uses. */
const scrollToHeading = (doc, name) => {
  if (!doc?.querySelectorAll || !name) return;
  const pattern = new RegExp(`^${name}$`, "i");
  for (const node of doc.querySelectorAll("span, div, h1, h2, h3, h4, p, label, .collection-item")) {
    const label = directText(node);
    const all = textOf(node);
    if (!(pattern.test(label) || (pattern.test(all) && all.length <= 80))) continue;
    if (typeof node.scrollIntoView === "function") node.scrollIntoView();
    return;
  }
  const root = doc.scrollingElement || doc.documentElement || doc.body;
  if (root && typeof root.scrollTop === "number") root.scrollTop += 800;
};

const waitForProfile = async (doc, url, ms = 25000) => {
  const readUrl = () => (typeof url === "function" ? url() : url);
  const deadline = Date.now() + ms;
  let last = assessDocument(doc, readUrl());
  while (Date.now() < deadline) {
    scrollToHeading(doc, "Profile summary");
    scrollToHeading(doc, "Resume headline");
    last = assessDocument(doc, readUrl());
    if (last.status === "ready" || last.status === "action_required") return last;
    await sleep(400);
  }
  return last;
};

const editorScope = (field) =>
  (typeof field.closest === "function" &&
    field.closest(".lightbox, .modal, .sDrawer, .editor")) ||
  field.parentElement ||
  field;

const findScopedSave = (scope) => {
  const buttons = [...scope.querySelectorAll("button")].filter(
    (el) => isVisible(el) && !el.disabled && /^save$/i.test(textOf(el)),
  );
  if (buttons.length !== 1) {
    return { ok: false, code: "SELECTOR", message: "Profile layout could not be verified." };
  }
  return { ok: true, el: buttons[0] };
};

const findResumeInput = (root) => {
  const nodes = [...root.querySelectorAll("#attachCV")].filter(
    (el) => (el.getAttribute?.("type") || "file").toLowerCase() === "file",
  );
  if (nodes.length !== 1) {
    return { ok: false, code: "SELECTOR", message: "Profile layout could not be verified." };
  }
  return { ok: true, el: nodes[0] };
};

const confirmButton = (button) =>
  isVisible(button) && !button.disabled && /yes,?\s*upload|replace|update/i.test(textOf(button));

const findUploadConfirm = (root) => {
  const dialogs = [...root.querySelectorAll(".lightbox, .modal, .sDrawer, [role='dialog']")];
  const scoped = [];
  for (const dialog of dialogs) {
    for (const button of dialog.querySelectorAll("button")) {
      if (confirmButton(button)) scoped.push(button);
    }
  }
  const buttons = scoped.length
    ? scoped
    : [...root.querySelectorAll("button")].filter(confirmButton);
  if (buttons.length > 1) {
    return { ok: false, code: "SELECTOR", message: "Profile layout could not be verified." };
  }
  return { ok: true, el: buttons[0] || null };
};

const visibleWordError = (scope) =>
  [...scope.querySelectorAll("span, div, p, label")].find(
    (el) =>
      isVisible(el) && /minimum\s+\d+\s+words\s+are\s+required/i.test(el.textContent || ""),
  ) || null;

const setNativeValue = (el, value) => {
  const Ctor = typeof HTMLTextAreaElement !== "undefined" ? HTMLTextAreaElement : null;
  const proto = Ctor && el instanceof Ctor ? Ctor.prototype : null;
  const setter = proto && Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  const EventCtor = typeof Event !== "undefined" ? Event : null;
  if (EventCtor && typeof el.dispatchEvent === "function") {
    el.dispatchEvent(new EventCtor("input", { bubbles: true }));
    el.dispatchEvent(new EventCtor("change", { bubbles: true }));
  }
};

const readUploadSnapshot = (root) => {
  const text = textOf(root.body || root);
  const nameNode = root.querySelector?.("[data-resume-name]");
  return {
    text,
    visibleName: nameNode ? textOf(nameNode) : "",
    signalId: root.querySelector?.("[data-upload-signal]")?.getAttribute?.("data-upload-signal") || "",
    freshSignal: false,
  };
};

module.exports = {
  SELECTORS,
  PROFILE_URL,
  textOf,
  isVisible,
  queryUnique,
  findLabeledEdit,
  classifyLocation,
  assessDocument,
  scrollToHeading,
  waitForProfile,
  editorScope,
  findScopedSave,
  findResumeInput,
  findUploadConfirm,
  visibleWordError,
  setNativeValue,
  readUploadSnapshot,
};

}};
__m["shared/bump.js"]= {fn:function(module,exports,require){
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

/**
 * True when the profile's resume was uploaded today.
 * Parses the date that directly follows "Uploaded on".
 */
const uploadedToday = (text, now = new Date()) => {
  const m =
    /Uploaded on\s*:?\s*([A-Za-z]{3,9})\s+0?(\d{1,2}),?\s+(\d{4})/i.exec(
      String(text),
    );
  if (!m) return false;
  const d = new Date(`${m[1]} ${m[2]}, ${m[3]}`);
  return !isNaN(d) && d.toDateString() === now.toDateString();
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

}};
__m["shared/filename.js"]= {fn:function(module,exports,require){
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

}};
__m["shared/slots.js"]= {fn:function(module,exports,require){
const MAX_SLOTS = 4;

/** Normalize HH:MM; returns null if invalid. */
const normalizeSlot = (raw) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw || "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
};

/**
 * Dedupe + cap at 4 sorted slots. Throws if any slot is invalid.
 * Desktop contract: duplicates are dropped, extras beyond 4 are dropped.
 */
const normalizeSlots = (slots) => {
  const list = Array.isArray(slots) ? slots : [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const s = normalizeSlot(raw);
    if (!s) throw new Error(`invalid time slot: ${raw}`);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= MAX_SLOTS) break;
  }
  return out.sort();
};

/**
 * Extension custom times: reject invalid, duplicate, and more than 4.
 * Does not silently drop duplicates.
 */
const parseCustomSlots = (slots) => {
  const list = Array.isArray(slots) ? slots : [];
  if (list.length > MAX_SLOTS) throw new Error("At most 4 times");
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const s = normalizeSlot(raw);
    if (!s) throw new Error(`invalid time slot: ${raw}`);
    if (seen.has(s)) throw new Error(`duplicate time slot: ${s}`);
    seen.add(s);
    out.push(s);
  }
  return out.sort();
};

/** Local HH:MM for a Date in the runtime's local zone. */
const currentHhMm = (now = new Date()) =>
  `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

/** YYYY-MM-DD local. */
const currentDayKey = (now = new Date()) => {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

/**
 * Which slots should fire now and have not already fired today.
 * `firedKeys` is a Set of `${day}|${HH:MM}`.
 */
const slotsDueNow = (slots, firedKeys, now = new Date()) => {
  const hhmm = currentHhMm(now);
  const day = currentDayKey(now);
  return normalizeSlots(slots).filter((s) => {
    if (s !== hhmm) return false;
    return !firedKeys.has(`${day}|${s}`);
  });
};

/**
 * Fired-keys to pre-mark when slots are saved: slots newly added/edited whose time is
 * already past or is the current minute. They are skipped for today and first run tomorrow,
 * so adding or editing a time never triggers an unneeded run.
 */
const passedNewSlotKeys = (prevSlots, nextSlots, now = new Date()) => {
  const prev = new Set(normalizeSlots(prevSlots));
  const hhmm = currentHhMm(now);
  const day = currentDayKey(now);
  return normalizeSlots(nextSlots)
    .filter((s) => !prev.has(s) && s <= hhmm)
    .map((s) => `${day}|${s}`);
};

/**
 * Next upcoming slot today or tomorrow (for UI display).
 * Returns { day, slot } or null.
 */
const nextSlotAfter = (slots, now = new Date()) => {
  const sorted = normalizeSlots(slots);
  if (!sorted.length) return null;
  const hhmm = currentHhMm(now);
  const today = currentDayKey(now);
  for (const s of sorted) {
    if (s > hhmm) return { day: today, slot: s };
  }
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return { day: currentDayKey(tomorrow), slot: sorted[0] };
};

/**
 * Build up to 4 daily slots every `intervalHours` starting at `startHhMm`.
 * Desktop contract: wraps past midnight (e.g. 20:00 + 4h → 00:00).
 */
const slotsEveryHours = (startHhMm, intervalHours = 4) => {
  const start = normalizeSlot(startHhMm);
  if (!start) throw new Error(`invalid start time: ${startHhMm}`);
  const step = Number(intervalHours);
  if (!Number.isFinite(step) || step <= 0) {
    throw new Error(`invalid interval hours: ${intervalHours}`);
  }
  const [h0, m0] = start.split(":").map(Number);
  const out = [];
  for (let i = 0; i < MAX_SLOTS; i++) {
    const total = h0 * 60 + m0 + Math.round(i * step * 60);
    const hh = ((Math.floor(total / 60) % 24) + 24) % 24;
    const mm = ((total % 60) + 60) % 60;
    out.push(`${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`);
  }
  return normalizeSlots(out);
};

/**
 * Extension interval mode: anchor + 0/4/8/12 hours, stop before local midnight.
 * Does not wrap. 09:00 → 4 slots, 15:00 → 3, 23:59 → 1.
 */
const anchorSlots = (startHhMm) => {
  const start = normalizeSlot(startHhMm);
  if (!start) throw new Error(`invalid start time: ${startHhMm}`);
  const [h0, m0] = start.split(":").map(Number);
  const out = [];
  for (let i = 0; i < MAX_SLOTS; i++) {
    const total = h0 * 60 + m0 + i * 240;
    if (total >= 24 * 60) break;
    const hh = Math.floor(total / 60);
    const mm = total % 60;
    out.push(`${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`);
  }
  return out;
};

module.exports = {
  MAX_SLOTS,
  normalizeSlot,
  normalizeSlots,
  parseCustomSlots,
  currentHhMm,
  currentDayKey,
  slotsDueNow,
  passedNewSlotKeys,
  nextSlotAfter,
  slotsEveryHours,
  anchorSlots,
};

}};
__m["shared/time.js"]= {fn:function(module,exports,require){
/** Calendar and time-zone helpers. Dates are passed in; nothing reads the clock implicitly except the default zone name. */

const systemTimeZone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const localParts = (date, timeZone = systemTimeZone()) => {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const bag = {};
  for (const part of fmt.formatToParts(date)) bag[part.type] = part.value;
  let hour = bag.hour === "24" ? "00" : bag.hour;
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    dayNum: Number(bag.day),
    day: `${bag.year}-${bag.month}-${bag.day}`,
    hhmm: `${hour}:${bag.minute}`,
    hour: Number(hour),
    minute: Number(bag.minute),
  };
};

/** Add calendar days to a YYYY-MM-DD key. Not an instant plus 86_400_000 ms. */
const addCalendarDays = (day, delta) => {
  const [y, m, d] = String(day).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
};

const slotKey = (day, hhmm) => `${day}|${hhmm}`;

/**
 * UTC epoch for a local civil time. Returns the matching instant when one exists.
 * Nonexistent DST times do not round-trip; callers must check localTimeExists.
 */
const epochFromLocal = (day, hhmm, timeZone = systemTimeZone()) => {
  const [year, month, dayNum] = day.split("-").map(Number);
  const [hour, minute] = hhmm.split(":").map(Number);
  let guess = Date.UTC(year, month - 1, dayNum, hour, minute, 0);
  for (let i = 0; i < 6; i++) {
    const parts = localParts(new Date(guess), timeZone);
    const asUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.dayNum,
      parts.hour,
      parts.minute,
      0,
    );
    const want = Date.UTC(year, month - 1, dayNum, hour, minute, 0);
    const diff = want - asUtc;
    if (diff === 0) return guess;
    guess += diff;
  }
  return guess;
};

const localTimeExists = (day, hhmm, timeZone = systemTimeZone()) => {
  const epoch = epochFromLocal(day, hhmm, timeZone);
  const parts = localParts(new Date(epoch), timeZone);
  return parts.day === day && parts.hhmm === hhmm;
};

const zoneSignature = (date, timeZone = systemTimeZone()) => {
  let offset = "";
  try {
    offset = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "shortOffset",
      hour: "2-digit",
    })
      .formatToParts(date)
      .filter((p) => p.type === "timeZoneName")
      .map((p) => p.value)
      .join("");
  } catch {
    offset = "";
  }
  return `${timeZone}|${offset}`;
};

module.exports = {
  systemTimeZone,
  localParts,
  addCalendarDays,
  slotKey,
  epochFromLocal,
  localTimeExists,
  zoneSignature,
};

}};
__m["shared/schedule.js"]= {fn:function(module,exports,require){
/** Scheduling plans. Pure: no Chrome alarms, no mutation of inputs. */

const { anchorSlots } = __req("shared/slots.js");
const {
  localParts,
  addCalendarDays,
  epochFromLocal,
  localTimeExists,
  systemTimeZone,
} = __req("shared/time.js");

const HANDLED_SLOT_STATES = new Set([
  "success",
  "failed_final",
  "skipped_past_on_config",
  "skipped_coalesced",
  "skipped_overlap",
  "skipped_paused",
  "skipped_cooldown",
]);

const MAX_ATTEMPTS = 2;
const RECONCILE_MS = 15 * 60 * 1000;

const effectiveSlots = (settings) => {
  if (!settings) return [];
  if (settings.scheduleMode === "interval") {
    try {
      return anchorSlots(settings.intervalAnchor || "09:00");
    } catch {
      return [];
    }
  }
  return Array.isArray(settings.customSlots) ? [...settings.customSlots] : [];
};

const isHandled = (record) =>
  !!record && HANDLED_SLOT_STATES.has(record.state);

const eligibleRecord = (record) => {
  if (!record) return true;
  if (isHandled(record)) return false;
  if ((record.attempts || 0) >= MAX_ATTEMPTS) return false;
  if (record.state === "unverified" || record.state === "conflict") return false;
  if (record.state === "running") return false;
  return true;
};

/**
 * Latest eligible same-day slot, plus earlier missed keys.
 * Does not mutate `records`. Earlier keys are marked by the caller only after a mutation starts.
 */
const catchUpPlan = ({
  now,
  timeZone = systemTimeZone(),
  effectiveSlots: slots = [],
  enabled = false,
  records = {},
  pauseDay = null,
  activeRun = null,
} = {}) => {
  const parts = localParts(now, timeZone);
  const base = { day: parts.day, hhmm: parts.hhmm, earlierMissed: [], selected: null };
  if (!enabled) return { ...base, reason: "disabled" };
  if (pauseDay && pauseDay === parts.day) return { ...base, reason: "paused" };

  const due = [];
  for (const slot of slots) {
    if (slot > parts.hhmm) continue;
    const key = `${parts.day}|${slot}`;
    const record = records[key];
    if (!eligibleRecord(record)) continue;
    due.push({ slot, key, attempts: record?.attempts || 0 });
  }
  due.sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
  if (!due.length) return { ...base, reason: "none" };
  const selected = due[due.length - 1];
  const earlierMissed = due.slice(0, -1).map((row) => row.key);
  if (activeRun) {
    return {
      ...base,
      selected: null,
      deferred: selected.key,
      earlierMissed: [],
      reason: "active_run",
    };
  }
  return {
    ...base,
    selected: selected.key,
    earlierMissed,
    reason: "eligible",
  };
};

/**
 * Newly added slots at or before the current minute are skipped for today.
 * Existing records, including handled ones, are kept. Unchanged slots are not rewritten.
 */
const markPastOnConfig = ({
  prevSlots = [],
  nextSlots = [],
  records = {},
  now,
  timeZone = systemTimeZone(),
} = {}) => {
  const parts = localParts(now, timeZone);
  const prev = new Set(prevSlots);
  const next = { ...records };
  for (const slot of nextSlots) {
    if (prev.has(slot)) continue;
    const key = `${parts.day}|${slot}`;
    if (next[key]) continue;
    if (slot <= parts.hhmm) {
      next[key] = { state: "skipped_past_on_config", attempts: 0 };
    }
  }
  return next;
};

const pruneSlotRecords = (records = {}, today, keepDays = 14) => {
  const cutoff = addCalendarDays(today, -(keepDays - 1));
  const out = {};
  for (const [key, value] of Object.entries(records)) {
    const day = String(key).split("|")[0];
    if (day >= cutoff) out[key] = value;
  }
  return out;
};

const nextFutureSlot = (slots, records, now, timeZone) => {
  const parts = localParts(now, timeZone);
  const sorted = [...slots].sort();
  for (const slot of sorted) {
    if (slot <= parts.hhmm) continue;
    if (!localTimeExists(parts.day, slot, timeZone)) continue;
    const key = `${parts.day}|${slot}`;
    if (isHandled(records[key])) continue;
    return { slotKey: key, when: epochFromLocal(parts.day, slot, timeZone) };
  }
  if (!sorted.length) return null;
  const tomorrow = addCalendarDays(parts.day, 1);
  const slot = sorted[0];
  if (!localTimeExists(tomorrow, slot, timeZone)) return null;
  return {
    slotKey: `${tomorrow}|${slot}`,
    when: epochFromLocal(tomorrow, slot, timeZone),
  };
};

const planAlarms = ({
  enabled = false,
  pauseDay = null,
  slots = [],
  records = {},
  now,
  timeZone = systemTimeZone(),
  scheduleRevision = 0,
  activeRun = null,
} = {}) => {
  const alarms = [];
  const parts = localParts(now, timeZone);
  if (activeRun && !activeRun.revoked) {
    const beat = Date.parse(activeRun.heartbeatAt || activeRun.startedAt || now.toISOString());
    alarms.push({
      name: "npu:watchdog",
      when: beat + 30000,
      kind: "watchdog",
      scheduleRevision,
      timeZone,
      runId: activeRun.runId,
    });
  }
  if (!enabled) return alarms;
  if (pauseDay === parts.day) {
    const tomorrow = addCalendarDays(parts.day, 1);
    alarms.push({
      name: "npu:slot:next",
      when: epochFromLocal(tomorrow, "00:01", timeZone),
      kind: "resume",
      slotKey: `${tomorrow}|00:01`,
      scheduleRevision,
      timeZone,
    });
    return alarms;
  }
  const next = nextFutureSlot(slots, records, now, timeZone);
  if (next) {
    alarms.push({
      name: "npu:slot:next",
      when: next.when,
      kind: "slot",
      slotKey: next.slotKey,
      scheduleRevision,
      timeZone,
    });
  }
  alarms.push({
    name: "npu:reconcile",
    when: now.getTime() + RECONCILE_MS,
    periodInMinutes: 15,
    kind: "reconcile",
    scheduleRevision,
    timeZone,
  });
  return alarms;
};

const evaluateAlarm = (state, alarm, now, timeZone = systemTimeZone()) => {
  const meta = alarm || {};
  const name = meta.name || "";
  if (name && !name.startsWith("npu:")) return { type: "foreign" };
  if (name === "npu:watchdog") return { type: "watchdog" };
  if (
    meta.scheduleRevision != null &&
    meta.scheduleRevision !== state.scheduleRevision
  ) {
    return { type: "stale" };
  }
  if (meta.timeZone && meta.timeZone !== timeZone) return { type: "zone_change" };
  const today = localParts(now, timeZone).day;
  if (meta.slotKey) {
    const day = meta.slotKey.split("|")[0];
    if (day < today) return { type: "prior_day" };
  }
  if (name === "npu:reconcile" || meta.kind === "reconcile") return { type: "reconcile" };
  if (meta.kind === "resume") return { type: "resume" };
  return { type: "fire", slotKey: meta.slotKey || null };
};

/** steady | forward_jump | backward_jump */
const clockEvent = (previousIso, now) => {
  if (!previousIso) return "unknown";
  const delta = now.getTime() - Date.parse(previousIso);
  if (Number.isNaN(delta)) return "unknown";
  if (delta > 20 * 60 * 1000) return "forward_jump";
  if (delta < -60 * 1000) return "backward_jump";
  return "steady";
};

const pauseRemaining = (records, slots, day, hhmm) => {
  const next = { ...records };
  for (const slot of slots) {
    const key = `${day}|${slot}`;
    if (isHandled(next[key])) continue;
    next[key] = {
      state: "skipped_paused",
      attempts: next[key]?.attempts || 0,
    };
  }
  return next;
};

const resumeFutureToday = (records, slots, day, hhmm) => {
  const next = { ...records };
  for (const slot of slots) {
    const key = `${day}|${slot}`;
    if (next[key]?.state === "skipped_paused" && slot > hhmm) delete next[key];
  }
  return next;
};

module.exports = {
  HANDLED_SLOT_STATES,
  MAX_ATTEMPTS,
  RECONCILE_MS,
  effectiveSlots,
  isHandled,
  catchUpPlan,
  markPastOnConfig,
  pruneSlotRecords,
  planAlarms,
  evaluateAlarm,
  clockEvent,
  pauseRemaining,
  resumeFutureToday,
  nextFutureSlot,
};

}};
__m["shared/pdf.js"]= {fn:function(module,exports,require){
/** PDF screening. Format check only — not malware scanning. */

const PDF_MAX_BYTES = 6000000;

const headerText = (bytes) => {
  if (!bytes) return "";
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const n = Math.min(u8.length, 1024);
  let out = "";
  for (let i = 0; i < n; i++) out += String.fromCharCode(u8[i]);
  return out;
};

const mimeAllowed = (mime) => {
  if (mime == null) return true;
  const m = String(mime).trim().toLowerCase();
  if (!m) return true;
  return (
    m === "application/pdf" ||
    m === "application/x-pdf" ||
    m === "application/octet-stream" ||
    m === "application/binary"
  );
};

/**
 * Accept only a non-empty PDF of at most 6_000_000 bytes.
 * User-facing rejection text is always the exact required sentence.
 */
const screenPdf = ({ name, byteLength, mime, header } = {}) => {
  const fail = (detail) => ({
    ok: false,
    message: "Choose a PDF under 6 MB",
    detail,
  });
  const fileName = String(name || "");
  if (!fileName.toLowerCase().endsWith(".pdf")) return fail("Use a .pdf file.");
  const size = Number(byteLength);
  if (!Number.isFinite(size) || size <= 0) return fail("The file is empty.");
  if (size > PDF_MAX_BYTES) return fail("The file is larger than 6 MB.");
  if (!mimeAllowed(mime)) return fail("The file type is not a PDF.");
  if (!headerText(header).includes("%PDF-")) {
    return fail("The file does not look like a PDF.");
  }
  return { ok: true };
};

const resumeMetaFrom = (record) => {
  if (!record) return null;
  return {
    originalName: String(record.name || "resume.pdf"),
    size: Number(record.byteLength || record.size || 0),
    mime: record.mime ? String(record.mime) : "",
    revision: Number(record.revision || 0),
    selectedAt: record.selectedAt || null,
  };
};

/**
 * IndexedDB is the authority. If metadata lagged a successful byte write, adopt the record.
 * Missing or corrupt bytes block upload until the user picks a file again.
 */
const reconcileResume = (meta, record) => {
  if (!record) {
    if (!meta) return { meta: null, status: "empty" };
    return {
      meta: null,
      status: "missing",
      message: "Saved resume is unavailable. Please select it again.",
    };
  }
  const headerOk =
    record.headerOk === true ||
    headerText(record.header).includes("%PDF-");
  const size = Number(record.byteLength || record.size || 0);
  if (!headerOk || size <= 0 || size > PDF_MAX_BYTES) {
    return {
      meta: null,
      status: "corrupt",
      message: "Saved resume is unavailable. Please select it again.",
    };
  }
  const aligned = resumeMetaFrom(record);
  if (!meta || meta.revision !== aligned.revision || meta.size !== aligned.size) {
    return { meta: aligned, status: "reconciled" };
  }
  return { meta, status: "ok" };
};

module.exports = {
  PDF_MAX_BYTES,
  screenPdf,
  resumeMetaFrom,
  reconcileResume,
  headerText,
};

}};
__m["shared/text.js"]= {fn:function(module,exports,require){
/** Redaction, bounds, and tiny hashing. No profile or PDF contents in logs. */

const LOG_MAX_BYTES = 20 * 1024;
const HISTORY_MAX = 50;
const HISTORY_MAX_BYTES = 128 * 1024;

const utf8Size = (value) => new TextEncoder().encode(String(value)).length;

const fnv1a = (value) => {
  let hash = 0x811c9dc5;
  const text = String(value ?? "");
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
};

const redact = (input) => {
  let text = String(input ?? "");
  text = text.replace(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    "[redacted-email]",
  );
  text = text.replace(/\b\d{10,}\b/g, "[redacted-number]");
  text = text.replace(/%PDF-[\s\S]{0,80}/g, "[redacted-pdf]");
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  if (text.length > 400) text = `${text.slice(0, 400)}…`;
  return text;
};

const escapeText = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[ch],
  );

const appendLog = (existing, line, maxBytes = LOG_MAX_BYTES) => {
  const safe = redact(line);
  let next = existing ? `${existing}\n${safe}` : safe;
  while (utf8Size(next) > maxBytes) {
    const cut = next.indexOf("\n");
    if (cut === -1) {
      next = next.slice(Math.max(0, next.length - 200));
      break;
    }
    next = next.slice(cut + 1);
  }
  return next;
};

const pushHistory = (history, item, maxItems = HISTORY_MAX, maxBytes = HISTORY_MAX_BYTES) => {
  const list = Array.isArray(history) ? history : [];
  const next = [item, ...list.filter((row) => row && row.runId !== item.runId)];
  const capped = next.slice(0, maxItems);
  while (utf8Size(JSON.stringify(capped)) > maxBytes && capped.length > 1) {
    capped.pop();
  }
  return capped;
};

module.exports = {
  LOG_MAX_BYTES,
  HISTORY_MAX,
  HISTORY_MAX_BYTES,
  utf8Size,
  fnv1a,
  redact,
  escapeText,
  appendLog,
  pushHistory,
};

}};
__m["extension/src/engine.js"]= {fn:function(module,exports,require){
/**
 * Extension state machine. The service worker is the only writer; this module is pure
 * so recovery, scheduling, and storage rules can be tested without Chrome.
 */

const { emptyCustomMessage, planFieldUpdate } = __req("shared/bump.js");
const { describeIdentity } = __req("shared/filename.js");
const { parseCustomSlots, normalizeSlot } = __req("shared/slots.js");
const {
  localParts,
  systemTimeZone,
  zoneSignature,
} = __req("shared/time.js");
const {
  HANDLED_SLOT_STATES,
  MAX_ATTEMPTS,
  effectiveSlots,
  catchUpPlan,
  markPastOnConfig,
  pruneSlotRecords,
  planAlarms,
  evaluateAlarm,
  clockEvent,
  pauseRemaining,
  resumeFutureToday,
} = __req("shared/schedule.js");
const { screenPdf, reconcileResume, resumeMetaFrom } = __req("shared/pdf.js");
const { appendLog, pushHistory, redact } = __req("shared/text.js");

const STALE_LEASE_MS = 10 * 60 * 1000;
const MAX_RUN_MS = 10 * 60 * 1000;
const COOLDOWN_MS = 10 * 60 * 1000;
const SCHEMA_VERSION = 2;

const STEP_LABELS = {
  headline: "Updating headline",
  summary: "Updating profile summary",
  resume: "Uploading resume",
};

const defaultSettings = () => ({
  bumpMode: "dot",
  customHeadlineText: "",
  customSummaryText: "",
  actions: { headline: true, summary: true, resume: true },
  firstName: "",
  lastName: "",
  role: "",
  scheduleEnabled: true,
  scheduleMode: "custom",
  customSlots: ["09:00", "11:30", "14:00", "16:00"],
  intervalAnchor: "09:00",
  revision: 1,
  pauseDay: null,
  termsAcknowledged: true,
  manualCooldown: false,
  accountConfirmed: true,
});

const defaultConnection = () => ({
  status: "not_connected",
  verifiedAt: null,
  accountRef: null,
  identityReliable: false,
});

const defaultState = () => ({
  schemaVersion: SCHEMA_VERSION,
  settings: defaultSettings(),
  resumeMeta: null,
  connection: defaultConnection(),
  slotRecords: {},
  activeRun: null,
  pendingJournal: null,
  suffixState: {},
  history: [],
  logTail: "",
  lastResult: null,
  lastSuccessCheckAt: null,
  lastConfirmedMutationAt: null,
  scheduleRevision: 1,
  automationSuspended: false,
  reviewRequired: false,
  runtime: {
    alarmMeta: [],
    lastClockAt: null,
    zoneSignature: null,
    lastBlockedNotice: null,
    resumeReleasedFor: null,
  },
});

const makeId = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `id-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
};

const selectedSteps = (settings) => {
  const actions = settings?.actions || {};
  const steps = [];
  if (actions.headline) steps.push("headline");
  if (actions.summary) steps.push("summary");
  if (actions.resume) steps.push("resume");
  return steps;
};

const boundString = (value, max = 2000) => {
  const text = String(value ?? "");
  return text.length > max ? null : text;
};

const clone = (value) => JSON.parse(JSON.stringify(value));

const migrate = (raw) => {
  const src = raw && typeof raw === "object" ? raw : {};
  const fresh = !src.schemaVersion && !src.settings && !src.firedKeys && !src.slotRecords;
  if (fresh) return defaultState();

  const state = defaultState();
  state.schemaVersion = SCHEMA_VERSION;
  state.settings = { ...defaultSettings(), ...(src.settings || {}) };
  state.settings.actions = {
    headline: state.settings.actions?.headline !== false,
    summary: state.settings.actions?.summary !== false,
    resume: state.settings.actions?.resume !== false,
  };
  state.settings.customSlots = Array.isArray(state.settings.customSlots)
    ? state.settings.customSlots
    : [];
  if (Number(src.schemaVersion || 0) < 2) {
    state.settings.scheduleEnabled = true;
    state.settings.termsAcknowledged = true;
    state.settings.accountConfirmed = true;
    if (!state.settings.customSlots.length) {
      state.settings.customSlots = ["09:00", "11:30", "14:00", "16:00"];
    }
  }
  state.resumeMeta = src.resumeMeta || null;
  state.connection = { ...defaultConnection(), ...(src.connection || {}) };
  state.slotRecords = { ...(src.slotRecords || {}) };
  const fired = Array.isArray(src.firedKeys) ? src.firedKeys : [];
  for (const key of fired) {
    if (!state.slotRecords[key]) {
      state.slotRecords[key] = { state: "success", attempts: 1, migrated: true };
    }
  }
  state.activeRun = src.activeRun || null;
  state.pendingJournal = src.pendingJournal || null;
  state.suffixState = src.suffixState || {};
  state.history = Array.isArray(src.history) ? src.history.slice(0, 50) : [];
  state.logTail = typeof src.logTail === "string" ? src.logTail : "";
  state.lastResult = src.lastResult || null;
  state.lastSuccessCheckAt = src.lastSuccessCheckAt || null;
  state.lastConfirmedMutationAt = src.lastConfirmedMutationAt || null;
  state.scheduleRevision = Number(src.scheduleRevision || state.settings.revision || 1);
  state.automationSuspended = !!src.automationSuspended;
  state.reviewRequired = !!src.reviewRequired;
  state.runtime = { ...state.runtime, ...(src.runtime || {}) };
  state.schemaVersion = SCHEMA_VERSION;
  return state;
};

const persistable = (state) => ({
  schemaVersion: state.schemaVersion,
  settings: state.settings,
  resumeMeta: state.resumeMeta,
  connection: state.connection,
  slotRecords: state.slotRecords,
  activeRun: state.activeRun,
  pendingJournal: state.pendingJournal,
  suffixState: state.suffixState,
  history: state.history,
  logTail: state.logTail,
  lastResult: state.lastResult,
  lastSuccessCheckAt: state.lastSuccessCheckAt,
  lastConfirmedMutationAt: state.lastConfirmedMutationAt,
  scheduleRevision: state.scheduleRevision,
  automationSuspended: state.automationSuspended,
  reviewRequired: state.reviewRequired,
  runtime: state.runtime,
});

const suffixBucketKey = (state) => {
  if (state.connection.identityReliable && state.connection.accountRef) {
    return state.connection.accountRef;
  }
  return "local";
};

const ownedSuffix = (state, step) =>
  state.suffixState?.[suffixBucketKey(state)]?.[step]?.suffix || "";

const rememberSuffix = (state, step, suffix) => {
  const key = suffixBucketKey(state);
  const bucket = { ...(state.suffixState[key] || {}) };
  bucket[step] = { suffix: suffix || "", at: new Date().toISOString() };
  return { ...state.suffixState, [key]: bucket };
};

const validateConfig = (state, trigger, confirmAccount) => {
  const settings = state.settings;
  const steps = selectedSteps(settings);
  if (!steps.length) {
    return { ok: false, code: "NO_ACTION", message: "Select at least one update action." };
  }
  if (steps.includes("headline") && settings.bumpMode === "custom" && !String(settings.customHeadlineText || "").trim()) {
    return { ok: false, code: "CUSTOM_EMPTY", message: emptyCustomMessage("headline") };
  }
  if (steps.includes("summary") && settings.bumpMode === "custom" && !String(settings.customSummaryText || "").trim()) {
    return { ok: false, code: "CUSTOM_EMPTY", message: emptyCustomMessage("summary") };
  }
  if (steps.includes("resume")) {
    if (!state.resumeMeta) {
      return { ok: false, code: "NO_PDF", message: "Choose a resume PDF before updating." };
    }
    const named = describeIdentity(settings, state.resumeMeta.originalName);
    if (!named.ok) return { ok: false, code: "IDENTITY", message: named.message };
  }
  if (trigger !== "manual") {
    if (!settings.termsAcknowledged) {
      return {
        ok: false,
        code: "TERMS",
        message: "Review the terms warning and confirm scheduling is allowed before enabling it.",
      };
    }
    if (!settings.scheduleEnabled) {
      return { ok: false, code: "SCHEDULE_OFF", message: "Schedule is off." };
    }
    if (state.connection.status === "session_expired" || state.connection.status === "awaiting_sign_in") {
      return { ok: false, code: "LOGIN", message: "Sign in to Naukri in this Chrome" };
    }
    if (!state.connection.identityReliable && !settings.accountConfirmed) {
      return { ok: false, code: "ACCOUNT", message: "Confirm the correct Naukri account." };
    }
    if (!settings.accountConfirmed && state.connection.status !== "connected_last_verified") {
      return { ok: false, code: "LOGIN", message: "Sign in to Naukri in this Chrome" };
    }
  } else if (!state.connection.identityReliable && !(confirmAccount || settings.accountConfirmed)) {
    return { ok: false, code: "ACCOUNT", message: "Confirm the correct Naukri account." };
  }
  if (state.connection.status === "account_changed") {
    return { ok: false, code: "ACCOUNT", message: "Confirm the correct Naukri account." };
  }
  return { ok: true, steps };
};

const scheduleGate = (settings, state) => {
  if (!settings.termsAcknowledged) {
    return {
      ok: false,
      code: "TERMS",
      message: "Review the terms warning and confirm scheduling is allowed before enabling it.",
    };
  }
  if (!effectiveSlots(settings).length) {
    return { ok: false, code: "NO_SLOTS", message: "Add a valid time before enabling the schedule." };
  }
  return validateConfig({ ...state, settings, connection: { ...state.connection, status: state.connection.status } }, "scheduled", false);
};

const leaseExpired = (run, now) => {
  if (!run) return false;
  const beat = Date.parse(run.heartbeatAt || run.startedAt);
  const start = Date.parse(run.startedAt);
  return now.getTime() - beat > STALE_LEASE_MS || now.getTime() - start > MAX_RUN_MS;
};

const blockedResult = (state, code, message, input) => {
  const timeZone = input.timeZone || systemTimeZone();
  const day = localParts(input.now, timeZone).day;
  const line = redact(`${code}: ${message}`);
  const duplicate = state.logTail.split("\n").includes(line);
  const logTail = duplicate ? state.logTail : appendLog(state.logTail, line);
  const lastResult = {
    status: "blocked",
    errorCode: code,
    message,
    at: input.now.toISOString(),
    trigger: input.trigger,
    slotKey: input.slotKey || null,
    runId: null,
  };
  const runtime = { ...state.runtime };
  const dedupeKey = `${day}|${code}|${input.slotKey || ""}`;
  const notify =
    input.trigger !== "manual" && runtime.lastBlockedNotice !== dedupeKey;
  if (notify) runtime.lastBlockedNotice = dedupeKey;
  return {
    ok: false,
    code,
    message,
    notify: notify ? notificationFor(lastResult, input.trigger) : null,
    state: { ...state, logTail, lastResult, runtime },
  };
};

const cooldownHit = (state, now) => {
  if (!state.settings.manualCooldown || !state.lastConfirmedMutationAt) return false;
  const delta = now.getTime() - Date.parse(state.lastConfirmedMutationAt);
  return delta >= 0 && delta <= COOLDOWN_MS;
};

const filenameFor = (state, now) => {
  const named = describeIdentity(
    state.settings,
    state.resumeMeta?.originalName || "",
    now,
  );
  return named.ok ? named.fileName : null;
};

const prepareRun = (state, input) => {
  const now = input.now;
  const timeZone = input.timeZone || systemTimeZone();
  const trigger = input.trigger || "manual";
  let current = state;

  if (input.chromeMajor != null && Number(input.chromeMajor) < 148) {
    return blockedResult(current, "BROWSER", "Update Chrome to version 148 or newer.", input);
  }

  if (current.activeRun) {
    const expired = leaseExpired(current.activeRun, now);
    if (input.liveRunner && expired) {
      return {
        ok: false,
        code: "ALREADY_ACTIVE",
        message: "A run is already in progress.",
        state: { ...current, activeRun: { ...current.activeRun, revoked: true } },
      };
    }
    if (!expired || input.liveRunner) {
      return {
        ok: false,
        code: "ALREADY_ACTIVE",
        message: "A run is already in progress.",
        state: current,
      };
    }
    if (current.pendingJournal?.uploadDispatched && !current.pendingJournal.resolved) {
      const closed = finishRun(
        current,
        {
          runId: current.activeRun.runId,
          status: "unverified",
          errorCode: "UPLOAD_UNVERIFIED",
          message: "Upload unverified",
        },
        now,
      );
      return {
        ok: false,
        code: "UNVERIFIED",
        message: "Upload unverified",
        state: { ...closed.state, reviewRequired: true },
      };
    }
    if (current.pendingJournal && !current.pendingJournal.resolved && current.activeRun.mutationStarted) {
      return {
        ok: false,
        code: "REVIEW",
        message: "Review unresolved update",
        state: { ...current, reviewRequired: true },
      };
    }
    current = { ...current, activeRun: null };
  }

  if (current.reviewRequired && trigger !== "retry") {
    return {
      ok: false,
      code: "REVIEW",
      message: "Review unresolved update",
      state: current,
    };
  }

  if (current.automationSuspended && trigger !== "manual") {
    return blockedResult(
      current,
      "ACTION_REQUIRED",
      "Action required — resolve on Naukri and resume manually.",
      input,
    );
  }

  const config = validateConfig(current, trigger, !!input.confirmAccount);
  if (!config.ok) return blockedResult(current, config.code, config.message, input);

  if (trigger !== "manual" && cooldownHit(current, now) && input.slotKey) {
    const slotRecords = {
      ...current.slotRecords,
      [input.slotKey]: {
        state: "skipped_cooldown",
        attempts: current.slotRecords[input.slotKey]?.attempts || 0,
      },
    };
    return {
      ok: false,
      code: "COOLDOWN",
      message: "Skipped; the same update just completed.",
      state: { ...current, slotRecords },
    };
  }

  if (input.slotKey) {
    const attempts = current.slotRecords[input.slotKey]?.attempts || 0;
    if (attempts >= MAX_ATTEMPTS) {
      const slotRecords = {
        ...current.slotRecords,
        [input.slotKey]: {
          ...(current.slotRecords[input.slotKey] || {}),
          state: "failed_final",
          attempts,
        },
      };
      return {
        ok: false,
        code: "RETRY_EXHAUSTED",
        message: "Resume upload failed.",
        state: { ...current, slotRecords },
      };
    }
  }

  const parts = localParts(now, timeZone);
  const run = {
    runId: input.runId || makeId(),
    trigger,
    slotKey: trigger === "manual" ? null : input.slotKey || null,
    earlierMissed: trigger === "manual" ? [] : input.earlierMissed || [],
    settingsRevision: current.settings.revision,
    scheduleRevision: current.scheduleRevision,
    resumeRevision: current.resumeMeta?.revision || null,
    accountRef: current.connection.accountRef || null,
    startedAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    localDay: parts.day,
    frozenAt: now.toISOString(),
    timeZone,
    stage: "preflight",
    mutationStarted: false,
    cancelRequested: false,
    revoked: false,
    pausedForFocus: false,
    steps: config.steps,
    stepState: Object.fromEntries(config.steps.map((step) => [step, "pending"])),
    currentStep: config.steps[0] || null,
    tabId: input.tabId || null,
    windowId: input.windowId || null,
    documentId: null,
    filename: config.steps.includes("resume") ? filenameFor(current, now) : null,
    mutated: false,
  };

  return { ok: true, state: { ...current, activeRun: run }, run };
};

const startupPlan = (state, now, timeZone = systemTimeZone()) => {
  const slots = effectiveSlots(state.settings);
  return catchUpPlan({
    now,
    timeZone,
    effectiveSlots: slots,
    enabled: state.settings.scheduleEnabled && !state.automationSuspended,
    records: state.slotRecords,
    pauseDay: state.settings.pauseDay,
    activeRun: state.activeRun,
  });
};

const commitMutation = (state, now) => {
  const run = state.activeRun;
  if (!run) return { ok: false, code: "NO_RUN", message: "Run interrupted", state };
  if (run.revoked || run.cancelRequested) {
    return {
      ok: false,
      code: "CANCELLED",
      message: "Run cancelled; completed changes may remain.",
      state,
    };
  }
  if (run.mutationStarted) return { ok: true, state };
  const slotRecords = { ...state.slotRecords };
  if (run.slotKey) {
    const prev = slotRecords[run.slotKey] || { attempts: 0 };
    slotRecords[run.slotKey] = {
      state: "running",
      attempts: (prev.attempts || 0) + 1,
      runId: run.runId,
    };
  }
  for (const key of run.earlierMissed || []) {
    const prev = slotRecords[key];
    if (!prev || !HANDLED_SLOT_STATES.has(prev.state)) {
      slotRecords[key] = {
        state: "skipped_coalesced",
        attempts: prev?.attempts || 0,
        runId: run.runId,
      };
    }
  }
  return {
    ok: true,
    state: {
      ...state,
      slotRecords,
      activeRun: {
        ...run,
        mutationStarted: true,
        stage: "editing",
        heartbeatAt: now.toISOString(),
      },
    },
  };
};

const sameRun = (state, runId) =>
  !!state.activeRun && state.activeRun.runId === runId && !state.activeRun.revoked;

const authorizeStep = (state, { runId, step, documentId, tabId } = {}) => {
  const run = state.activeRun;
  if (!run || run.runId !== runId) return { ok: false, state, ignored: true };
  if (run.revoked || run.cancelRequested) {
    return {
      ok: false,
      state,
      code: "CANCELLED",
      message: "Run cancelled; completed changes may remain.",
    };
  }
  if (run.pausedForFocus) return { ok: false, state, code: "PAUSED", message: "Run paused" };
  if (documentId && run.documentId && documentId !== run.documentId) {
    return { ok: false, state, ignored: true };
  }
  if (tabId && run.tabId && tabId !== run.tabId) return { ok: false, state, ignored: true };
  if (step !== run.currentStep) return { ok: false, state, code: "STEP", message: "Unexpected step" };
  return {
    ok: true,
    state: {
      ...state,
      activeRun: {
        ...run,
        stage: step,
        stepState: { ...run.stepState, [step]: "in_progress" },
      },
    },
  };
};

const noteIntent = (state, { runId, step, before, target, upload = false } = {}) => {
  if (!sameRun(state, runId)) return { ok: false, state, ignored: true };
  if (state.activeRun.cancelRequested) {
    return { ok: false, state, code: "CANCELLED", message: "Run cancelled; completed changes may remain." };
  }
  const run = state.activeRun;
  const journal = {
    ...(state.pendingJournal || {}),
    runId,
    localDay: run.localDay,
    settingsRevision: run.settingsRevision,
    resumeRevision: run.resumeRevision,
    accountRef: run.accountRef,
    resolved: false,
    steps: { ...(state.pendingJournal?.steps || {}) },
  };
  journal.steps[step] = {
    before: before == null ? null : String(before),
    target: target == null ? null : String(target),
    status: "intent",
  };
  if (upload) journal.uploadPrepared = true;
  return { ok: true, state: { ...state, pendingJournal: journal } };
};

const markUploadDispatched = (state, runId) => {
  if (!sameRun(state, runId) || !state.pendingJournal) return { ok: false, state };
  if (state.activeRun.cancelRequested) {
    return { ok: false, state, code: "CANCELLED", message: "Run cancelled; completed changes may remain." };
  }
  return {
    ok: true,
    state: {
      ...state,
      pendingJournal: { ...state.pendingJournal, uploadDispatched: true },
    },
  };
};

const advance = (run, step, status) => {
  const stepState = { ...run.stepState, [step]: status };
  const index = run.steps.indexOf(step);
  const nextStep = run.steps[index + 1] || null;
  return {
    ...run,
    stepState,
    currentStep: nextStep,
    stage: nextStep || "finishing",
    mutated: run.mutated || status === "verified",
  };
};

const noteStepResult = (state, { runId, step, status, suffix } = {}) => {
  if (!sameRun(state, runId)) return { ok: false, state, ignored: true };
  let next = state;
  if ((status === "verified" || status === "no_change") && suffix != null && step !== "resume") {
    next = { ...next, suffixState: rememberSuffix(next, step, suffix) };
  }
  if (next.pendingJournal?.steps?.[step]) {
    const journal = {
      ...next.pendingJournal,
      steps: {
        ...next.pendingJournal.steps,
        [step]: { ...next.pendingJournal.steps[step], status },
      },
    };
    next = { ...next, pendingJournal: journal };
  }
  const run = advance(next.activeRun, step, status);
  return { ok: true, state: { ...next, activeRun: run } };
};

const publicSteps = (run) => {
  const out = {};
  for (const step of run?.steps || []) out[step] = run.stepState?.[step] || "pending";
  return out;
};

const slotStateFor = (status) => {
  if (status === "success" || status === "no_changes") return "success";
  if (status === "failed_retryable") return "failed_retryable";
  if (status === "failed_final") return "failed_final";
  if (status === "blocked") return "blocked";
  if (status === "unverified") return "unverified";
  if (status === "conflict") return "conflict";
  if (status === "cancelled") return "cancelled";
  if (status === "interrupted") return "interrupted";
  return status;
};

const applyOverlap = (state, run, records) => {
  const next = { ...records };
  const day = run.localDay;
  for (const [key, rec] of Object.entries(next)) {
    if (!key.startsWith(`${day}|`) || key === run.slotKey) continue;
    if (rec && HANDLED_SLOT_STATES.has(rec.state)) continue;
    if (run.settingsRevision === state.settings.revision && run.accountRef === state.connection.accountRef) {
      next[key] = { state: "skipped_overlap", attempts: rec?.attempts || 0, runId: run.runId };
    }
  }
  return next;
};

const defaultStatusMessage = (status) => {
  switch (status) {
    case "success":
      return "Profile update completed";
    case "no_changes":
      return "No changes needed";
    case "failed_retryable":
    case "failed_final":
      return "Resume upload failed.";
    case "unverified":
      return "Upload unverified";
    case "conflict":
      return "Profile changed outside this run; review before retrying.";
    case "interrupted":
      return "Run interrupted";
    case "cancelled":
      return "Run cancelled; completed changes may remain.";
    case "blocked":
      return "Could not load or verify Naukri profile.";
    default:
      return "Profile update needs attention";
  }
};

const notificationFor = (result, trigger) => {
  if (!result || trigger === "manual") return null;
  if (result.status === "blocked") {
    return {
      title: "Profile update needs attention",
      message: redact(result.message || "Profile update needs attention"),
    };
  }
  const title =
    result.status === "success"
      ? "Profile update completed"
      : result.status === "no_changes"
        ? "No changes needed"
        : result.status === "unverified" || result.status === "conflict"
          ? "Profile update needs attention"
          : result.status === "failed_retryable" ||
              result.status === "failed_final" ||
              result.status === "interrupted"
            ? "Profile update failed"
            : "Profile update needs attention";
  return { title, message: redact(result.message || title) };
};

const finishRun = (state, result, now) => {
  const runId = result.runId || state.activeRun?.runId;
  if (state.history.some((row) => row.runId === runId)) {
    return { ok: true, state, duplicate: true, notify: null };
  }
  const run = state.activeRun;
  if (!run || run.runId !== runId) return { ok: false, state, ignored: true, notify: null };

  let status = result.status;
  const slotRecords = { ...state.slotRecords };
  if (run.slotKey && run.mutationStarted && slotRecords[run.slotKey]) {
    let slotState = slotStateFor(status);
    const attempts = slotRecords[run.slotKey].attempts || 0;
    if (attempts >= MAX_ATTEMPTS && status === "failed_retryable") {
      status = "failed_final";
      slotState = "failed_final";
    }
    if (status === "interrupted" || status === "cancelled") {
      slotState = status === "cancelled" ? "failed_retryable" : "failed_retryable";
      if (result.uncertain || state.pendingJournal?.uploadDispatched) {
        status = "unverified";
        slotState = "unverified";
      }
    }
    slotRecords[run.slotKey] = {
      state: slotState,
      attempts,
      runId: run.runId,
      reason: result.errorCode || null,
    };
  } else if (run.slotKey && !run.mutationStarted) {
    const prev = slotRecords[run.slotKey];
    if (prev?.state === "running") {
      slotRecords[run.slotKey] = { state: "pending", attempts: prev.attempts || 0, runId: run.runId };
    }
  }

  let records = slotRecords;
  if (status === "success") records = applyOverlap(state, run, slotRecords);

  const message = redact(result.message || defaultStatusMessage(status));
  const historyItem = {
    runId: run.runId,
    trigger: run.trigger,
    slotKey: run.slotKey,
    startedAt: run.startedAt,
    finishedAt: now.toISOString(),
    status,
    steps: { ...publicSteps(run), ...(result.steps || {}) },
    errorCode: result.errorCode || null,
    message,
  };
  const keepJournal =
    status === "unverified" ||
    status === "conflict" ||
    status === "failed_retryable" ||
    (status === "interrupted" && run.mutationStarted);
  let pendingJournal = keepJournal ? state.pendingJournal : null;
  if (pendingJournal) {
    pendingJournal = {
      runId: pendingJournal.runId,
      localDay: pendingJournal.localDay,
      settingsRevision: pendingJournal.settingsRevision,
      resumeRevision: pendingJournal.resumeRevision,
      accountRef: pendingJournal.accountRef,
      uploadDispatched: !!pendingJournal.uploadDispatched,
      resolved: false,
      steps: Object.fromEntries(
        Object.entries(pendingJournal.steps || {}).map(([key, value]) => [
          key,
          {
            status: value.status || "intent",
            before: value.before ?? null,
            target: value.target ?? null,
          },
        ]),
      ),
    };
  }
  const checked = status === "success" || status === "no_changes";
  const confirmed = status === "success" && (run.mutated || result.mutated);
  const runtime = { ...state.runtime };
  let notify = notificationFor({ status, message }, run.trigger);
  if (status === "blocked") {
    const key = `${run.localDay}|${result.errorCode || ""}|${run.slotKey || ""}`;
    if (runtime.lastBlockedNotice === key) notify = null;
    else runtime.lastBlockedNotice = key;
  }
  return {
    ok: true,
    notify,
    duplicate: false,
    state: {
      ...state,
      activeRun: null,
      slotRecords: records,
      pendingJournal,
      history: pushHistory(state.history, historyItem),
      lastResult: {
        status,
        errorCode: historyItem.errorCode,
        message,
        at: historyItem.finishedAt,
        runId: run.runId,
        trigger: run.trigger,
        slotKey: run.slotKey,
      },
      lastSuccessCheckAt: checked ? historyItem.finishedAt : state.lastSuccessCheckAt,
      lastConfirmedMutationAt: confirmed ? historyItem.finishedAt : state.lastConfirmedMutationAt,
      reviewRequired: status === "unverified" || status === "conflict",
      runtime,
      logTail: appendLog(state.logTail, `${status}${historyItem.errorCode ? ` ${historyItem.errorCode}` : ""}`),
    },
  };
};

const notePage = (state, { runId, assessment, documentId, tabId } = {}, now) => {
  if (!sameRun(state, runId)) return { ok: false, state, ignored: true };
  const run = {
    ...state.activeRun,
    documentId: documentId || state.activeRun.documentId,
    tabId: tabId || state.activeRun.tabId,
    heartbeatAt: now.toISOString(),
  };
  if (!assessment || assessment.status !== "ready") {
    const code = assessment?.code || "PAGE";
    const message = assessment?.message || "Could not load or verify Naukri profile.";
    let next = { ...state, activeRun: run, connection: { ...state.connection } };
    if (assessment?.status === "awaiting_sign_in" || assessment?.status === "session_expired") {
      next.connection = {
        ...next.connection,
        status: assessment.status,
        verifiedAt: null,
        identityReliable: false,
      };
    }
    if (assessment?.status === "action_required") {
      next.automationSuspended = true;
      next.connection = { ...next.connection, status: "action_required", verifiedAt: null };
    }
    const finished = finishRun(
      next,
      { runId, status: "blocked", errorCode: code, message },
      now,
    );
    return { ...finished, ok: false, code, message: message };
  }
  return { ok: true, state: { ...state, activeRun: { ...run, stage: "ready" } } };
};

const heartbeat = (state, { runId, now }) => {
  if (!state.activeRun || state.activeRun.runId !== runId) return { ok: false, state, ignored: true };
  if (leaseExpired(state.activeRun, now)) {
    return {
      ok: false,
      code: "EXPIRED",
      state: { ...state, activeRun: { ...state.activeRun, revoked: true } },
    };
  }
  return {
    ok: true,
    state: {
      ...state,
      activeRun: { ...state.activeRun, heartbeatAt: now.toISOString() },
    },
  };
};

const setFocus = (state, { runId, focused }) => {
  if (!sameRun(state, runId)) return { ok: false, state, ignored: true };
  return {
    ok: true,
    state: { ...state, activeRun: { ...state.activeRun, pausedForFocus: !focused } },
  };
};

const cancelRun = (state, now = new Date()) => {
  if (!state.activeRun) return { ok: false, state, message: "No active run." };
  const runId = state.activeRun.runId;
  const finished = finishRun(
    { ...state, activeRun: { ...state.activeRun, cancelRequested: true } },
    {
      runId,
      status: "cancelled",
      errorCode: "CANCELLED",
      message: "Run cancelled; completed changes may remain.",
      uncertain: !!state.pendingJournal?.uploadDispatched,
    },
    now,
  );
  return { ...finished, message: "Run cancelled; completed changes may remain." };
};

const onTabRemoved = (state, tabId, now) => {
  if (!state.activeRun || state.activeRun.tabId !== tabId) return { ok: true, state, ignored: true };
  const revoked = { ...state, activeRun: { ...state.activeRun, revoked: true } };
  return finishRun(
    revoked,
    {
      runId: state.activeRun.runId,
      status: "interrupted",
      errorCode: "TAB_CLOSED",
      message: "Run interrupted",
      uncertain: !!state.pendingJournal?.uploadDispatched,
    },
    now,
  );
};

const noteSlotDuringRun = (state, slotKey) => {
  if (!state.activeRun || !slotKey) return state;
  const prev = state.slotRecords[slotKey];
  if (prev && HANDLED_SLOT_STATES.has(prev.state)) return state;
  return {
    ...state,
    slotRecords: {
      ...state.slotRecords,
      [slotKey]: { state: "pending", attempts: prev?.attempts || 0, deferred: true },
    },
  };
};

const fieldPlanFor = (state, step, current, maxLen) => {
  const settings = state.settings;
  const mode = settings.bumpMode === "custom" ? "custom" : "dot";
  const customText = step === "summary" ? settings.customSummaryText : settings.customHeadlineText;
  return planFieldUpdate({
    current,
    mode,
    customText,
    ownedSuffix: ownedSuffix(state, step),
    maxLen,
    field: step,
  });
};

const releaseResume = (state, { runId, revision, step } = {}) => {
  const run = state.activeRun;
  if (!run || run.runId !== runId || run.revoked || run.cancelRequested) {
    return { ok: false, state };
  }
  if (step !== "resume" || run.currentStep !== "resume") return { ok: false, state };
  if (!state.resumeMeta || revision !== state.resumeMeta.revision) return { ok: false, state };
  if (run.resumeRevision !== state.resumeMeta.revision) return { ok: false, state };
  if (state.runtime.resumeReleasedFor === runId) return { ok: false, state };
  return {
    ok: true,
    state: {
      ...state,
      runtime: { ...state.runtime, resumeReleasedFor: runId },
    },
    fileName: run.filename,
  };
};

const classifyFailure = ({ mutationStarted = false, uploadDispatched = false, reason = "" } = {}) => {
  if (uploadDispatched || reason === "timeout_after_write") {
    return { status: "unverified", errorCode: "UPLOAD_UNVERIFIED", message: "cv upload did not stick" };
  }
  if (!mutationStarted) {
    return { status: "failed_retryable", errorCode: "NETWORK", message: "Could not load or verify Naukri profile." };
  }
  if (reason === "save_failed") {
    return { status: "failed_retryable", errorCode: "SAVE_FAILED", message: "field did not save" };
  }
  return { status: "unverified", errorCode: "UNCERTAIN", message: "Profile update needs attention" };
};

const judgeUpload = ({ before = {}, after = {}, filename } = {}) => {
  const fresh =
    after.freshSignal === true &&
    after.signalId &&
    after.signalId !== before.signalId;
  const nameOk = !!filename && after.visibleName === filename;
  const nameChanged = nameOk && before.visibleName !== filename;
  const stampChanged =
    !!before.uploadedLine && !!after.uploadedLine && before.uploadedLine !== after.uploadedLine;
  if ((fresh && (nameOk || after.timestampChanged === true)) || nameChanged || stampChanged) {
    return { status: "verified" };
  }
  return { status: "unverified", message: "cv upload did not stick" };
};

const commitSettings = (state, patch, baseRevision, now, timeZone = systemTimeZone()) => {
  if (baseRevision !== state.settings.revision) {
    return {
      ok: false,
      code: "STALE",
      message: "Settings changed in another view. Reload and try again.",
      saveState: "Error",
      state,
    };
  }
  const next = { ...state.settings };
  const schedulePatch = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (key === "revision" || key === "scheduleRevision") continue;
    if (
      key === "scheduleEnabled" ||
      key === "scheduleMode" ||
      key === "customSlots" ||
      key === "intervalAnchor" ||
      key === "pauseDay" ||
      key === "termsAcknowledged" ||
      key === "manualCooldown"
    ) {
      schedulePatch[key] = value;
    } else if (key === "actions" && value && typeof value === "object") {
      next.actions = {
        headline: value.headline !== false,
        summary: value.summary !== false,
        resume: value.resume !== false,
      };
    } else {
      next[key] = value;
    }
  }
  for (const key of ["customHeadlineText", "customSummaryText", "firstName", "lastName", "role", "bumpMode"]) {
    if (next[key] != null && boundString(next[key]) == null) {
      return {
        ok: false,
        code: "INVALID",
        message: "Could not save local extension data.",
        saveState: "Error",
        state,
      };
    }
  }
  if (next.bumpMode !== "dot" && next.bumpMode !== "custom") next.bumpMode = "dot";

  const prevSlots = effectiveSlots(state.settings);
  let slotsChanged = false;
  if (schedulePatch.customSlots !== undefined) {
    try {
      next.customSlots = parseCustomSlots(schedulePatch.customSlots);
      slotsChanged = true;
    } catch (err) {
      return { ok: false, code: "INVALID", message: err.message, saveState: "Error", state };
    }
  }
  if (schedulePatch.intervalAnchor !== undefined) {
    const anchor = normalizeSlot(schedulePatch.intervalAnchor);
    if (!anchor) {
      return {
        ok: false,
        code: "INVALID",
        message: `invalid time slot: ${schedulePatch.intervalAnchor}`,
        saveState: "Error",
        state,
      };
    }
    next.intervalAnchor = anchor;
    slotsChanged = true;
  }
  if (schedulePatch.scheduleMode !== undefined) {
    if (schedulePatch.scheduleMode !== "custom" && schedulePatch.scheduleMode !== "interval") {
      return { ok: false, code: "INVALID", message: "invalid schedule mode", saveState: "Error", state };
    }
    next.scheduleMode = schedulePatch.scheduleMode;
    slotsChanged = true;
  }
  if (schedulePatch.termsAcknowledged !== undefined) {
    next.termsAcknowledged = !!schedulePatch.termsAcknowledged;
  }
  if (schedulePatch.manualCooldown !== undefined) next.manualCooldown = !!schedulePatch.manualCooldown;
  if (schedulePatch.pauseDay !== undefined) next.pauseDay = schedulePatch.pauseDay;

  let warning = null;
  const slots = effectiveSlots(next);
  if (!slots.length) next.scheduleEnabled = false;
  if (schedulePatch.scheduleEnabled === true) {
    const gate = scheduleGate({ ...next, scheduleEnabled: true }, state);
    if (!gate.ok) {
      next.scheduleEnabled = false;
      warning = gate.message;
    } else next.scheduleEnabled = true;
  } else if (schedulePatch.scheduleEnabled === false) {
    next.scheduleEnabled = false;
  } else if (slotsChanged && !state.settings.scheduleEnabled && slots.length) {
    const gate = scheduleGate({ ...next, scheduleEnabled: true }, state);
    if (gate.ok) next.scheduleEnabled = true;
    else warning = gate.message;
  }

  next.revision = state.settings.revision + 1;
  const scheduleTouched =
    slotsChanged ||
    schedulePatch.scheduleEnabled !== undefined ||
    schedulePatch.pauseDay !== undefined ||
    schedulePatch.termsAcknowledged !== undefined ||
    schedulePatch.manualCooldown !== undefined;
  let scheduleRevision = state.scheduleRevision;
  let slotRecords = state.slotRecords;
  if (scheduleTouched) {
    scheduleRevision += 1;
    if (slotsChanged) {
      slotRecords = markPastOnConfig({
        prevSlots,
        nextSlots: effectiveSlots(next),
        records: slotRecords,
        now,
        timeZone,
      });
    }
  }
  const saved = {
    ...state,
    settings: next,
    scheduleRevision,
    slotRecords,
  };
  if (warning) {
    return { ok: false, code: "GATE", message: warning, saveState: "Error", state: saved };
  }
  return { ok: true, saveState: "Saved", state: saved };
};

const pauseToday = (state, now, timeZone = systemTimeZone()) => {
  const parts = localParts(now, timeZone);
  const slots = effectiveSlots(state.settings);
  return {
    ok: true,
    state: {
      ...state,
      settings: { ...state.settings, pauseDay: parts.day, revision: state.settings.revision + 1 },
      scheduleRevision: state.scheduleRevision + 1,
      slotRecords: pauseRemaining(state.slotRecords, slots, parts.day, parts.hhmm),
    },
  };
};

const resumeToday = (state, now, timeZone = systemTimeZone()) => {
  const parts = localParts(now, timeZone);
  const slots = effectiveSlots(state.settings);
  const sameDay = state.settings.pauseDay === parts.day;
  return {
    ok: true,
    state: {
      ...state,
      settings: { ...state.settings, pauseDay: null, revision: state.settings.revision + 1 },
      scheduleRevision: state.scheduleRevision + 1,
      slotRecords: sameDay
        ? resumeFutureToday(state.slotRecords, slots, parts.day, parts.hhmm)
        : state.slotRecords,
    },
  };
};

const clearActivity = (state) => ({ ...state, history: [], logTail: "" });

const resetAll = (state) => {
  if (state.activeRun) {
    return { ok: false, state, message: "Cancel the active run first." };
  }
  return { ok: true, state: defaultState(), clearResume: true, clearAlarms: true };
};

const removeResume = (state) => {
  if (state.activeRun) return { ok: false, state, message: "A run is already in progress." };
  return { ok: true, state: { ...state, resumeMeta: null }, clearResume: true };
};

const disconnectAccount = (state) => {
  if (state.activeRun) return { ok: false, state, message: "Cancel the active run first." };
  return {
    ok: true,
    state: {
      ...state,
      connection: defaultConnection(),
      settings: {
        ...state.settings,
        scheduleEnabled: false,
        accountConfirmed: false,
        revision: state.settings.revision + 1,
      },
      scheduleRevision: state.scheduleRevision + 1,
    },
  };
};

const noteConnection = (state, observed, now) => {
  const at = now.toISOString();
  if (!observed || observed.status !== "ready") {
    const status = observed?.status || "unable_to_verify";
    return {
      ...state,
      automationSuspended: status === "action_required" ? true : state.automationSuspended,
      connection: {
        ...state.connection,
        status,
        verifiedAt: null,
        identityReliable: false,
        accountRef: status === "account_changed" ? state.connection.accountRef : null,
      },
    };
  }
  if (!observed.identityReliable || !observed.accountRef) {
    return {
      ...state,
      connection: {
        status: "connected_last_verified",
        verifiedAt: at,
        identityReliable: false,
        accountRef: null,
      },
    };
  }
  if (state.connection.accountRef && state.connection.accountRef !== observed.accountRef) {
    return {
      ...state,
      reviewRequired: true,
      settings: { ...state.settings, scheduleEnabled: false },
      connection: {
        status: "account_changed",
        verifiedAt: at,
        identityReliable: true,
        accountRef: state.connection.accountRef,
      },
    };
  }
  return {
    ...state,
    connection: {
      status: "connected_last_verified",
      verifiedAt: at,
      identityReliable: true,
      accountRef: observed.accountRef,
    },
  };
};

const resumeAutomation = (state) => ({
  ...state,
  automationSuspended: false,
  connection:
    state.connection.status === "action_required"
      ? { ...state.connection, status: "not_connected", verifiedAt: null }
      : state.connection,
});

const discardJournal = (state) => {
  if (state.activeRun) return { ok: false, state, message: "Cancel the active run first." };
  return {
    ok: true,
    state: { ...state, pendingJournal: null, reviewRequired: false },
  };
};

const acceptPdfCandidate = (state, candidate) => {
  if (state.activeRun) {
    return { ok: false, state, message: "A run is already in progress." };
  }
  const screened = screenPdf(candidate);
  if (!screened.ok) {
    return { ok: false, state, message: screened.message, detail: screened.detail };
  }
  const revision = (state.resumeMeta?.revision || 0) + 1;
  const record = {
    name: candidate.name,
    byteLength: candidate.byteLength,
    mime: candidate.mime || "",
    header: candidate.header,
    revision,
    selectedAt: candidate.selectedAt || new Date().toISOString(),
  };
  return { ok: true, state, record, previous: state.resumeMeta };
};

const commitResumeMeta = (state, record) => ({
  ...state,
  resumeMeta: resumeMetaFrom(record),
});

const applyReconcile = (state, record) => {
  const result = reconcileResume(state.resumeMeta, record);
  return { ...result, state: { ...state, resumeMeta: result.meta } };
};

const pruneState = (state, now, timeZone = systemTimeZone()) => {
  const day = localParts(now, timeZone).day;
  return { ...state, slotRecords: pruneSlotRecords(state.slotRecords, day) };
};

const alarmPlanFor = (state, now, timeZone = systemTimeZone()) =>
  planAlarms({
    enabled: !!state.settings.scheduleEnabled && !state.automationSuspended,
    pauseDay: state.settings.pauseDay,
    slots: effectiveSlots(state.settings),
    records: state.slotRecords,
    now,
    timeZone,
    scheduleRevision: state.scheduleRevision,
    activeRun: state.activeRun,
  });

const rememberAlarms = (state, alarms, now, timeZone) => ({
  ...state,
  runtime: {
    ...state.runtime,
    alarmMeta: alarms,
    lastClockAt: now.toISOString(),
    zoneSignature: zoneSignature(now, timeZone),
  },
});

const decideAlarm = (state, alarmName, now, timeZone = systemTimeZone()) => {
  const meta = (state.runtime.alarmMeta || []).find((row) => row.name === alarmName) || {
    name: alarmName,
  };
  const decision = evaluateAlarm(state, meta, now, timeZone);
  const jump = clockEvent(state.runtime.lastClockAt, now);
  const zoneChanged =
    state.runtime.zoneSignature &&
    state.runtime.zoneSignature !== zoneSignature(now, timeZone);
  return { ...decision, jump, zoneChanged, meta };
};

const catchUpAllowed = (decision) => {
  if (!decision) return false;
  if (decision.type === "fire" || decision.type === "prior_day") return decision.type === "fire";
  if (decision.type === "stale") return false;
  if (decision.zoneChanged || decision.type === "zone_change") return true;
  if (decision.jump === "forward_jump" || decision.jump === "backward_jump") return true;
  if (decision.type === "reconcile" && decision.missingSlotAlarm) return true;
  return false;
};

const progressLabel = (run) => {
  if (!run?.steps?.length) return "";
  const total = run.steps.length || 1;
  const index = Math.max(0, run.steps.indexOf(run.currentStep));
  const step = run.currentStep || run.steps[run.steps.length - 1];
  const label = STEP_LABELS[step] || "Updating profile";
  return `${Math.min(total, index + 1)} of ${total}: ${label}`;
};

const todaySlots = (state, now, timeZone = systemTimeZone()) => {
  const parts = localParts(now, timeZone);
  return effectiveSlots(state.settings).map((slot) => {
    const key = `${parts.day}|${slot}`;
    const record = state.slotRecords[key];
    let status = "scheduled";
    if (record?.state) status = record.state;
    else if (slot <= parts.hhmm) status = "due";
    return { slot, key, status };
  });
};

const publicRun = (run) =>
  run && {
    runId: run.runId,
    trigger: run.trigger,
    slotKey: run.slotKey,
    stage: run.stage,
    currentStep: run.currentStep,
    steps: run.steps,
    stepState: run.stepState,
    startedAt: run.startedAt,
    cancelRequested: !!run.cancelRequested,
    pausedForFocus: !!run.pausedForFocus,
    progress: progressLabel(run),
    filename: run.filename,
    localDay: run.localDay,
  };

const journalSummary = (journal) =>
  journal && {
    runId: journal.runId,
    localDay: journal.localDay,
    uploadDispatched: !!journal.uploadDispatched,
    steps: Object.fromEntries(
      Object.entries(journal.steps || {}).map(([key, value]) => [key, value.status || "intent"]),
    ),
  };

const publicState = (state, now, timeZone = systemTimeZone(), version = "1.0.0") => ({
  version,
  settings: state.settings,
  resumeMeta: state.resumeMeta,
  connection: {
    status: state.connection.status,
    verifiedAt: state.connection.verifiedAt,
    identityReliable: !!state.connection.identityReliable,
    accountBound: !!state.connection.accountRef,
  },
  slotRecords: state.slotRecords,
  activeRun: publicRun(state.activeRun),
  history: state.history,
  logTail: state.logTail,
  lastResult: state.lastResult,
  lastSuccessCheckAt: state.lastSuccessCheckAt,
  lastConfirmedMutationAt: state.lastConfirmedMutationAt,
  reviewRequired: !!state.reviewRequired,
  automationSuspended: !!state.automationSuspended,
  journal: journalSummary(state.pendingJournal),
  scheduleRevision: state.scheduleRevision,
  today: todaySlots(state, now, timeZone),
  timeZone,
  effectiveSlots: effectiveSlots(state.settings),
  nextRun: (() => {
    const next = alarmPlanFor(state, now, timeZone).find(
      (alarm) => alarm.kind === "slot" || alarm.kind === "resume",
    );
    return next ? { slotKey: next.slotKey, when: next.when } : null;
  })(),
});

const runNowDisabled = (state) => {
  if (state.activeRun) return { disabled: true, reason: "A run is already in progress." };
  if (state.reviewRequired) return { disabled: true, reason: "Review unresolved update" };
  const config = validateConfig(state, "manual", state.settings.accountConfirmed);
  if (!config.ok) return { disabled: true, reason: config.message };
  return { disabled: false, reason: "" };
};

const chooseTab = (tabs, { preferredWindowId } = {}) => {
  const list = (tabs || []).filter((tab) => tab && !tab.incognito);
  const profile = list.filter((tab) => /\/mnjuser\/profile/.test(tab.url || ""));
  const pool = profile.length ? profile : [];
  if (!pool.length) return { tab: null, windowId: preferredWindowId || list.find((tab) => tab.active)?.windowId || null };
  const preferred = pool.find((tab) => tab.windowId === preferredWindowId);
  return { tab: preferred || pool[0], windowId: (preferred || pool[0]).windowId };
};

const recoverStartup = (state, { now, timeZone = systemTimeZone(), liveRunner = false, observed = {} } = {}) => {
  if (!state.activeRun) {
    if (state.pendingJournal && !state.pendingJournal.resolved) {
      const day = localParts(now, timeZone).day;
      if (state.pendingJournal.localDay !== day) {
        return { state: { ...state, reviewRequired: true }, action: "review" };
      }
    }
    return { state, action: "none" };
  }
  if (liveRunner) return { state, action: "reattach" };
  if (state.pendingJournal?.uploadDispatched) {
    const finished = finishRun(
      { ...state, activeRun: { ...state.activeRun, revoked: true } },
      {
        runId: state.activeRun.runId,
        status: "unverified",
        errorCode: "UPLOAD_UNVERIFIED",
        message: "Upload unverified",
        uncertain: true,
      },
      now,
    );
    return { state: { ...finished.state, reviewRequired: true }, action: "unverified" };
  }
  if (state.pendingJournal && state.activeRun.mutationStarted) {
    const day = localParts(now, timeZone).day;
    const journal = state.pendingJournal;
    const mismatch =
      journal.localDay !== day ||
      journal.settingsRevision !== state.settings.revision ||
      journal.accountRef !== state.connection.accountRef;
    if (mismatch) {
      return {
        state: { ...state, activeRun: null, reviewRequired: true },
        action: "review",
      };
    }
    const step = Object.keys(journal.steps || {}).find((key) => journal.steps[key].status === "intent");
    if (step && observed[step] != null) {
      const row = journal.steps[step];
      const { journalDecision } = __req("shared/bump.js");
      const decision = journalDecision({
        current: observed[step],
        before: row.before,
        target: row.target,
      });
      if (decision === "verified") {
        const noted = noteStepResult(state, { runId: state.activeRun.runId, step, status: "verified" });
        return { state: noted.state, action: "recovered" };
      }
      if (decision === "conflict") {
        return { state: { ...state, reviewRequired: true }, action: "review" };
      }
    }
    return { state, action: "retry_same" };
  }
  const finished = finishRun(
    state,
    {
      runId: state.activeRun.runId,
      status: "interrupted",
      errorCode: "INTERRUPTED",
      message: "Run interrupted",
    },
    now,
  );
  return { state: finished.state, action: "cleared" };
};

module.exports = {
  SCHEMA_VERSION,
  STALE_LEASE_MS,
  MAX_RUN_MS,
  COOLDOWN_MS,
  STEP_LABELS,
  defaultState,
  defaultSettings,
  migrate,
  persistable,
  selectedSteps,
  effectiveSlots,
  validateConfig,
  prepareRun,
  startupPlan,
  commitMutation,
  authorizeStep,
  noteIntent,
  markUploadDispatched,
  noteStepResult,
  finishRun,
  notePage,
  heartbeat,
  setFocus,
  cancelRun,
  onTabRemoved,
  noteSlotDuringRun,
  fieldPlanFor,
  releaseResume,
  classifyFailure,
  judgeUpload,
  commitSettings,
  pauseToday,
  resumeToday,
  clearActivity,
  resetAll,
  removeResume,
  disconnectAccount,
  noteConnection,
  resumeAutomation,
  discardJournal,
  acceptPdfCandidate,
  commitResumeMeta,
  applyReconcile,
  pruneState,
  alarmPlanFor,
  rememberAlarms,
  decideAlarm,
  catchUpAllowed,
  progressLabel,
  publicState,
  publicRun,
  runNowDisabled,
  todaySlots,
  chooseTab,
  recoverStartup,
  notificationFor,
  ownedSuffix,
  clone,
};

}};
__m["extension/src/runner.js"]= {fn:function(module,exports,require){
/** Bounded DOM steps. Stops on the first failed or uncertain step. No unofficial endpoints. */

const { normField } = __req("shared/bump.js");
const { fieldPlanFor, judgeUpload } = __req("extension/src/engine.js");
const {
  SELECTORS,
  queryUnique,
  findLabeledEdit,
  assessDocument,
  editorScope,
  findScopedSave,
  findResumeInput,
  findUploadConfirm,
  visibleWordError,
  setNativeValue,
  scrollToHeading,
  isVisible,
  textOf,
} = __req("extension/src/dom.js");

const fieldSelectors = {
  headline: { edit: SELECTORS.headlineEdit, field: SELECTORS.headlineField },
  summary: { edit: SELECTORS.summaryEdit, field: SELECTORS.summaryField },
};

let stopRequested = false;
const requestStop = () => {
  stopRequested = true;
};
const clearStop = () => {
  stopRequested = false;
};

const pageFocused = (doc) => {
  if (typeof doc.hasFocus === "function" && doc.hasFocus() === false) return false;
  if (doc.visibilityState && doc.visibilityState !== "visible") return false;
  return true;
};

const waitFocused = async (doc, ms = 1500) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pageFocused(doc)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return pageFocused(doc);
};

const fail = (code, message, extra = {}) => ({
  ok: false,
  status: extra.status || "failed",
  errorCode: code,
  message,
  ...extra,
});

async function runSteps(doc, { state, run, url, hooks }) {
  const assessment = assessDocument(doc, url);
  if (assessment.status !== "ready") {
    return {
      ok: false,
      status: "blocked",
      errorCode: assessment.code,
      message: assessment.message,
      assessment,
      mutated: false,
    };
  }
  const results = {};
  let currentState = state;
  for (const step of run.steps) {
    if (stopRequested || run.cancelRequested || currentState.activeRun?.cancelRequested) {
      return fail("CANCELLED", "Run cancelled; completed changes may remain.", {
        status: "cancelled",
        results,
        state: currentState,
      });
    }
    if (!(await waitFocused(doc))) {
      return fail("PAUSED", "Run paused", { status: "paused", results, state: currentState });
    }
    const auth = await hooks.authorize(step);
    if (!auth?.ok) {
      return fail(auth?.code || "AUTH", auth?.message || "Run interrupted", {
        status: auth?.code === "CANCELLED" ? "cancelled" : "interrupted",
        results,
        state: auth?.state || currentState,
      });
    }
    currentState = auth.state || currentState;
    if (step === "resume") {
      const uploaded = await uploadStep(doc, { run, state: currentState, hooks, results });
      if (!uploaded.ok) return { ...uploaded, results, state: uploaded.state || currentState };
      results.resume = uploaded.stepStatus;
      currentState = uploaded.state || currentState;
      continue;
    }
    const edited = await textStep(doc, { step, state: currentState, run, hooks });
    if (!edited.ok) return { ...edited, results, state: edited.state || currentState };
    results[step] = edited.missing ? "missing" : edited.stepStatus;
    currentState = edited.state || currentState;
  }
  const present = Object.values(results).filter((status) => status !== "missing");
  if (!present.length) {
    return fail("SELECTOR", "Profile layout could not be verified.", { results, state: currentState });
  }
  const statuses = present;
  const mutated = statuses.includes("verified");
  const status = mutated ? "success" : "no_changes";
  return {
    ok: true,
    status,
    mutated,
    results,
    state: currentState,
    message: status === "no_changes" ? "No changes needed" : "Profile update completed",
  };
}

const waitForField = async (doc, selectors) => {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (stopRequested) {
      return { ok: false, code: "CANCELLED", message: "Run cancelled; completed changes may remain." };
    }
    const hit = queryUnique(doc, selectors);
    if (hit.ok) return hit;
    const areas = [...doc.querySelectorAll("textarea")].filter((el) => isVisible(el));
    if (areas.length === 1) return { ok: true, el: areas[0] };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { ok: false, message: "Profile layout could not be verified." };
};

async function textStep(doc, { step, state, run, hooks }) {
  const label = step === "summary" ? "Profile summary" : "Resume headline";
  scrollToHeading(doc, label);
  const sels = fieldSelectors[step];
  const located = queryUnique(doc, sels.edit);
  const edit = located.ok ? located : findLabeledEdit(doc, label);
  if (!edit.ok) {
    const noted = await hooks.stepResult({ step, status: "no_change" });
    return { ok: true, stepStatus: "no_change", missing: true, state: noted?.state || state };
  }
  if (typeof edit.el.click === "function") edit.el.click();
  const fieldHit = await waitForField(doc, sels.field);
  if (!fieldHit.ok) {
    return fail(fieldHit.code || "SELECTOR", fieldHit.message, fieldHit.code === "CANCELLED" ? { status: "cancelled" } : {});
  }
  const field = fieldHit.el;
  const maxLen = Number(field.getAttribute?.("maxlength")) || undefined;
  const current = normField(field.value);
  const plan = fieldPlanFor(state, step, current, maxLen);
  if (plan.status === "invalid") return fail("CUSTOM_EMPTY", plan.message, { status: "blocked" });
  if (plan.status === "conflict") {
    return fail("CONFLICT", plan.message, { status: "conflict" });
  }
  const intent = await hooks.intent({
    step,
    before: current,
    target: plan.next,
  });
  if (!intent?.ok) {
    return fail(intent?.code || "AUTH", intent?.message || "Run interrupted", {
      status: intent?.code === "CANCELLED" ? "cancelled" : "interrupted",
    });
  }
  let nextState = intent.state || state;
  if (plan.status === "no_change") {
    const noted = await hooks.stepResult({
      step,
      status: "no_change",
      suffix: plan.ownedSuffix,
    });
    return { ok: true, stepStatus: "no_change", state: noted?.state || nextState };
  }
  setNativeValue(field, plan.next);
  if (normField(field.value) !== normField(plan.next)) {
    return fail("SAVE_FAILED", "field did not save", { status: "failed" });
  }
  const scope = editorScope(field);
  if (visibleWordError(scope) || visibleWordError(doc)) {
    return fail("WORD_COUNT", "field did not save", { status: "failed", stepFailed: step });
  }
  const save = findScopedSave(scope);
  if (!save.ok) return fail("SELECTOR", save.message);
  save.el.click();
  if (typeof doc.afterSave === "function") doc.afterSave(field, step);
  if (normField(field.value) !== normField(plan.next)) {
    return fail("SAVE_MISMATCH", "field did not save", { status: "failed", stepFailed: step });
  }
  const noted = await hooks.stepResult({
    step,
    status: "verified",
    suffix: plan.ownedSuffix,
  });
  return { ok: true, stepStatus: "verified", state: noted?.state || nextState };
}

const uploadView = (doc, filename) => {
  const text = textOf(doc.body || doc);
  const labeled = textOf(doc.querySelector?.("[data-resume-name]"));
  return {
    signalId: doc.querySelector?.("[data-upload-signal]")?.getAttribute?.("data-upload-signal") || "",
    visibleName: labeled || (filename && text.includes(filename) ? filename : ""),
    uploadedLine: (/Uploaded on\s*:?\s*[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}/i.exec(text) || [""])[0],
    freshSignal: doc.uploadFresh === true,
    timestampChanged: doc.uploadTimestampChanged === true,
  };
};

async function uploadStep(doc, { run, state, hooks, results }) {
  const input = findResumeInput(doc);
  if (!input.ok) return fail("SELECTOR", input.message);
  const before = uploadView(doc, run.filename);
  const intent = await hooks.intent({ step: "resume", before: before.visibleName, target: run.filename, upload: true });
  if (!intent?.ok) {
    return fail(intent?.code || "AUTH", intent?.message || "Run interrupted", {
      status: intent?.code === "CANCELLED" ? "cancelled" : "interrupted",
    });
  }
  const dispatched = await hooks.dispatched();
  if (!dispatched?.ok) {
    return fail(dispatched?.code || "AUTH", dispatched?.message || "Run interrupted", {
      status: dispatched?.code === "CANCELLED" ? "cancelled" : "interrupted",
    });
  }
  const file = await hooks.resumeFile();
  if (!file?.ok) return fail("NO_PDF", "Saved resume is unavailable. Please select it again.", { status: "blocked" });
  if (typeof hooks.assignFile === "function") hooks.assignFile(input.el, file.file);
  const confirm = findUploadConfirm(doc);
  if (!confirm.ok) return fail("SELECTOR", confirm.message);
  if (confirm.el) confirm.el.click();
  if (typeof doc.afterUpload === "function") doc.afterUpload();
  let after = uploadView(doc, run.filename);
  const deadline = Date.now() + 20000;
  while (!stopRequested && judgeUpload({ before, after, filename: run.filename }).status !== "verified" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    after = uploadView(doc, run.filename);
  }
  if (stopRequested) {
    return fail("CANCELLED", "Run cancelled; completed changes may remain.", {
      status: "cancelled",
      state: dispatched.state,
    });
  }
  const judged = judgeUpload({ before, after, filename: run.filename });
  if (judged.status !== "verified") {
    return fail("UPLOAD_UNVERIFIED", "cv upload did not stick", {
      status: "unverified",
      state: dispatched.state,
    });
  }
  const noted = await hooks.stepResult({ step: "resume", status: "verified" });
  return { ok: true, stepStatus: "verified", state: noted?.state || dispatched.state, results };
}

module.exports = { runSteps, pageFocused, requestStop, clearStop };

}};
__m["extension/src/file.js"]= {fn:function(module,exports,require){
/** Build a browser File for one authorized upload. */
const toUploadFile = (bytes, fileName) => {
  const blob = new Blob([bytes], { type: "application/pdf" });
  return new File([blob], fileName, { type: "application/pdf" });
};

module.exports = { toUploadFile };

}};
__m["extension/src/content.js"]= {fn:function(module,exports,require){
const { assessDocument, waitForProfile } = __req("extension/src/dom.js");
const { runSteps, requestStop, clearStop } = __req("extension/src/runner.js");
const { toUploadFile } = __req("extension/src/file.js");

const post = (message) => chrome.runtime.sendMessage(message);

const readHeader = async (bytes) => {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return u8.slice(0, 8);
};

const stateFromSteps = (steps) => {
  const settings = {
    bumpMode: "dot",
    customHeadlineText: "",
    customSummaryText: "",
    actions: { headline: false, summary: false, resume: false },
  };
  const suffix = {};
  let identityReliable = false;
  let accountRef = null;
  for (const step of steps) {
    settings.actions[step.step] = true;
    if (step.step === "headline" || step.step === "summary") {
      settings.bumpMode = step.mode || settings.bumpMode;
      if (step.step === "headline") settings.customHeadlineText = step.customText || "";
      if (step.step === "summary") settings.customSummaryText = step.customText || "";
      suffix[step.step] = { suffix: step.ownedSuffix || "" };
      identityReliable = !!step.identityReliable;
      accountRef = step.accountRef || null;
    }
  }
  const key = identityReliable && accountRef ? accountRef : "local";
  return {
    settings,
    suffixState: { [key]: suffix },
    connection: { identityReliable, accountRef },
  };
};

async function bindRun(doc, message) {
  const assessment = await waitForProfile(doc, () => doc.location?.href || "");
  const ready = await post({
    type: "RUN_READY",
    runId: message.runId,
    assessment,
  });
  if (!ready?.ok) return ready;
  const steps = message.steps || ready.steps || [];
  const timer = setInterval(() => {
    const focused = doc.visibilityState === "visible" && doc.hasFocus();
    void post({ type: "RUN_HEARTBEAT", runId: message.runId });
    void post({ type: "FOCUS_CHANGED", runId: message.runId, focused });
  }, 20000);
  let outcome;
  try {
  outcome = await runSteps(doc, {
    state: stateFromSteps(steps),
    run: {
      runId: message.runId,
      steps: steps.map((step) => step.step || step),
      filename: steps.find((step) => step.step === "resume")?.fileName || null,
      cancelRequested: false,
    },
    url: doc.location?.href || "",
    hooks: {
      authorize: (step) => post({ type: "REQUEST_STEP_AUTH", runId: message.runId, step }),
      intent: (body) => post({ type: "STEP_INTENT", runId: message.runId, ...body }),
      dispatched: () => post({ type: "STEP_INTENT", runId: message.runId, step: "resume", upload: true, dispatched: true }),
      resumeFile: async () => {
        const file = await post({
          type: "GET_RESUME",
          runId: message.runId,
          revision: steps.find((step) => step.step === "resume")?.revision,
        });
        if (!file?.ok) return { ok: false };
        return { ok: true, file: toUploadFile(file.bytes, file.fileName) };
      },
      assignFile: (input, file) => {
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      },
      stepResult: (body) => post({ type: "STEP_RESULT", runId: message.runId, ...body }),
    },
  });
  } finally {
    clearInterval(timer);
  }
  await post({
    type: "RUN_FINISH",
    runId: message.runId,
    status: outcome.status === "failed" ? "failed_retryable" : outcome.status,
    errorCode: outcome.errorCode || null,
    message: outcome.message || "",
    mutated: !!outcome.mutated,
    uncertain: outcome.status === "unverified",
    uploadDispatched: outcome.status === "unverified",
    steps: outcome.results || null,
  });
  return outcome;
}

function boot() {
  if (globalThis.__npuBound) return;
  globalThis.__npuBound = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || (message.type !== "BIND_RUN" && message.type !== "CHECK_PAGE" && message.type !== "CANCEL_RUN")) return;
    if (message.type === "CANCEL_RUN") {
      requestStop();
      sendResponse({ ok: true });
      return;
    }
    if (message.type === "BIND_RUN") {
      clearStop();
      sendResponse({ ok: true, started: true });
      void bindRun(document, message).catch((err) => {
        void post({
          type: "RUN_FINISH",
          runId: message.runId,
          status: "interrupted",
          errorCode: "RUNNER",
          message: err?.message || "Run interrupted",
        });
      });
      return;
    }
    Promise.resolve({
      ok: true,
      assessment: assessDocument(document, location.href),
    }).then(sendResponse, (err) => {
      sendResponse({ ok: false, message: err?.message || "Run interrupted" });
    });
    return true;
  });
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) boot();

module.exports = { bindRun, boot, readHeader };

}};
__req("extension/src/content.js");
})();
