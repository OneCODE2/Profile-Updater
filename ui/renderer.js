const $ = (id) => document.getElementById(id);

const MAX_SLOTS = 4;

/** After Clear status log, do not reload the old file tail into the UI. */
let ignoreStoredLogTail = false;

const els = {
  runnerRevision: $("runnerRevision"),
  connStatus: $("connStatus"),
  connHint: $("connHint"),
  btnConnect: $("btnConnect"),
  bumpModeDot: $("bumpModeDot"),
  bumpModeCustom: $("bumpModeCustom"),
  customBumpWrap: $("customBumpWrap"),
  customHeadlineText: $("customHeadlineText"),
  customSummaryText: $("customSummaryText"),
  btnClearLog: $("btnClearLog"),
  firstName: $("firstName"),
  lastName: $("lastName"),
  role: $("role"),
  resumePreview: $("resumePreview"),
  identitySource: $("identitySource"),
  resumePath: $("resumePath"),
  btnPickResume: $("btnPickResume"),
  scheduleEnabled: $("scheduleEnabled"),
  slots: $("slots"),
  btnAddSlot: $("btnAddSlot"),
  btnEvery4h: $("btnEvery4h"),
  nextRun: $("nextRun"),
  showBrowserDuringRun: $("showBrowserDuringRun"),
  autoSaveStatus: $("autoSaveStatus"),
  btnRun: $("btnRun"),
  lastResult: $("lastResult"),
  log: $("log"),
};

let autoSaveTimer = null;
let applyingState = false;

function selectedBumpMode() {
  return els.bumpModeCustom.checked ? "custom" : "dot";
}

function syncBumpModeUi() {
  const custom = selectedBumpMode() === "custom";
  els.customBumpWrap.classList.toggle("hidden", !custom);
}

function syncConnectUi(connected, connectedAt) {
  if (connected) {
    setStatus(
      els.connStatus,
      connectedAt
        ? `Connected (session saved ${new Date(connectedAt).toLocaleString()})`
        : "Connected",
      "ok",
    );
    els.btnConnect.textContent = "Reconnect";
    if (els.connHint) {
      els.connHint.textContent =
        "Already connected. Click Reconnect to refresh login or use another Naukri account.";
    }
  } else {
    setStatus(els.connStatus, "Not connected", "muted");
    els.btnConnect.textContent = "Connect Naukri account";
    if (els.connHint) {
      els.connHint.textContent =
        "Opens Chrome. Sign into Naukri once; the session stays on this PC.";
    }
  }
}

function setStatus(el, text, kind) {
  el.textContent = text;
  el.classList.remove("ok", "bad", "muted");
  if (kind) el.classList.add(kind);
  else el.classList.add("muted");
}

/** "14:05" → { hour12, minute, ampm } */
function parseHhMm(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || "").trim());
  let h24 = 9;
  let minute = 0;
  if (m) {
    h24 = Math.min(23, Math.max(0, Number(m[1])));
    minute = Math.min(59, Math.max(0, Number(m[2])));
  }
  const ampm = h24 >= 12 ? "PM" : "AM";
  let hour12 = h24 % 12;
  if (hour12 === 0) hour12 = 12;
  return { hour12, minute, ampm };
}

function toHhMm(hour12, minute, ampm) {
  let h = Number(hour12);
  const min = Number(minute);
  if (ampm === "AM") h = h === 12 ? 0 : h;
  else h = h === 12 ? 12 : h + 12;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function readTimeInput(input, { min, max }) {
  const n = Number(input.value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function collectSlots() {
  return [...els.slots.querySelectorAll(".slot-row")]
    .map((row) => {
      const hourInput = row.querySelector(".time-hour");
      const minuteInput = row.querySelector(".time-minute");
      const hour12 = readTimeInput(hourInput, { min: 1, max: 12 });
      const minute = readTimeInput(minuteInput, { min: 0, max: 59 });
      hourInput.value = pad2(hour12);
      minuteInput.value = pad2(minute);
      const ampm = row.querySelector(".ampm-btn.active")?.dataset.ampm || "AM";
      return toHhMm(hour12, minute, ampm);
    })
    .filter(Boolean);
}

function renderSlots(slotValues) {
  els.slots.innerHTML = "";
  const list = (slotValues || []).slice(0, MAX_SLOTS);
  for (const value of list) addSlotRow(value);
  els.btnAddSlot.disabled = list.length >= MAX_SLOTS;
}

function clampInput(input, { min, max }) {
  const n = readTimeInput(input, { min, max });
  input.value = pad2(n);
  return n;
}

function makeNumberField({ className, value, min, max, ariaLabel }) {
  const input = document.createElement("input");
  input.type = "number";
  input.className = `time-value ${className}`;
  input.min = String(min);
  input.max = String(max);
  input.step = "1";
  input.inputMode = "numeric";
  input.setAttribute("aria-label", ariaLabel);
  input.value = pad2(value);

  input.addEventListener("change", () => clampInput(input, { min, max }));
  input.addEventListener("blur", () => clampInput(input, { min, max }));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      clampInput(input, { min, max });
      input.blur();
    }
  });

  const up = document.createElement("button");
  up.type = "button";
  up.className = "time-step";
  up.setAttribute("aria-label", `Increase ${ariaLabel}`);
  up.textContent = "+";
  const down = document.createElement("button");
  down.type = "button";
  down.className = "time-step";
  down.setAttribute("aria-label", `Decrease ${ariaLabel}`);
  down.textContent = "−";

  const bump = (dir) => {
    let n = readTimeInput(input, { min, max }) + dir;
    if (n > max) n = min;
    if (n < min) n = max;
    input.value = pad2(n);
  };
  up.addEventListener("click", () => bump(1));
  down.addEventListener("click", () => bump(-1));

  return { input, up, down };
}

