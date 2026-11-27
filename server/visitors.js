const fs = require("fs");
const path = require("path");
const {
  normalizeSlots,
  passedNewSlotKeys,
  currentDayKey,
} = require("../electron/scheduler");

const DEFAULT_SETTINGS = {
  firstName: "",
  lastName: "",
  role: "",
  sourceResumePath: "",
  bumpMode: "dot",
  customHeadlineText: "",
  customSummaryText: "",
  customBumpText: "",
  showBrowserDuringRun: false,
  slots: [],
  scheduleEnabled: false,
  connectedAt: null,
  lastRunAt: null,
  lastRunResult: null,
  firedKeys: [],
  firedDay: null,
};

function mergeSettings(raw) {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  s.slots = normalizeSlots(s.slots || []);
  return s;
}

const SID_RE = /^[0-9a-f-]{36}$/i;

// Local file storage (replaces Supabase). One JSON file per visitor + resume PDFs.
function dataDir() {
  return process.env.DATA_DIR || path.join(__dirname, "..", "data");
}

function visitorFile(sid) {
  if (!SID_RE.test(String(sid))) throw new Error("Invalid session id.");
  return path.join(dataDir(), "visitors", `${sid}.json`);
}

// shortcut: sync fs + tmp-file rename keeps read-modify-write atomic in one Node process; use a DB if multi-process.
function writeVisitor(row) {
  const file = visitorFile(row.id);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(row, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readVisitor(sid) {
  try {
    return JSON.parse(fs.readFileSync(visitorFile(sid), "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function getOrCreateVisitor(sid) {
  let row = readVisitor(sid);
  if (!row) {
    const now = new Date().toISOString();
    row = {
      id: sid,
      settings: DEFAULT_SETTINGS,
      storage_state: null,
      connected_at: null,
      last_run_at: null,
      last_run_result: null,
      resume_path: null,
      log_tail: "",
      created_at: now,
      updated_at: now,
    };
    writeVisitor(row);
  }
  return { ...row, settings: mergeSettings(row.settings) };
}

async function updateVisitor(sid, patch) {
  const row = await getOrCreateVisitor(sid);
  const next = { ...row, ...patch, updated_at: new Date().toISOString() };
  writeVisitor(next);
  return { ...next, settings: mergeSettings(next.settings) };
}

async function patchSettings(sid, partial, now = new Date()) {
  const visitor = await getOrCreateVisitor(sid);
  const next = mergeSettings({ ...visitor.settings, ...partial });
  if (partial.slots !== undefined) {
    next.slots = normalizeSlots(partial.slots);
  }
  if (next.scheduleEnabled && (partial.slots !== undefined || partial.scheduleEnabled !== undefined)) {
    // Nothing was armed while the schedule was off, so then every slot counts as new.
    const armed = visitor.settings.scheduleEnabled ? visitor.settings.slots : [];
    const skipped = passedNewSlotKeys(armed, next.slots, now);
    if (skipped.length) {
      const day = currentDayKey(now);
      const kept = visitor.settings.firedDay === day ? visitor.settings.firedKeys : [];
      next.firedKeys = [...new Set([...kept, ...skipped])];
      next.firedDay = day;
    }
  }
  const patch = { settings: next };
  if (partial.connectedAt !== undefined) {
    patch.connected_at = partial.connectedAt;
    next.connectedAt = partial.connectedAt;
    patch.settings = next;
  }
  return updateVisitor(sid, patch);
}

async function appendLog(sid, msg) {
  const visitor = await getOrCreateVisitor(sid);
  const line = `[${new Date().toLocaleString()}] ${msg}`;
  const lines = `${visitor.log_tail || ""}\n${line}`
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-80);
  const log_tail = lines.join("\n");
  await updateVisitor(sid, { log_tail });
  return line;
}

async function clearLog(sid) {
  return updateVisitor(sid, { log_tail: "" });
}

async function saveStorageState(sid, storageState) {
  const visitor = await getOrCreateVisitor(sid);
  const connectedAt = new Date().toISOString();
  return updateVisitor(sid, {
    storage_state: storageState,
    connected_at: connectedAt,
    settings: mergeSettings({
      ...visitor.settings,
      connectedAt,
    }),
  });
}

function resumePathOf(storagePath) {
  const root = path.resolve(dataDir(), "resumes");
  const full = path.resolve(root, storagePath);
  if (!full.startsWith(root + path.sep)) throw new Error("Invalid resume path.");
  return full;
}

async function uploadResume(sid, buffer, originalName) {
  visitorFile(sid); // validates sid before it is used in a path
  const safe = String(originalName || "resume.pdf").replace(/[^\w.\-]+/g, "_");
  const storagePath = `${sid}/${Date.now()}_${safe}`;
  const full = resumePathOf(storagePath);
  fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
  fs.writeFileSync(full, buffer, { mode: 0o600 });
  await patchSettings(sid, { sourceResumePath: storagePath });
  await updateVisitor(sid, { resume_path: storagePath });
  return storagePath;
}

async function downloadResume(sid) {
  const visitor = await getOrCreateVisitor(sid);
  const storagePath = visitor.resume_path || visitor.settings.sourceResumePath;
  if (!storagePath) throw new Error("Choose a resume PDF before updating.");
  const buf = fs.readFileSync(resumePathOf(storagePath));
  return { buf, storagePath, basename: storagePath.split("/").pop() };
}

async function listSchedulableVisitors() {
  const dir = path.join(dataDir(), "visitors");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readVisitor(f.slice(0, -".json".length)))
    .filter(Boolean)
    .map((row) => ({ ...row, settings: mergeSettings(row.settings) }))
    .filter((v) => v.settings.scheduleEnabled && v.storage_state);
}

module.exports = {
  DEFAULT_SETTINGS,
  mergeSettings,
  getOrCreateVisitor,
  updateVisitor,
  patchSettings,
  appendLog,
  clearLog,
  saveStorageState,
  uploadResume,
  downloadResume,
  listSchedulableVisitors,
};
