const fs = require("fs");
const os = require("os");
const path = require("path");
const { runProfileUpdate, RUNNER_REVISION } = require("./naukri-runner-web");
const { withQueue } = require("./queue");
const {
  getOrCreateVisitor,
  updateVisitor,
  appendLog,
  downloadResume,
  mergeSettings,
} = require("./visitors");
const {
  nextSlotAfter,
  slotsDueNow,
  currentDayKey,
} = require("../electron/scheduler");
const {
  buildResumeFileName,
  resolveIdentity,
  identityFromResumePath,
} = require("../electron/resume-name");
const { hasSession } = require("./connect");

const runningSids = new Set();

function buildState(visitor, running) {
  const settings = mergeSettings(visitor.settings);
  if (visitor.connected_at) settings.connectedAt = visitor.connected_at;
  if (visitor.last_run_at) settings.lastRunAt = visitor.last_run_at;
  if (visitor.last_run_result != null) {
    settings.lastRunResult = visitor.last_run_result;
  }
  if (visitor.resume_path) {
    settings.sourceResumePath = visitor.resume_path;
  }

  const next = settings.scheduleEnabled
    ? nextSlotAfter(settings.slots)
    : null;
  const resolvedIdentity = resolveIdentity(settings, settings.sourceResumePath);

  return {
    settings,
    resolvedIdentity,
    logTail: visitor.log_tail || "",
    running: Boolean(running),
    nextRun: next,
    connected: Boolean(visitor.connected_at || visitor.storage_state),
    runnerRevision: RUNNER_REVISION,
    connectActive: hasSession(visitor.id),
  };
}

async function getState(sid) {
  const visitor = await getOrCreateVisitor(sid);
  return buildState(visitor, runningSids.has(sid));
}

async function previewResumeName(sid, partial) {
  const visitor = await getOrCreateVisitor(sid);
  const settings = { ...visitor.settings, ...partial };
  const identity = resolveIdentity(
    settings,
    visitor.resume_path || settings.sourceResumePath,
  );
  return buildResumeFileName(identity);
}

async function doRun(sid, trigger) {
  if (runningSids.has(sid)) {
    return { ok: false, error: "Update already running." };
  }
  if (hasSession(sid)) {
    return { ok: false, error: "Finish or cancel Connect before running." };
  }

  return withQueue(async () => {
    runningSids.add(sid);
    try {
      const visitor = await getOrCreateVisitor(sid);
      if (!visitor.storage_state) {
        throw new Error("Not connected — click Connect and sign into Naukri.");
      }

      const { buf, basename } = await downloadResume(sid);
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "naukri-"));
      const sourcePath = path.join(workDir, basename.endsWith(".pdf") ? basename : `${basename}.pdf`);
      fs.writeFileSync(sourcePath, buf);

      const log = async (msg) => {
        await appendLog(sid, msg);
      };

      const result = await runProfileUpdate({
        storageState: visitor.storage_state,
        settings: visitor.settings,
        resumeLocalPath: sourcePath,
        workDir,
        log: (msg) => {
          appendLog(sid, msg).catch(() => {});
        },
      });

      await updateVisitor(sid, {
        storage_state: result.storageState,
        last_run_at: new Date().toISOString(),
        last_run_result: result.result,
        settings: {
          ...visitor.settings,
          lastRunAt: new Date().toISOString(),
          lastRunResult: result.result,
        },
      });

      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }

      return { ok: true, result: result.result, trigger };
    } catch (err) {
      const msg = String(err.message || err);
      const visitor = await getOrCreateVisitor(sid).catch(() => null);
      if (visitor) {
        await updateVisitor(sid, {
          last_run_at: new Date().toISOString(),
          last_run_result: msg,
          settings: {
            ...visitor.settings,
            lastRunAt: new Date().toISOString(),
            lastRunResult: msg,
          },
        }).catch(() => {});
        await appendLog(sid, msg).catch(() => {});
      }
      return { ok: false, error: msg, trigger };
    } finally {
      runningSids.delete(sid);
    }
  });
}

async function tickSchedules() {
  const { listSchedulableVisitors } = require("./visitors");
  const visitors = await listSchedulableVisitors();
  const results = [];
  const day = currentDayKey();

  for (const v of visitors) {
    const settings = v.settings;
    let firedKeys = new Set(settings.firedKeys || []);
    if (settings.firedDay !== day) {
      firedKeys = new Set();
    }
    const due = slotsDueNow(settings.slots, firedKeys);
    if (!due.length) continue;
    for (const slot of due) firedKeys.add(`${day}|${slot}`);

    await updateVisitor(v.id, {
      settings: {
        ...settings,
        firedKeys: [...firedKeys],
        firedDay: day,
      },
    });
    await appendLog(v.id, `Scheduled run at ${due.join(", ")}`);
    const r = await doRun(v.id, "schedule");
    results.push({ sid: v.id, ...r });
  }
  return results;
}

module.exports = {
  getState,
  previewResumeName,
  doRun,
  tickSchedules,
  identityFromResumePath,
  buildState,
};
