const fs = require("fs");
const path = require("path");
const { normalizeSlots } = require("./scheduler");

const DEFAULTS = {
  firstName: "",
  lastName: "",
  role: "",
  sourceResumePath: "",
  bumpMode: "dot", // "dot" | "custom"
  customHeadlineText: "",
  customSummaryText: "",
  // shortcut: kept for older settings.json; prefer customHeadline/Summary
  customBumpText: "",
  showBrowserDuringRun: true,
  slots: [],
  scheduleEnabled: false,
  connectedAt: null,
  lastRunAt: null,
  lastRunResult: null,
};

function createStore(userDataPath) {
  const settingsPath = path.join(userDataPath, "settings.json");
  const resumesDir = path.join(userDataPath, "resumes");
  const chromeProfileDir = path.join(userDataPath, "chrome-profile");
  const logPath = path.join(userDataPath, "updater.log");

  const ensureDirs = () => {
    fs.mkdirSync(userDataPath, { recursive: true });
    fs.mkdirSync(resumesDir, { recursive: true });
  };

  const read = () => {
    ensureDirs();
    if (!fs.existsSync(settingsPath)) return { ...DEFAULTS };
    try {
      const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      return { ...DEFAULTS, ...raw, slots: normalizeSlots(raw.slots || []) };
    } catch {
      return { ...DEFAULTS };
    }
  };

  const write = (partial) => {
    ensureDirs();
    const next = { ...read(), ...partial };
    if (partial.slots !== undefined) {
      next.slots = normalizeSlots(partial.slots);
    }
    fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2), "utf8");
    return next;
  };

  const appendLog = (msg) => {
    ensureDirs();
    const line = `[${new Date().toLocaleString()}] ${msg}\n`;
    fs.appendFileSync(logPath, line);
    return line.trim();
  };

  const readLogTail = (maxLines = 40) => {
    if (!fs.existsSync(logPath)) return "";
    const lines = fs.readFileSync(logPath, "utf8").split(/\r?\n/);
    return lines.filter(Boolean).slice(-maxLines).join("\n");
  };

  const clearLog = () => {
    ensureDirs();
    fs.writeFileSync(logPath, "", "utf8");
  };

  return {
    settingsPath,
    resumesDir,
    chromeProfileDir,
    logPath,
    read,
    write,
    appendLog,
    readLogTail,
    clearLog,
  };
}

module.exports = { createStore, DEFAULTS };
