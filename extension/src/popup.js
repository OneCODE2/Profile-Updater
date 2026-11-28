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
  for (let i = 0; i < 24 * 60; i += 1) {
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
  let timer = 0;
  let painting = false;
  let editingTimes = false;

  const slotsFromForm = () =>
    [...document.querySelectorAll(".slot-input")].map((input) => input.value).filter(Boolean);

  const patchFromForm = () => {
    const patch = {
      actions: {
        headline: $("act-headline").checked,
        summary: $("act-summary").checked,
        resume: $("act-resume").checked,
      },
      termsAcknowledged: $("terms").checked,
      scheduleEnabled: $("schedule-enabled").checked,
      accountConfirmed: $("confirm-account").checked,
    };
    const timesChanged =
      $("standard-times").checked || editingTimes || current?.settings.scheduleMode !== "interval";
    if (timesChanged) {
      patch.scheduleMode = "custom";
      patch.customSlots = $("standard-times").checked ? STANDARD_TIMES.slice() : slotsFromForm();
    }
    return patch;
  };

  const syncTimes = () => {
    $("standard-summary").hidden = !$("standard-times").checked;
  };

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
        editingTimes = true;
        $("standard-times").checked = false;
        syncTimes();
        queue();
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        const next = slotsFromForm().filter((_, slotIndex) => slotIndex !== index);
        editingTimes = true;
        $("standard-times").checked = false;
        renderSlots(next);
        syncTimes();
        queue();
      });
      row.append(input, remove);
      host.append(row);
    });
  };

  const render = (state) => {
    current = state;
    painting = true;
    text($("connection"), connectionLabel(state.connection));
    text(
      $("verified"),
      state.connection.verifiedAt ? `Last checked ${whenLabel(state.connection.verifiedAt)}` : "Not checked yet.",
    );
    $("connect").hidden = state.connection.status === "connected_last_verified";
    $("act-headline").checked = !!state.settings.actions.headline;
    $("act-summary").checked = !!state.settings.actions.summary;
    $("act-resume").checked = !!state.settings.actions.resume;
    $("terms").checked = !!state.settings.termsAcknowledged;
    $("schedule-enabled").checked = !!state.settings.scheduleEnabled;
    $("confirm-account").checked = !!state.settings.accountConfirmed;
    editingTimes = false;
    renderSlots(state.settings.customSlots || []);
    syncTimes();
    text($("next-run"), state.nextRun ? `Next run: ${slotWhen(state.nextRun.slotKey)}` : "Next run: off");
    const list = $("today");
    list.replaceChildren();
    for (const slot of state.today || []) {
      const item = document.createElement("li");
      item.textContent = `${slot.slot} — ${slotStatusLabel(slot.status)}`;
      list.append(item);
    }
    const last = state.lastResult;
    text(
      $("last-success"),
      state.lastConfirmedMutationAt ? `Last update ${whenLabel(state.lastConfirmedMutationAt)}` : "",
    );
    const bad = last && !["success", "no_changes", "cancelled"].includes(last.status);
    text($("warning"), bad ? last.message || last.status : "");
    text($("progress"), state.activeRun?.progress || "");
    text(
      $("pdf"),
      state.resumeMeta
        ? `${state.resumeMeta.originalName} · ${sizeLabel(state.resumeMeta.size)}`
        : "No PDF selected",
    );
    text($("pdf-label"), state.resumeMeta ? "Change resume" : "Add resume");
    const gate = runNowDisabled(state);
    $("run-now").disabled = gate.disabled;
    text($("run-reason"), gate.reason || "");
    $("cancel").hidden = !state.activeRun;
    $("discard").hidden = !state.reviewRequired;
    painting = false;
    watch(state);
  };

  const refresh = async () => {
    const response = await chrome.runtime.sendMessage({ type: "GET_STATE" });
    if (response?.state) render(response.state);
  };

  async function flush() {
    if (!current) return;
    const response = await chrome.runtime.sendMessage({
      type: "SAVE_SETTINGS",
      patch: patchFromForm(),
      revision: current.settings.revision,
    });
    text($("run-reason"), response?.ok ? "" : response?.message || "");
    if (response?.state) render(response.state);
  }

  function queue() {
    if (painting) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      void flush();
    }, 300);
  }

  for (const id of ["act-headline", "act-summary", "act-resume", "terms", "schedule-enabled", "confirm-account"]) {
    $(id).addEventListener("change", queue);
  }
  $("standard-times").addEventListener("change", () => {
    editingTimes = true;
    if ($("standard-times").checked) renderSlots(STANDARD_TIMES);
    syncTimes();
    queue();
  });
  $("add-time").addEventListener("click", () => {
    const slots = slotsFromForm();
    if (slots.length >= 4) return;
    editingTimes = true;
    $("standard-times").checked = false;
    slots.push(minuteFromNow(slots));
    renderSlots(slots);
    syncTimes();
    queue();
  });
  $("connect").addEventListener("click", async () => {
    text($("connection"), "Opening Naukri…");
    try {
      const response = await chrome.runtime.sendMessage({ type: "CHECK_CONNECTION" });
      if (response && response.ok === false) {
        text($("warning"), response.message || "Could not load or verify Naukri profile.");
      }
      await refresh();
    } catch (err) {
      text($("warning"), err?.message || "Could not load or verify Naukri profile.");
    }
  });
  $("run-now").addEventListener("click", async () => {
    text($("progress"), "Starting…");
    text($("warning"), "");
    let failure = "";
    try {
      await flush();
      const response = await chrome.runtime.sendMessage({
        type: "RUN_NOW",
        confirmAccount: $("confirm-account").checked,
      });
      if (response && response.ok === false) failure = response.message || "Could not start the run.";
    } catch (err) {
      failure = err?.message || "Could not start the run.";
    }
    await refresh();
    if (failure) text($("warning"), failure);
  });
  $("cancel").addEventListener("click", async () => {
    text($("progress"), "Cancelling…");
    try {
      const response = await chrome.runtime.sendMessage({ type: "CANCEL_RUN" });
      if (response && response.ok === false) text($("warning"), response.message || "Could not cancel the run.");
      await refresh();
    } catch (err) {
      text($("warning"), err?.message || "Could not cancel the run.");
    }
  });
  $("discard").addEventListener("click", async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: "DISCARD_JOURNAL" });
      if (response && response.ok === false) text($("warning"), response.message || "Could not clear the unfinished update.");
      await refresh();
    } catch (err) {
      text($("warning"), err?.message || "Could not clear the unfinished update.");
    }
  });
  $("open-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("pdf-file").addEventListener("change", async () => {
    const file = $("pdf-file").files && $("pdf-file").files[0];
    if (!file) return;
    text($("pdf"), "Reading PDF…");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
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
      await refresh();
    } catch (err) {
      text($("pdf-error"), err?.message || "Choose a PDF under 6 MB");
    }
    $("pdf-file").value = "";
  });

  let poll = 0;
  const watch = (state) => {
    if (state?.activeRun && !poll) poll = setInterval(() => void refresh(), 1000);
    if (!state?.activeRun && poll) {
      clearInterval(poll);
      poll = 0;
    }
  };

  refresh();
}

boot();

module.exports = { boot, connectionLabel };
