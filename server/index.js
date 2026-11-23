require("dotenv").config();

const express = require("express");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");

const {
  getOrCreateVisitor,
  patchSettings,
  clearLog,
  uploadResume,
  saveStorageState,
} = require("./visitors");
const {
  getState,
  previewResumeName,
  doRun,
  tickSchedules,
  identityFromResumePath,
} = require("./run");
const {
  startConnectSession,
  stopSession,
  snapshot,
  sendInput,
  hasSession,
} = require("./connect");
const { parseSessionImport } = require("./cookies-import");

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const PORT = Number(process.env.PORT) || 3000;
const COOKIE = "sid";
const isProd = process.env.NODE_ENV === "production";

app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

function ensureSid(req, res, next) {
  let sid = req.cookies[COOKIE];
  if (!sid || !/^[0-9a-f-]{36}$/i.test(sid)) {
    sid = crypto.randomUUID();
    res.cookie(COOKIE, sid, {
      httpOnly: true,
      sameSite: "lax",
      secure: isProd,
      maxAge: 365 * 24 * 60 * 60 * 1000,
    });
  }
  req.sid = sid;
  next();
}

app.use(ensureSid);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/state", async (req, res) => {
  try {
    await getOrCreateVisitor(req.sid);
    res.json(await getState(req.sid));
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.patch("/api/settings", async (req, res) => {
  try {
    const body = req.body || {};
    delete body.quiet;
    const visitor = await patchSettings(req.sid, body);
    res.json({ ok: true, settings: visitor.settings });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.post("/api/preview-resume-name", async (req, res) => {
  try {
    const name = await previewResumeName(req.sid, req.body || {});
    res.json({ ok: true, name });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.post("/api/resume", upload.single("resume"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "No PDF uploaded." });
    }
    if (req.file.mimetype && !req.file.mimetype.includes("pdf")) {
      return res.status(400).json({ ok: false, error: "Only PDF resumes are supported." });
    }
    const storagePath = await uploadResume(
      req.sid,
      req.file.buffer,
      req.file.originalname || "resume.pdf",
    );
    const suggested = identityFromResumePath(req.file.originalname || "");
    res.json({
      ok: true,
      sourceResumePath: storagePath,
      suggested,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.post("/api/clear-log", async (req, res) => {
  try {
    await clearLog(req.sid);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.post("/api/connect/import", async (req, res) => {
  try {
    const text =
      typeof req.body?.json === "string"
        ? req.body.json
        : typeof req.body?.cookies === "string"
          ? req.body.cookies
          : JSON.stringify(req.body?.json ?? req.body?.cookies ?? req.body);
    const storageState = parseSessionImport(text);
    await saveStorageState(req.sid, storageState);
    await stopSession(req.sid).catch(() => {});
    res.json({
      ok: true,
      connected: true,
      cookieCount: storageState.cookies.length,
      connectedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: String(err.message || err) });
  }
});

app.post("/api/connect/start", async (req, res) => {
  try {
    const result = await startConnectSession(req.sid);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.post("/api/connect/cancel", async (req, res) => {
  try {
    await stopSession(req.sid);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.get("/api/connect/snapshot", async (req, res) => {
  try {
    const result = await snapshot(req.sid);
    if (!result.ok) {
      return res.status(404).json(result);
    }
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("X-Page-Url", result.url || "");
    res.setHeader("Cache-Control", "no-store");
    res.send(result.buf);
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.get("/api/connect/status", async (req, res) => {
  try {
    const state = await getState(req.sid);
    res.json({
      ok: true,
      active: hasSession(req.sid),
      connected: state.connected,
      connectedAt: state.settings.connectedAt,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.post("/api/connect/input", async (req, res) => {
  try {
    const result = await sendInput(req.sid, req.body || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.post("/api/run", async (req, res) => {
  try {
    const result = await doRun(req.sid, "manual");
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.post("/internal/tick", async (req, res) => {
  const secret = process.env.CRON_SECRET || "";
  const hdr = req.get("x-cron-secret") || req.query.secret || "";
  if (!secret || hdr !== secret) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  try {
    const results = await tickSchedules();
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.use(express.static(path.join(__dirname, "..", "public")));

app.listen(PORT, () => {
  console.log(`Profile Updater web listening on :${PORT}`);
});
