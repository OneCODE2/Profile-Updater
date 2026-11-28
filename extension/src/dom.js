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
