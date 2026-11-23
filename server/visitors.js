const { getSupabase } = require("./supabase");
const { normalizeSlots } = require("../electron/scheduler");

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

async function getOrCreateVisitor(sid) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("visitors")
    .select("*")
    .eq("id", sid)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (data) {
    return {
      ...data,
      settings: mergeSettings(data.settings),
    };
  }
  const row = {
    id: sid,
    settings: DEFAULT_SETTINGS,
    storage_state: null,
    connected_at: null,
    last_run_at: null,
    last_run_result: null,
    resume_path: null,
    log_tail: "",
  };
  const { data: created, error: insErr } = await sb
    .from("visitors")
    .insert(row)
    .select("*")
    .single();
  if (insErr) throw new Error(insErr.message);
  return { ...created, settings: mergeSettings(created.settings) };
}

async function updateVisitor(sid, patch) {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("visitors")
    .update(patch)
    .eq("id", sid)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return { ...data, settings: mergeSettings(data.settings) };
}

async function patchSettings(sid, partial) {
  const visitor = await getOrCreateVisitor(sid);
  const next = mergeSettings({ ...visitor.settings, ...partial });
  if (partial.slots !== undefined) {
    next.slots = normalizeSlots(partial.slots);
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

async function uploadResume(sid, buffer, originalName) {
  const sb = getSupabase();
  const safe = String(originalName || "resume.pdf").replace(/[^\w.\-]+/g, "_");
  const path = `${sid}/${Date.now()}_${safe}`;
  const { error } = await sb.storage.from("resumes").upload(path, buffer, {
    contentType: "application/pdf",
    upsert: true,
  });
  if (error) throw new Error(error.message);
  await patchSettings(sid, { sourceResumePath: path });
  await updateVisitor(sid, { resume_path: path });
  return path;
}

async function downloadResume(sid) {
  const visitor = await getOrCreateVisitor(sid);
  const path = visitor.resume_path || visitor.settings.sourceResumePath;
  if (!path) throw new Error("Choose a resume PDF before updating.");
  const sb = getSupabase();
  const { data, error } = await sb.storage.from("resumes").download(path);
  if (error) throw new Error(error.message);
  const buf = Buffer.from(await data.arrayBuffer());
  return { buf, storagePath: path, basename: path.split("/").pop() };
}

async function listSchedulableVisitors() {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("visitors")
    .select("id, settings, storage_state, resume_path")
    .not("storage_state", "is", null);
  if (error) throw new Error(error.message);
  return (data || [])
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
