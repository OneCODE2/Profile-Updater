const { describeIdentity } = require("../../shared/filename");
const { runNowDisabled } = require("./engine");
const { connectionLabel, whenLabel, slotWhen, sizeLabel, slotStatusLabel } = require("./labels");

const STANDARD_TIMES = ["09:00", "11:30", "14:00", "16:00"];

const text = (el, value) => {
  if (el) el.textContent = value == null ? "" : String(value);
};

const padTime = (value) => String(value).padStart(2, "0");

const minuteFromNow = (taken) => {
  const used = new Set(taken);
  const date = new Date(Date.now() + 60 * 1000);
  for (let i = 0; i < 24 * 60; i++) {
    const stamp = `${padTime(date.getHours())}:${padTime(date.getMinutes())}`;
    if (!used.has(stamp)) return stamp;
    date.setMinutes(date.getMinutes() + 1);
  }
  return "09:00";
};

function boot() {
  if (typeof document === "undefined" || !globalThis.chrome?.runtime) return;
  const $ = (id) => document.getElementById(id);
  let current = null;
  let pending = null;
  let timer = 0;

  const slotsFromForm = () =>
    [...document.querySelectorAll(".slot-input")].map((input) => input.value).filter(Boolean);

  const patchFromForm = () => ({
    actions: {
      headline: $("act-headline").checked,
      summary: $("act-summary").checked,
      resume: $("act-resume").checked,
    },
    bumpMode: $("mode").value,
    customHeadlineText: $("custom-headline").value,
    customSummaryText: $("custom-summary").value,
    firstName: $("first-name").value,
    lastName: $("last-name").value,
    role: $("role").value,
    termsAcknowledged: $("terms").checked,
    scheduleEnabled: $("schedule-enabled").checked,
    scheduleMode: $("every-4h").checked ? "interval" : "custom",
    customSlots: $("standard-times").checked ? STANDARD_TIMES.slice() : slotsFromForm(),
    intervalAnchor: $("anchor").value || "09:00",
    accountConfirmed: $("confirm-account").checked,
  });

  const renderSlots = (slots) => {
    const host = $("custom-times");
    host.replaceChildren();
    (slots || []).forEach((slot, index) => {
      const row = document.createElement("div");
      row.className = "time-row";
      const input = document.createElement("input");
      input.type = "time";
      input.className = "slot-input";
      input.value = slot;
      input.setAttribute("aria-label", `Time ${index + 1}`);
      input.addEventListener("change", () => {
        $("standard-times").checked = false;
        queue();
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "secondary";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        const next = slotsFromForm().filter((_, slotIndex) => slotIndex !== index);
        $("standard-times").checked = false;
        renderSlots(next);
        queue();
      });
      row.append(input, remove);
      host.append(row);
    });
  };

  const syncPanels = () => {
    $("custom-fields").hidden = $("mode").value !== "custom";
    const interval = $("every-4h").checked;
    $("custom-schedule").hidden = interval;
    $("interval-schedule").hidden = !interval;
    $("standard-summary").hidden = interval || !$("standard-times").checked;
  };

  const render = (state) => {
    current = state;
    text($("version"), state.version);
    text($("connection"), connectionLabel(state.connection));
    text(
      $("verified"),
      state.connection.verifiedAt ? `Last checked ${whenLabel(state.connection.verifiedAt)}` : "Not checked yet.",
    );
    $("act-headline").checked = !!state.settings.actions.headline;
    $("act-summary").checked = !!state.settings.actions.summary;
    $("act-resume").checked = !!state.settings.actions.resume;
    $("mode").value = state.settings.bumpMode === "custom" ? "custom" : "dot";
    $("custom-headline").value = state.settings.customHeadlineText || "";
    $("custom-summary").value = state.settings.customSummaryText || "";
    $("custom-headline").disabled = state.settings.bumpMode !== "custom" || !state.settings.actions.headline;
    $("custom-summary").disabled = state.settings.bumpMode !== "custom" || !state.settings.actions.summary;
    $("first-name").value = state.settings.firstName || "";
    $("last-name").value = state.settings.lastName || "";
    $("role").value = state.settings.role || "";
    $("terms").checked = !!state.settings.termsAcknowledged;
    $("schedule-enabled").checked = !!state.settings.scheduleEnabled;
    $("every-4h").checked = state.settings.scheduleMode === "interval";
    $("anchor").value = state.settings.intervalAnchor || "09:00";
    renderSlots(state.settings.customSlots || []);
    text(
      $("pdf"),
      state.resumeMeta
        ? `${state.resumeMeta.originalName} · ${sizeLabel(state.resumeMeta.size)}`
        : "No PDF selected",
    );
    const named = describeIdentity(state.settings, state.resumeMeta?.originalName || "");
    text($("identity"), named.ok ? "" : named.message);
    text($("preview"), named.ok ? named.fileName : "—");
    const slots = state.effectiveSlots || [];
    text($("effective"), slots.length ? `Times: ${slots.join(", ")}` : "Add at least one time.");
    text($("zone"), `Times follow ${state.timeZone}. Up to 4 a day.`);
    text($("next-run"), state.nextRun ? `Next run: ${slotWhen(state.nextRun.slotKey)}` : "Next run: off");
    const today = $("today");
    today.replaceChildren();
    for (const slot of state.today || []) {
      const item = document.createElement("li");
      item.textContent = `${slot.slot} — ${slotStatusLabel(slot.status)}`;
      today.append(item);
    }
    syncPanels();
    text($("progress"), state.activeRun?.progress || (state.activeRun ? "Run in progress" : ""));
    const gate = runNowDisabled({
      ...state,
      settings: { ...state.settings, accountConfirmed: state.settings.accountConfirmed || $("confirm-account").checked },
    });
    $("run-now").disabled = gate.disabled;
    text($("run-reason"), gate.reason || "");
    $("confirm-account").checked = !!state.settings.accountConfirmed;
    const history = $("history");
    history.replaceChildren();
    for (const row of state.history || []) {
      const item = document.createElement("li");
      const when = whenLabel(row.finishedAt);
      item.textContent = [when, row.message || slotStatusLabel(row.status)].filter(Boolean).join(" — ");
      history.append(item);
    }
    text($("log"), state.logTail || "");
    $("log").hidden = !state.logTail;
    const hasActivity = !!((state.history || []).length || state.logTail);
    if ($("activity-empty")) $("activity-empty").hidden = hasActivity;
    $("clear-log").hidden = !hasActivity;
    $("retry").disabled = !state.lastResult || state.lastResult.status !== "failed_retryable";
    $("review").hidden = !state.reviewRequired;
    $("cancel").hidden = !state.activeRun;
    watch(state);
  };

  async function flush() {
    if (!pending || !current) return;
    const patch = pending;
    pending = null;
    text($("save-state"), "Saving");
    const response = await chrome.runtime.sendMessage({
      type: "SAVE_SETTINGS",
      patch,
      revision: current.settings.revision,
    });
    text($("save-state"), response?.saveState || (response?.ok ? "Saved" : "Error"));
    text($("save-error"), response?.ok ? "" : response?.message || "");
    if (response?.state) render(response.state);
  }

  function queue() {
    syncPanels();
    pending = patchFromForm();
    text($("save-state"), "Saving");
    clearTimeout(timer);
    timer = setTimeout(() => {
      void flush();
    }, 300);
  }

  async function send(type, extra) {
    try {
      await flush();
      const response = await chrome.runtime.sendMessage({ type, ...extra });
      if (response?.message) text($("save-error"), response.ok ? "" : response.message);
      if (response?.detail) text($("pdf-error"), `${response.message}. ${response.detail}`);
      else text($("pdf-error"), response?.ok ? "" : response?.message || "");
      const fresh = await chrome.runtime.sendMessage({ type: "GET_STATE" });
      if (fresh?.state) render(fresh.state);
    } catch (err) {
      text($("save-error"), err?.message || "Could not load or verify Naukri profile.");
    }
  }

  for (const id of [
    "act-headline",
    "act-summary",
    "act-resume",
    "mode",
    "custom-headline",
    "custom-summary",
    "first-name",
    "last-name",
    "role",
    "terms",
    "schedule-enabled",
    "anchor",
    "confirm-account",
  ]) {
    $(id).addEventListener("change", queue);
    $(id).addEventListener("input", queue);
  }

  $("standard-times").addEventListener("change", () => {
    if ($("standard-times").checked) {
      $("every-4h").checked = false;
      renderSlots(STANDARD_TIMES);
    }
    syncPanels();
    queue();
  });
  $("every-4h").addEventListener("change", () => {
    if ($("every-4h").checked) $("standard-times").checked = false;
    syncPanels();
    queue();
  });
  $("add-time").addEventListener("click", () => {
    const slots = slotsFromForm();
    if (slots.length >= 4) return;
    $("standard-times").checked = false;
    slots.push(minuteFromNow(slots));
    renderSlots(slots);
    syncPanels();
    queue();
  });
  $("connect").addEventListener("click", () => {
    text($("connection"), "Opening Naukri…");
    return send("CONNECT");
  });
  $("check").addEventListener("click", () => send("CHECK_CONNECTION"));
  $("disconnect").addEventListener("click", () => send("DISCONNECT"));
  $("remove-pdf").addEventListener("click", () => {
    if (window.confirm("Remove the saved resume copy from this extension?")) void send("REMOVE_RESUME");
  });
  $("pause").addEventListener("click", () => send("PAUSE_TODAY"));
  $("resume-day").addEventListener("click", () => send("RESUME_TODAY"));
  $("run-now").addEventListener("click", () =>
    send("RUN_NOW", { confirmAccount: $("confirm-account").checked }),
  );
  $("retry").addEventListener("click", () => send("RETRY_RUN"));
  $("review").addEventListener("click", () => {
    text($("save-error"), current?.journal ? `Unresolved ${JSON.stringify(current.journal.steps)}` : "");
  });
  $("discard").addEventListener("click", () => {
    if (window.confirm("Discard the unresolved journal? This does not undo Naukri changes.")) {
      void send("DISCARD_JOURNAL");
    }
  });
  $("cancel").addEventListener("click", () => {
    text($("progress"), "Cancelling…");
    return send("CANCEL_RUN");
  });
  $("resume-auto").addEventListener("click", () => send("RESUME_AUTOMATION"));
  $("clear-log").addEventListener("click", () => {
    if (window.confirm("Clear local log and history? Schedule and retry data stay.")) void send("CLEAR_LOG");
  });
  $("reset").addEventListener("click", () => {
    if (window.confirm("Reset all local extension data? Naukri and the original PDF stay.")) {
      void send("RESET_DATA");
    }
  });
  $("pdf-file").addEventListener("change", async () => {
    const file = $("pdf-file").files && $("pdf-file").files[0];
    if (!file) return;
    text($("pdf-error"), "");
    text($("pdf"), "Reading PDF…");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await flush();
      const response = await chrome.runtime.sendMessage({
        type: "PICK_RESUME",
        file: {
          name: file.name,
          byteLength: file.size,
          mime: file.type,
          header: bytes.slice(0, 1024),
          bytes,
        },
      });
      text($("pdf-error"), response?.ok ? "" : response?.message || "Choose a PDF under 6 MB");
      if (response?.detail) text($("pdf-error"), `${response.message}. ${response.detail}`);
      const fresh = await chrome.runtime.sendMessage({ type: "GET_STATE" });
      if (fresh?.state) render(fresh.state);
    } catch (err) {
      text($("pdf-error"), err?.message || "Choose a PDF under 6 MB");
    }
    $("pdf-file").value = "";
  });

  let poll = 0;
  const watch = (state) => {
    if (state?.activeRun && !poll) {
      poll = setInterval(() => {
        if (pending) return;
        chrome.runtime.sendMessage({ type: "GET_STATE" }).then((response) => {
          const next = response?.state;
          if (!next) return;
          if (next.activeRun) {
            current = next;
            text($("progress"), next.activeRun.progress || "Run in progress");
            $("cancel").hidden = false;
            $("run-now").disabled = true;
            return;
          }
          if (current?.activeRun) render(next);
        });
      }, 1000);
    }
    if (!state?.activeRun && poll) {
      clearInterval(poll);
      poll = 0;
    }
  };

  syncPanels();
  chrome.runtime.sendMessage({ type: "GET_STATE" }).then((response) => {
    if (response?.state) render(response.state);
  });
}

boot();

module.exports = { boot };
