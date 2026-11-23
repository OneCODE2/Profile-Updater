const { openConnectBrowser, onProfile } = require("./naukri-runner-web");
const { saveStorageState, getOrCreateVisitor } = require("./visitors");

/** @type {Map<string, any>} */
const sessions = new Map();

async function stopSession(sid) {
  const s = sessions.get(sid);
  if (!s) return;
  sessions.delete(sid);
  if (s.timer) clearInterval(s.timer);
  await s.context.close().catch(() => {});
  await s.browser.close().catch(() => {});
}

async function startConnectSession(sid) {
  if (sessions.has(sid)) await stopSession(sid);

  const visitor = await getOrCreateVisitor(sid);
  const { browser, context, page } = await openConnectBrowser(
    visitor.storage_state || undefined,
  );

  const session = { browser, context, page, timer: null };
  sessions.set(sid, session);

  session.timer = setInterval(async () => {
    try {
      for (const p of context.pages()) {
        if (onProfile(p.url())) {
          const state = await context.storageState();
          await saveStorageState(sid, state);
          await stopSession(sid);
          return;
        }
      }
    } catch {
      /* ignore poll errors */
    }
  }, 2000);

  setTimeout(() => {
    if (sessions.has(sid)) stopSession(sid).catch(() => {});
  }, 5 * 60 * 1000);

  return { ok: true };
}

async function snapshot(sid) {
  const s = sessions.get(sid);
  if (!s) return { ok: false, error: "No active connect session." };
  const buf = await s.page.screenshot({ type: "jpeg", quality: 55 });
  return { ok: true, buf, url: s.page.url() };
}

async function sendInput(sid, action) {
  const s = sessions.get(sid);
  if (!s) return { ok: false, error: "No active connect session." };
  const page = s.page;
  const type = action && action.type;

  if (type === "click") {
    await page.mouse.click(Number(action.x), Number(action.y));
  } else if (type === "dblclick") {
    await page.mouse.dblclick(Number(action.x), Number(action.y));
  } else if (type === "type") {
    await page.keyboard.type(String(action.text || ""), { delay: 20 });
  } else if (type === "key") {
    await page.keyboard.press(String(action.key || "Enter"));
  } else if (type === "scroll") {
    await page.mouse.wheel(0, Number(action.dy) || 400);
  } else {
    return { ok: false, error: "Unknown input type." };
  }

  if (onProfile(page.url())) {
    const state = await s.context.storageState();
    await saveStorageState(sid, state);
    await stopSession(sid);
    return { ok: true, connected: true };
  }
  return { ok: true, connected: false };
}

function hasSession(sid) {
  return sessions.has(sid);
}

module.exports = {
  startConnectSession,
  stopSession,
  snapshot,
  sendInput,
  hasSession,
};