function addSlotRow(value = "09:00") {
  if (els.slots.children.length >= MAX_SLOTS) return;
  const { hour12, minute, ampm } = parseHhMm(value);
  const row = document.createElement("div");
  row.className = "slot-row time-slot";

  const face = document.createElement("div");
  face.className = "time-face";

  const hourCol = document.createElement("div");
  hourCol.className = "time-col";
  const hourField = makeNumberField({
    className: "time-hour",
    value: hour12,
    min: 1,
    max: 12,
    ariaLabel: "Hour",
  });
  hourCol.append(hourField.up, hourField.input, hourField.down);

  const colon = document.createElement("div");
  colon.className = "time-colon";
  colon.textContent = ":";

  const minCol = document.createElement("div");
  minCol.className = "time-col";
  const minField = makeNumberField({
    className: "time-minute",
    value: minute,
    min: 0,
    max: 59,
    ariaLabel: "Minute",
  });
  minCol.append(minField.up, minField.input, minField.down);

  const ampmWrap = document.createElement("div");
  ampmWrap.className = "ampm";
  for (const label of ["AM", "PM"]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ampm-btn" + (label === ampm ? " active" : "");
    btn.dataset.ampm = label;
    btn.textContent = label;
    btn.addEventListener("click", () => {
      ampmWrap.querySelectorAll(".ampm-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    });
    ampmWrap.appendChild(btn);
  }

  face.append(hourCol, colon, minCol, ampmWrap);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "secondary";
  remove.textContent = "Remove";
  remove.addEventListener("click", () => {
    row.remove();
    els.btnAddSlot.disabled = els.slots.children.length >= MAX_SLOTS;
  });

  row.append(face, remove);
  els.slots.appendChild(row);
  els.btnAddSlot.disabled = els.slots.children.length >= MAX_SLOTS;
}

function fillBlankIdentity(suggested) {
  if (!suggested) return;
  if (!els.firstName.value.trim() && suggested.firstName) {
    els.firstName.value = suggested.firstName;
  }
  if (!els.lastName.value.trim() && suggested.lastName) {
    els.lastName.value = suggested.lastName;
  }
  if (!els.role.value.trim() && suggested.role) {
    els.role.value = suggested.role;
  }
}

function updateIdentitySource(resolved) {
  if (!els.identitySource) return;
  if (!resolved) {
    els.identitySource.textContent = "Using: —";
    return;
  }
  const a = resolved.firstName || "X";
  const b = resolved.lastName || "X";
  const c = resolved.role || "X";
  els.identitySource.textContent = `Using for rename: ${a} / ${b} / ${c}`;
}

async function refreshPreview() {
  const name = await window.api.previewResumeName({
    firstName: els.firstName.value,
    lastName: els.lastName.value,
    role: els.role.value,
  });
  els.resumePreview.textContent = name || "—";
}

function applyState(state) {
  applyingState = true;
  const s = state.settings || {};
  if (els.runnerRevision) {
    const rev = state.runnerRevision || "(unknown — quit app fully and npm start again)";
    els.runnerRevision.textContent = `Runner: ${rev}`;
    els.runnerRevision.classList.toggle(
      "bad",
      !state.runnerRevision || !String(state.runnerRevision).startsWith("bump-custom-v4"),
    );
  }
  els.firstName.value = s.firstName || "";
  els.lastName.value = s.lastName || "";
  els.role.value = s.role || "";
  // If saved settings left name fields blank, fill from the resume file name
  if (state.resolvedIdentity) {
    fillBlankIdentity(state.resolvedIdentity);
    updateIdentitySource({
      firstName: els.firstName.value.trim() || state.resolvedIdentity.firstName,
      lastName: els.lastName.value.trim() || state.resolvedIdentity.lastName,
      role: els.role.value.trim() || state.resolvedIdentity.role,
    });
  }
  els.scheduleEnabled.checked = Boolean(s.scheduleEnabled);
  if (els.showBrowserDuringRun) {
    els.showBrowserDuringRun.checked = s.showBrowserDuringRun !== false;
  }
  renderSlots(s.slots || []);

  if (s.sourceResumePath) {
    els.resumePath.textContent = s.sourceResumePath;
    els.resumePath.classList.remove("muted");
  } else {
    els.resumePath.textContent = "No PDF selected";
    els.resumePath.classList.add("muted");
  }

  const mode = s.bumpMode === "custom" ? "custom" : "dot";
  els.bumpModeDot.checked = mode === "dot";
  els.bumpModeCustom.checked = mode === "custom";
  const legacy = s.customBumpText || "";
  els.customHeadlineText.value = s.customHeadlineText || legacy;
  els.customSummaryText.value = s.customSummaryText || legacy;
  syncBumpModeUi();

  syncConnectUi(state.connected, s.connectedAt);

  if (state.nextRun) {
    const parts = parseHhMm(state.nextRun.slot);
    els.nextRun.textContent = `Next run: ${state.nextRun.day} ${pad2(parts.hour12)}:${pad2(parts.minute)} ${parts.ampm}`;
    els.nextRun.classList.remove("muted");
  } else {
    els.nextRun.textContent = "Next run: —";
    els.nextRun.classList.add("muted");
  }

  if (s.lastRunResult) {
    const ok = /ok/i.test(String(s.lastRunResult));
    setStatus(
      els.lastResult,
      s.lastRunAt
        ? `Last: ${s.lastRunResult} @ ${new Date(s.lastRunAt).toLocaleString()}`
        : String(s.lastRunResult),
      ok ? "ok" : "bad",
    );
  } else {
    setStatus(els.lastResult, "No runs yet", "muted");
  }

  if (!ignoreStoredLogTail) {
    els.log.textContent = state.logTail || "";
  }
  els.btnRun.disabled = Boolean(state.running);
  refreshPreview();
  applyingState = false;
}

function appendLog(line) {
  const prev = els.log.textContent ? `${els.log.textContent}\n` : "";
  els.log.textContent = `${prev}${line}`;
  els.log.scrollTop = els.log.scrollHeight;
}

async function saveSettings({ quiet = false, forRun = false } = {}) {
  const bumpMode = selectedBumpMode();
  const partial = {
    firstName: els.firstName.value.trim(),
    lastName: els.lastName.value.trim(),
    role: els.role.value.trim(),
    bumpMode,
    customHeadlineText: els.customHeadlineText.value.trim(),
    customSummaryText: els.customSummaryText.value.trim(),
    customBumpText: "",
    scheduleEnabled: els.scheduleEnabled.checked,
    showBrowserDuringRun: els.showBrowserDuringRun
      ? els.showBrowserDuringRun.checked
      : true,
    slots: collectSlots(),
    quiet,
  };
  if (
    forRun &&
    bumpMode === "custom" &&
    (!partial.customHeadlineText || !partial.customSummaryText)
  ) {
    setStatus(
      els.lastResult,
      "Custom mode needs both Resume headline and Profile summary text filled.",
      "bad",
    );
    return { ok: false };
  }
  const result = await window.api.saveSettings(partial);
  if (!result.ok) {
    if (!quiet) {
      setStatus(els.lastResult, result.error || "Save failed", "bad");
    } else if (els.autoSaveStatus) {
      els.autoSaveStatus.textContent = result.error || "Auto-save failed";
    }
    return result;
  }
  if (quiet) {
    if (els.autoSaveStatus) {
      els.autoSaveStatus.textContent = `Auto-saved ${new Date().toLocaleTimeString()}`;
    }
    return result;
  }
  const state = await window.api.getState();
  applyState(state);
  setStatus(els.lastResult, "Settings saved", "ok");
  return result;
}

function scheduleAutoSave() {
  if (applyingState) return;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    saveSettings({ quiet: true }).catch(() => {});
  }, 450);
}

els.btnAddSlot.addEventListener("click", () => addSlotRow("09:00"));

els.btnEvery4h.addEventListener("click", () => {
  const existing = collectSlots();
  const start = existing[0] || "09:00";
  const [h0, m0] = start.split(":").map(Number);
  const generated = [];
  for (let i = 0; i < MAX_SLOTS; i++) {
    const total = h0 * 60 + m0 + i * 4 * 60;
    const hh = ((Math.floor(total / 60) % 24) + 24) % 24;
    const mm = ((total % 60) + 60) % 60;
    generated.push(`${pad2(hh)}:${pad2(mm)}`);
  }
  renderSlots(generated);
  scheduleAutoSave();
});
els.btnPickResume.addEventListener("click", async () => {
  const result = await window.api.pickResume();
  if (result.canceled) return;
  if (!result.ok) {
    setStatus(els.lastResult, result.error || "Could not pick resume", "bad");
    return;
  }
  els.resumePath.textContent = result.sourceResumePath;
  els.resumePath.classList.remove("muted");
  fillBlankIdentity(result.suggested);
  updateIdentitySource({
    firstName: els.firstName.value.trim() || result.suggested?.firstName,
    lastName: els.lastName.value.trim() || result.suggested?.lastName,
    role: els.role.value.trim() || result.suggested?.role,
  });
  refreshPreview().catch(() => {});
  scheduleAutoSave();
});

els.bumpModeDot.addEventListener("change", () => {
  syncBumpModeUi();
  scheduleAutoSave();
});
els.bumpModeCustom.addEventListener("change", () => {
  syncBumpModeUi();
  scheduleAutoSave();
});

els.btnClearLog.addEventListener("click", async () => {
  // Clear the in-app Status log only (not Cursor's terminal).
  els.log.textContent = "";
  ignoreStoredLogTail = true;
  setStatus(els.lastResult, "Status log cleared", "ok");
  try {
    if (typeof window.api.clearLog === "function") {
      await window.api.clearLog();
      // File cleared — safe to show future stored tails again.
      ignoreStoredLogTail = false;
    }
  } catch {
    // Old Electron process without clear-log handler: keep ignoring stored tail
    // so applyState after Run won't paste the old log back.
  }
});

els.btnConnect.addEventListener("click", async () => {
  els.btnConnect.disabled = true;
  setStatus(els.connStatus, "Opening Chrome… sign in to Naukri", "muted");
  const result = await window.api.connectAccount();
  els.btnConnect.disabled = false;
  if (result.ok) {
    syncConnectUi(true, result.connectedAt);
  } else {
    setStatus(els.connStatus, result.error || "Connect failed", "bad");
  }
});

els.btnRun.addEventListener("click", async () => {
  const saved = await saveSettings({ forRun: true });
  if (saved && saved.ok === false) return;
  els.btnRun.disabled = true;
  setStatus(els.lastResult, "Running…", "muted");
  const result = await window.api.runNow();
  if (result.ok) {
    setStatus(els.lastResult, `Done: ${result.result}`, "ok");
  } else {
    setStatus(els.lastResult, result.error || "Run failed", "bad");
  }
  const state = await window.api.getState();
  applyState(state);
});

for (const input of [
  els.firstName,
  els.lastName,
  els.role,
  els.customHeadlineText,
  els.customSummaryText,
]) {
  input.addEventListener("input", () => {
    updateIdentitySource({
      firstName: els.firstName.value.trim(),
      lastName: els.lastName.value.trim(),
      role: els.role.value.trim(),
    });
    refreshPreview().catch(() => {});
    scheduleAutoSave();
  });
}

els.scheduleEnabled.addEventListener("change", scheduleAutoSave);
if (els.showBrowserDuringRun) {
  els.showBrowserDuringRun.addEventListener("change", scheduleAutoSave);
}

// Slot edits bubble from dynamically created controls
els.slots.addEventListener("change", scheduleAutoSave);
els.slots.addEventListener("click", (e) => {
  if (e.target.closest(".time-step, .ampm-btn, .secondary")) {
    scheduleAutoSave();
  }
});

window.api.onStatus((payload) => {
  if (!payload || !payload.type) return;
  if (payload.type === "log" && payload.line) {
    // Live lines from the current run are always welcome after a clear.
    appendLog(payload.line);
  }
  if (payload.type === "log-cleared") {
    els.log.textContent = "";
    ignoreStoredLogTail = false;
  }
  if (payload.type === "running") els.btnRun.disabled = Boolean(payload.running);
  if (payload.type === "connect-start") {
    setStatus(els.connStatus, "Opening Chrome… sign in to Naukri", "muted");
  }
  if (payload.type === "connect-done") {
    if (payload.ok) syncConnectUi(true);
    else setStatus(els.connStatus, payload.error || "Connect failed", "bad");
  }
  if (payload.type === "done") {
    setStatus(
      els.lastResult,
      payload.ok
        ? `Done: ${payload.result}`
        : payload.error || "Run failed",
      payload.ok ? "ok" : "bad",
    );
  }
  if (payload.type === "saved") {
    window.api.getState().then(applyState).catch(() => {});
  }
});

window.api
  .getState()
  .then(applyState)
  .catch((err) => setStatus(els.lastResult, String(err.message || err), "bad"));
