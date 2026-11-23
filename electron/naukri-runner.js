/**
 * Playwright runner: connect (manual login) + profile bump + resume upload.
 * Session only — no credentials stored.
 *
 * Bump behavior revision — bump this when changing headline/summary logic so the
 * UI can detect a stale Electron main process that still runs old code.
 */
const RUNNER_REVISION = "bump-custom-v4.1";
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");
const { applyBump, uploadedToday } = require("./naukri-helpers");
const { prepareResumeCopy, resolveIdentity } = require("./resume-name");

const PROFILE_URL = "https://www.naukri.com/mnjuser/profile";
const LOGIN_URL = `https://www.naukri.com/nlogin/login?URL=${PROFILE_URL}`;

const onProfile = (url) => {
  try {
    return new URL(url).pathname.startsWith("/mnjuser");
  } catch {
    return false;
  }
};

async function launchContext(chromeProfileDir, { show = true } = {}) {
  return chromium.launchPersistentContext(chromeProfileDir, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1280, height: 850 },
    args: [
      "--disable-blink-features=AutomationControlled",
      show ? "--window-position=80,40" : "--window-position=-32000,-32000",
    ],
  });
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
  // React-controlled fields often need input/change events, not only .fill
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

  // Only the real validation error — not the always-visible hint "(Minimum 5 words)".
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
 * Open Chrome so the user can log into Naukri. Waits until /mnjuser is reached.
 */
async function connectAccount(chromeProfileDir, { timeoutMs = 5 * 60 * 1000, log } = {}) {
  const say = log || (() => {});
  const ctx = await launchContext(chromeProfileDir, { show: true });
  const page = ctx.pages()[0] || (await ctx.newPage());
  try {
    say("Opening Naukri login — sign in in the Chrome window...");
    await page.goto(LOGIN_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const p of ctx.pages()) {
        if (onProfile(p.url())) {
          say("Login detected — session saved.");
          await ctx.close();
          return { ok: true, connectedAt: new Date().toISOString() };
        }
      }
      await page.waitForTimeout(1500);
    }
    throw new Error(
      "Timed out waiting for Naukri login. Click Connect again and finish signing in.",
    );
  } catch (err) {
    await ctx.close().catch(() => {});
    throw err;
  }
}

/**
 * Check whether the saved Chrome session still lands on the profile.
 */
async function checkSession(chromeProfileDir) {
  const ctx = await launchContext(chromeProfileDir, { show: false });
  const page = ctx.pages()[0] || (await ctx.newPage());
  try {
    await page.goto(PROFILE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    const ok = onProfile(page.url());
    await ctx.close();
    return ok;
  } catch {
    await ctx.close().catch(() => {});
    return false;
  }
}

/**
 * Full update: headline + summary dots, rename/copy resume, upload.
 */
async function runProfileUpdate(store, settings, { show = false, log } = {}) {
  const say = (msg) => {
    const line = store.appendLog(msg);
    if (log) log(line);
  };

  if (!settings.sourceResumePath) {
    throw new Error("Choose a resume PDF before updating.");
  }

  say(`Runner ${RUNNER_REVISION} starting…`);

  const identity = resolveIdentity(
    {
      firstName: settings.firstName,
      lastName: settings.lastName,
      role: settings.role,
    },
    settings.sourceResumePath,
  );
  say(
    `Resume name parts: ${identity.firstName || "(from file/X)"} / ${identity.lastName || "(from file/X)"} / ${identity.role || "(from file/X)"}`,
  );

  const resumePath = prepareResumeCopy(
    settings.sourceResumePath,
    store.resumesDir,
    identity,
  );
  say(`Prepared resume: ${path.basename(resumePath)}`);

  const errorShot = path.join(store.resumesDir, `error-${Date.now()}.png`);
  const ctx = await launchContext(store.chromeProfileDir, { show });
  let page = ctx.pages()[0] || (await ctx.newPage());
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
    say(
      bumpMode === "custom"
        ? `Updating Resume headline with custom text (${headlineText.length} chars)...`
        : "Updating Resume headline (trailing dot on this field only)...",
    );
    const headline = await bumpTextField(page, {
      name: "headline",
      editSel:
        '#lazyResumeHead span.edit.icon, [data-ga-track*="resumeHeadline"] .edit',
      textareaSel: "#resumeHeadlineTxt",
      scrollName: "Resume headline",
      bumpMode,
      customBumpText: headlineText,
    });
    say(
      `Resume headline BEFORE: "${headline.before.slice(0, 80)}"`,
    );
    say(
      `Resume headline AFTER:  "${headline.updated.slice(0, 80)}" (${headline.changeMsg})`,
    );

    step = "summary";
    say(
      bumpMode === "custom"
        ? `Updating Profile summary with custom text (${summaryText.length} chars)...`
        : "Updating Profile summary (trailing dot on this field only)...",
    );
    const summary = await bumpTextField(page, {
      name: "summary",
      editSel:
        '#lazyProfileSummary span.edit.icon, [aria-label="Edit profile summary"]',
      textareaSel: "#profileSummaryTxt",
      scrollName: "Profile summary",
      bumpMode,
      customBumpText: summaryText,
    });
    say(
      `Profile summary BEFORE: "${summary.before.slice(0, 80)}"`,
    );
    say(
      `Profile summary AFTER:  "${summary.updated.slice(0, 80)}" (${summary.changeMsg})`,
    );

    step = "resume";
    say("Re-uploading resume...");
    const cvMsg = await uploadResume(page, resumePath);

    const modeTag = bumpMode === "custom" ? "custom-text" : "trailing-dots";
    const result = `OK [${modeTag}]: headline ${headline.changeMsg}, summary ${summary.changeMsg}, ${cvMsg}`;
    say(result);
    await ctx.close();
    return { ok: true, result, resumePath };
  } catch (err) {
    await page.screenshot({ path: errorShot }).catch(() => {});
    const msg = `ERROR [${step}]: ${String(err.message || err).split("\n")[0]}`;
    say(msg);
    await ctx.close().catch(() => {});
    throw new Error(msg);
  }
}

module.exports = {
  connectAccount,
  checkSession,
  runProfileUpdate,
  PROFILE_URL,
  RUNNER_REVISION,
};
