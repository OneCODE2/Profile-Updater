const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Tray,
  Menu,
  nativeImage,
} = require("electron");
const path = require("path");
const { createStore } = require("./store");
const {
  normalizeSlots,
  slotsDueNow,
  passedNewSlotKeys,
  nextSlotAfter,
  currentDayKey,
} = require("./scheduler");
const {
  buildResumeFileName,
  resolveIdentity,
  identityFromResumePath,
} = require("./resume-name");
const {
  connectAccount,
  checkSession,
  runProfileUpdate,
  RUNNER_REVISION,
} = require("./naukri-runner");

let mainWindow = null;
let tray = null;
let store = null;
let running = false;
let firedKeys = new Set();
let tickTimer = null;
let quitting = false;

const startHidden =
  process.argv.includes("--background") ||
  process.argv.includes("--hidden");

function sendStatus(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("status", payload);
  }
}

function buildState() {
  let settings = store.read();
  // Clear obsolete required-fields error from earlier builds
  if (
    settings.lastRunResult ===
    "Set first name, last name, and role before updating."
  ) {
    settings = store.write({ lastRunResult: null });
  }
  const next = settings.scheduleEnabled
    ? nextSlotAfter(settings.slots)
    : null;
  const resolvedIdentity = resolveIdentity(settings, settings.sourceResumePath);
  return {
    settings,
    resolvedIdentity,
    logTail: store.readLogTail(),
    running,
    nextRun: next,
    connected: Boolean(settings.connectedAt),
    runnerRevision: RUNNER_REVISION,
  };
}

async function doRun(trigger) {
  if (running) return { ok: false, error: "Update already running." };
  running = true;
  sendStatus({ type: "running", running: true });
  try {
    const settings = store.read();
    // Manual runs default to visible Chrome so you can watch headline/summary edits.
    // Scheduled runs stay off-screen unless showBrowserDuringRun is on.
    const show =
      trigger === "manual"
        ? settings.showBrowserDuringRun !== false
        : Boolean(settings.showBrowserDuringRun);
    const result = await runProfileUpdate(store, settings, {
      show,
      log: (line) => sendStatus({ type: "log", line }),
    });
    store.write({
      lastRunAt: new Date().toISOString(),
      lastRunResult: result.result,
    });
    sendStatus({ type: "done", ok: true, result: result.result, trigger });
    if (tray && !tray.isDestroyed()) {
      tray.setToolTip(`Naukari Updater — last: ok`);
    }
    return { ok: true, result: result.result };
  } catch (err) {
    const msg = String(err.message || err);
    store.write({
      lastRunAt: new Date().toISOString(),
      lastRunResult: msg,
    });
    sendStatus({ type: "done", ok: false, error: msg, trigger });
    if (tray && !tray.isDestroyed()) {
      tray.setToolTip(`Naukari Updater — last: error`);
    }
    return { ok: false, error: msg };
  } finally {
    running = false;
    sendStatus({ type: "running", running: false });
  }
}

function startScheduler() {
  if (tickTimer) clearInterval(tickTimer);
  // 1s poll so a run starts when the minute is reached (slots are HH:MM, deduped by firedKeys)
  tickTimer = setInterval(() => {
    const settings = store.read();
    if (!settings.scheduleEnabled || running) return;
    const due = slotsDueNow(settings.slots, firedKeys);
    if (!due.length) return;
    const day = currentDayKey();
    for (const slot of due) firedKeys.add(`${day}|${slot}`);
    store.appendLog(`Scheduled run at ${due.join(", ")}`);
    doRun("schedule").catch(() => {});
  }, 1_000);
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  const iconPath = path.join(__dirname, "tray-icon.png");
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) {
    image = nativeImage.createEmpty();
  }
  tray = new Tray(image);
  tray.setToolTip("Naukari Profile Updater (running in background)");
  const menu = Menu.buildFromTemplate([
    {
      label: "Open dashboard",
      click: () => showMainWindow(),
    },
    {
      label: "Run now",
      click: () => {
        doRun("manual").catch(() => {});
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on("double-click", () => showMainWindow());
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 860,
    show: !startHidden,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: "Naukari Profile Updater",
    backgroundColor: "#0f1419",
  });
  mainWindow.loadFile(path.join(__dirname, "..", "ui", "index.html"));

  // Close hides to tray so scheduled runs keep working while "hosted" in background.
  mainWindow.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWindow.hide();
    if (store) {
      store.appendLog(
        "Window hidden — app keeps running in the tray for scheduled updates.",
      );
    }
  });
}

app.whenReady().then(() => {
  store = createStore(app.getPath("userData"));
  createTray();
  createWindow();
  startScheduler();
  store.appendLog(
    startHidden
      ? "Started in background (tray). Open dashboard from the tray icon."
      : "Started. Closing the window keeps the app in the tray.",
  );

  ipcMain.handle("get-state", async () => buildState());

  ipcMain.handle("save-settings", async (_e, partial = {}) => {
    try {
      const quiet = Boolean(partial.quiet);
      const payload = { ...partial };
      delete payload.quiet;
      if (payload.slots !== undefined) {
        payload.slots = normalizeSlots(payload.slots);
      }
      const before = store.read();
      const settings = store.write(payload);
      if (settings.scheduleEnabled) {
        // Nothing was armed while the schedule was off, so then every slot counts as new.
        const armed = before.scheduleEnabled ? before.slots : [];
        for (const k of passedNewSlotKeys(armed, settings.slots)) firedKeys.add(k);
      }
      if (!quiet) sendStatus({ type: "saved" });
      return { ok: true, settings };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle("pick-resume", async () => {
    if (!mainWindow || mainWindow.isDestroyed()) showMainWindow();
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Choose resume PDF",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
      properties: ["openFile"],
    });
    if (result.canceled || !result.filePaths[0]) {
      return { ok: false, canceled: true };
    }
    const sourceResumePath = result.filePaths[0];
    store.write({ sourceResumePath });
    return {
      ok: true,
      sourceResumePath,
      suggested: identityFromResumePath(sourceResumePath),
    };
  });

  ipcMain.handle("preview-resume-name", async (_e, partial) => {
    const settings = store.read();
    const resolved = resolveIdentity(
      partial || settings,
      (partial && partial.sourceResumePath) || settings.sourceResumePath,
    );
    return buildResumeFileName(resolved);
  });

  ipcMain.handle("connect-account", async () => {
    try {
      sendStatus({ type: "connect-start" });
      const { connectedAt } = await connectAccount(store.chromeProfileDir, {
        log: (msg) => {
          store.appendLog(msg);
          sendStatus({ type: "log", line: msg });
        },
      });
      store.write({ connectedAt });
      sendStatus({ type: "connect-done", ok: true });
      return { ok: true, connectedAt };
    } catch (err) {
      const msg = String(err.message || err);
      store.appendLog(msg);
      sendStatus({ type: "connect-done", ok: false, error: msg });
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle("run-now", async () => doRun("manual"));

  ipcMain.handle("clear-log", async () => {
    store.clearLog();
    sendStatus({ type: "log-cleared" });
    return { ok: true };
  });

  // Optional quiet session check on startup (non-blocking)
  checkSession(store.chromeProfileDir)
    .then((ok) => {
      if (!ok && store.read().connectedAt) {
        store.appendLog(
          "Session may have expired — reconnect if Run now fails.",
        );
      }
    })
    .catch(() => {});
});

app.on("before-quit", () => {
  quitting = true;
  if (tickTimer) clearInterval(tickTimer);
});

app.on("window-all-closed", () => {
  // Do not quit — tray + scheduler keep running in the background.
});
