/** Bounded DOM steps. Stops on the first failed or uncertain step. No unofficial endpoints. */

const { normField } = require("../../shared/bump");
const { fieldPlanFor, uploadAccepted } = require("./engine");
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
} = require("./dom");

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
  const textSteps = run.steps.filter((step) => step !== "resume");
  const textMissing =
    textSteps.length > 0 && textSteps.every((step) => results[step] === "missing");
  const present = Object.values(results).filter((status) => status !== "missing");
  const mutated = present.includes("verified");
  if (!present.length || (textMissing && !mutated)) {
    return fail("SELECTOR", "Profile layout could not be verified.", { results, state: currentState });
  }
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

const activate = (el) => {
  if (!el || typeof el.click !== "function") return;
  let link = el;
  while (link && !/^\s*javascript:/i.test(link.getAttribute?.("href") || "")) {
    link = link.parentElement;
  }
  const href = link?.getAttribute?.("href");
  if (href && /^\s*javascript:/i.test(href)) link.setAttribute("href", "#");
  try {
    el.click();
  } finally {
    if (href != null && link) link.setAttribute("href", href);
  }
};

/** Desktop opens the section tab before the edit pencil appears. */
const openSection = (doc, name) => {
  scrollToHeading(doc, name);
  if (!doc?.querySelectorAll || !name) return;
  const pattern = new RegExp(`^${name}$`, "i");
  for (const node of doc.querySelectorAll(".collection-item, a, span, button, div, li")) {
    const label = textOf(node);
    if (!pattern.test(label) || label.length > 40 || !isVisible(node)) continue;
    activate(node);
    return;
  }
};

const closeEditor = (doc) => {
  const cancel = [...(doc.querySelectorAll?.("button, a, span") || [])].find(
    (el) => isVisible(el) && /^cancel$/i.test(textOf(el)),
  );
  activate(cancel);
};

async function textStep(doc, { step, state, run, hooks }) {
  const label = step === "summary" ? "Profile summary" : "Resume headline";
  openSection(doc, label);
  const sels = fieldSelectors[step];
  let located = queryUnique(doc, sels.edit);
  let edit = located.ok ? located : findLabeledEdit(doc, label);
  if (!edit.ok) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    located = queryUnique(doc, sels.edit);
    edit = located.ok ? located : findLabeledEdit(doc, label);
  }
  if (!edit.ok) {
    const noted = await hooks.stepResult({ step, status: "no_change" });
    return { ok: true, stepStatus: "no_change", missing: true, state: noted?.state || state };
  }
  activate(edit.el);
  const stop = (result) => {
    closeEditor(doc);
    return result;
  };
  const fieldHit = await waitForField(doc, sels.field);
  if (!fieldHit.ok) {
    return stop(fail(fieldHit.code || "SELECTOR", fieldHit.message, fieldHit.code === "CANCELLED" ? { status: "cancelled" } : {}));
  }
  const field = fieldHit.el;
  const maxLen = Number(field.getAttribute?.("maxlength")) || undefined;
  const current = normField(field.value);
  const plan = fieldPlanFor(state, step, current, maxLen);
  if (plan.status === "invalid") return stop(fail("CUSTOM_EMPTY", plan.message, { status: "blocked" }));
  if (plan.status === "conflict") {
    return stop(fail("CONFLICT", plan.message, { status: "conflict" }));
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
    closeEditor(doc);
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
  activate(save.el);
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
    pageText: text,
    uploadedLine: (/Uploaded on\s*:?\s*(?:today\b|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Za-z]{3,9},?\s+\d{4}|\d{1,2}[/\-.]\d{1,2}[/\-.]\d{4})/i.exec(text) || [""])[0],
    freshSignal: doc.uploadFresh === true,
    timestampChanged: doc.uploadTimestampChanged === true,
  };
};

async function uploadStep(doc, { run, state, hooks, results }) {
  openSection(doc, "Resume");
  const before = uploadView(doc, run.filename);
  const asOf = run.frozenAt ? new Date(run.frozenAt) : new Date();
  let input = findResumeInput(doc);
  if (!input.ok) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    input = findResumeInput(doc);
  }
  if (!input.ok) return fail("SELECTOR", input.message);
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
  let confirm = findUploadConfirm(doc);
  const confirmUntil = Date.now() + 5000;
  while (confirm.ok && !confirm.el && !stopRequested && Date.now() < confirmUntil) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    confirm = findUploadConfirm(doc);
  }
  if (!confirm.ok) return fail("SELECTOR", confirm.message);
  activate(confirm.el);
  if (typeof doc.afterUpload === "function") doc.afterUpload();
  let after = uploadView(doc, run.filename);
  const deadline = Date.now() + 20000;
  while (
    !stopRequested &&
    !uploadAccepted({ before, after, filename: run.filename, now: asOf }) &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    after = uploadView(doc, run.filename);
  }
  if (stopRequested) {
    return fail("CANCELLED", "Run cancelled; completed changes may remain.", {
      status: "cancelled",
      state: dispatched.state,
    });
  }
  if (!uploadAccepted({ before, after, filename: run.filename, now: asOf })) {
    return fail("UPLOAD_UNVERIFIED", "cv upload did not stick", {
      status: "unverified",
      state: dispatched.state,
    });
  }
  const noted = await hooks.stepResult({ step: "resume", status: "verified" });
  return { ok: true, stepStatus: "verified", state: noted?.state || dispatched.state, results };
}

module.exports = { runSteps, pageFocused, requestStop, clearStop };
