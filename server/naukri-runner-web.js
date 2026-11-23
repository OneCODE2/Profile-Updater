/**
 * Headless Playwright runner for Render (storageState in/out, no local Chrome).
 */
const RUNNER_REVISION = "bump-custom-v4.1-web";
const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { applyBump, uploadedToday } = require("../electron/naukri-helpers");
const { prepareResumeCopy, resolveIdentity } = require("../electron/resume-name");

const PROFILE_URL = "https://www.naukri.com/mnjuser/profile";
const LOGIN_URL = `https://www.naukri.com/nlogin/login?URL=${PROFILE_URL}`;

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-blink-features=AutomationControlled",
];

function onProfile(url) {
  try {
    return new URL(url).pathname.startsWith("/mnjuser");
  } catch {
    return false;
  }
}

async function launchContext(storageState) {
  // Must match build: browsers live under node_modules when PATH=0
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = "0";
  }
  const browser = await chromium.launch({
    headless: true,
    args: LAUNCH_ARGS,
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 850 },
    storageState: storageState || undefined,
  });
  return { browser, context };
}

async function waitForEdit(page, editSel, { scrollName } = {}) {
  if (scrollName) {
    await page
      .locator(".collection-item")
      .filter({ hasText: new RegExp(`^${scrollName}$`, "i") })
      .first()
      .click({ timeout: 5000 })
      .catch(() => {});
  }
  const editIcon = page.locator(editSel);
  try {
    await editIcon.first().waitFor({ state: "visible", timeout: 12000 });
    return editIcon;
  } catch {
    /* scroll */
  }
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await editIcon.first().scrollIntoViewIfNeeded().catch(() => {});
    if (await editIcon.first().isVisible().catch(() => false)) return editIcon;
    await page.mouse.wheel(0, 800).catch(() => {});
    await page.waitForTimeout(400);
  }
  await editIcon.first().waitFor({ state: "visible", timeout: 5000 });
  return editIcon;
}

async function closeEditor(page, textarea) {
  if (!(await textarea.isVisible().catch(() => false))) return true;
  await page
    .locator("button, .btn, a, span")
    .filter({ hasText: /^Cancel$/i })
    .first()
    .click({ timeout: 3000 })
    .catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await textarea.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
  return !(await textarea.isVisible().catch(() => false));
}

const normField = (s) =>
  String(s || "")
    .replace(/\u00a0/g, " ")
    .trimEnd();

async function setTextareaValue(page, textarea, value) {
  await textarea.click({ timeout: 5000 });
  await textarea.fill("");
  await textarea.evaluate((el, v) => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    if (setter) setter.call(el, v);
    else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  const shown = normField(await textarea.inputValue());
  if (shown !== normField(value)) {
    await textarea.fill(value);
  }
}

async function bumpTextField(
  page,
  { name, editSel, textareaSel, scrollName, bumpMode, customBumpText },
) {
  const editIcon = await waitForEdit(page, editSel, { scrollName });
  await editIcon.first().click();

  const textarea = page.locator(textareaSel);
  await textarea.waitFor({ timeout: 15000 });
  const current = normField(await textarea.inputValue());
  const maxLen = Number(await textarea.getAttribute("maxlength")) || undefined;
  const { next: updated, changeMsg } = applyBump(
    current,
    { mode: bumpMode, customText: customBumpText },
    maxLen,
  );

  await setTextareaValue(page, textarea, updated);
  await page.waitForTimeout(600);

  const validation = page.getByText(/minimum\s+\d+\s+words\s+are\s+required/i);
  if (await validation.isVisible().catch(() => false)) {
    throw new Error(
      `${name}: Naukri blocked Save (${await validation.innerText()}). ` +
        `Custom text is appended after stripping trailing dots — keep enough words in the base headline.`,
    );
  }

  await page
    .locator(".lightbox, .modal, .sDrawer, body")
    .locator(".btn-dark-ot, button")
    .filter({ hasText: /^Save$/i })
    .last()
    .click({ timeout: 10000 });
  await textarea.waitFor({ state: "hidden", timeout: 15000 });
  await page.waitForTimeout(1200);

  await page.goto(PROFILE_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  const editAgain = await waitForEdit(page, editSel, { scrollName });
  await editAgain.first().click();
  await textarea.waitFor({ timeout: 15000 });
  const saved = normField(await textarea.inputValue());
  if (saved !== normField(updated)) {
    throw new Error(
      `${name} save did not stick — got ${saved.length} chars ending "${saved.slice(-50)}", ` +
        `expected ${updated.length} chars ending "${updated.slice(-50)}"`,
    );
  }
  if (!(await closeEditor(page, textarea))) {
    await page.goto(PROFILE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
  }

  return { changeMsg, updated, before: current };
}

async function readPageText(page) {
  await page
    .getByText(/Uploaded on/i)
    .first()
    .waitFor({ timeout: 30000 })
    .catch(() => {});
  return page
    .locator("body")
    .innerText({ timeout: 30000 })
    .catch(() => "");
}

async function uploadResume(page, resumePath) {
  if (!fs.existsSync(resumePath)) {
    throw new Error(`resume file missing: ${resumePath}`);
  }

  const base = path.basename(resumePath);
  const stem = path.basename(resumePath, path.extname(resumePath));
  const nameRe = new RegExp(
    `${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(-\\d+)?\\${path.extname(resumePath)}`,
    "i",
  );

  await page
    .locator(".collection-item, a, span")
    .filter({ hasText: /^Resume$/i })
    .first()
    .click({ timeout: 5000 })
    .catch(() => {});

  await page
    .locator('#attachCV, input[type="file"]')
    .first()
    .setInputFiles(resumePath);

  await page
    .getByRole("button", { name: /yes,?\s*upload|replace|update/i })
    .first()
    .click({ timeout: 5000 })
    .catch(() => {});

  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2000);
    await page
      .goto(PROFILE_URL, { waitUntil: "domcontentloaded", timeout: 60000 })
      .catch(() => {});
    const after = await readPageText(page);
    if (nameRe.test(after) || uploadedToday(after)) {
      return `cv re-uploaded (verified: ${base})`;
    }
  }
  const shown = (/Uploaded on[^\n]*/i.exec(await readPageText(page)) || [
    '(no "Uploaded on" text found)',
  ])[0];
  throw new Error(
    `cv upload did not stick — profile shows "${shown.slice(0, 80)}"`,
  );
}

/**
 * Interactive connect session for remote screenshot + input.
 */
async function openConnectBrowser(storageState) {
  const { browser, context } = await launchContext(storageState || undefined);
  const page = await context.newPage();
  await page.goto(LOGIN_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  return { browser, context, page };
}

async function runProfileUpdate({
  storageState,
  settings,
  resumeLocalPath,
  workDir,
  log,
}) {
  const say = (msg) => {
    if (log) log(msg);
  };

  if (!resumeLocalPath) {
    throw new Error("Choose a resume PDF before updating.");
  }

  say(`Runner ${RUNNER_REVISION} starting…`);

  const identity = resolveIdentity(
    {
      firstName: settings.firstName,
      lastName: settings.lastName,
      role: settings.role,
    },
    resumeLocalPath,
  );
  say(
    `Resume name parts: ${identity.firstName || "(from file/X)"} / ${identity.lastName || "(from file/X)"} / ${identity.role || "(from file/X)"}`,
  );

  fs.mkdirSync(workDir, { recursive: true });
  const resumePath = prepareResumeCopy(resumeLocalPath, workDir, identity);
  say(`Prepared resume: ${path.basename(resumePath)}`);

  const { browser, context } = await launchContext(storageState);
  let page = context.pages()[0] || (await context.newPage());
  let step = "start";

  try {
    step = "open profile";
    await page.goto(PROFILE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    if (!onProfile(page.url())) {
      throw new Error(
        "Not logged in — click Connect account and sign into Naukri, then try again.",
      );
    }
    if (!/\/mnjuser\/profile/.test(page.url())) {
      await page.goto(PROFILE_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
    }

    const bumpMode = settings.bumpMode === "custom" ? "custom" : "dot";
    const legacyCustom = String(settings.customBumpText || "").trim();
    const headlineText =
      String(settings.customHeadlineText || "").trim() || legacyCustom;
    const summaryText =
      String(settings.customSummaryText || "").trim() || legacyCustom;

    if (bumpMode === "custom") {
      if (!headlineText) {
        throw new Error(
          "Custom mode: fill “Resume headline” text (or switch to Add trailing dots).",
        );
      }
      if (!summaryText) {
        throw new Error(
          "Custom mode: fill “Profile summary” text (or switch to Add trailing dots).",
        );
      }
    }

    say(
      bumpMode === "custom"
        ? "Bump mode: CUSTOM TEXT (separate values for headline + summary)"
        : "Bump mode: TRAILING DOTS on Resume headline + Profile summary",
    );

    step = "headline";
    const headline = await bumpTextField(page, {
      name: "headline",
      editSel:
        '#lazyResumeHead span.edit.icon, [data-ga-track*="resumeHeadline"] .edit',
      textareaSel: "#resumeHeadlineTxt",
      scrollName: "Resume headline",
      bumpMode,
      customBumpText: headlineText,
    });
    say(`Resume headline BEFORE: "${headline.before.slice(0, 80)}"`);
    say(
      `Resume headline AFTER:  "${headline.updated.slice(0, 80)}" (${headline.changeMsg})`,
    );

    step = "summary";
    const summary = await bumpTextField(page, {
      name: "summary",
      editSel:
        '#lazyProfileSummary span.edit.icon, [aria-label="Edit profile summary"]',
      textareaSel: "#profileSummaryTxt",
      scrollName: "Profile summary",
      bumpMode,
      customBumpText: summaryText,
    });
    say(`Profile summary BEFORE: "${summary.before.slice(0, 80)}"`);
    say(
      `Profile summary AFTER:  "${summary.updated.slice(0, 80)}" (${summary.changeMsg})`,
    );

    step = "resume";
    say("Re-uploading resume...");
    const cvMsg = await uploadResume(page, resumePath);

    const modeTag = bumpMode === "custom" ? "custom-text" : "trailing-dots";
    const result = `OK [${modeTag}]: headline ${headline.changeMsg}, summary ${summary.changeMsg}, ${cvMsg}`;
    say(result);

    const nextState = await context.storageState();
    await context.close();
    await browser.close();
    return { ok: true, result, storageState: nextState };
  } catch (err) {
    const msg = `ERROR [${step}]: ${String(err.message || err).split("\n")[0]}`;
    say(msg);
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    throw new Error(msg);
  }
}

module.exports = {
  RUNNER_REVISION,
  PROFILE_URL,
  LOGIN_URL,
  onProfile,
  openConnectBrowser,
  runProfileUpdate,
  launchContext,
};
