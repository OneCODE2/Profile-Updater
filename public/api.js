async function apiRequest(path, options = {}) {
  const opts = { credentials: "same-origin", ...options };
  const timeoutMs = opts.timeoutMs ?? 120000;
  delete opts.timeoutMs;
  if (opts.body && typeof opts.body === "object" && !(opts.body instanceof FormData)) {
    opts.headers = {
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    };
    opts.body = JSON.stringify(opts.body);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  opts.signal = ctrl.signal;
  try {
    const res = await fetch(path, opts);
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      return res.json();
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res;
  } catch (err) {
    if (err && err.name === "AbortError") {
      return { ok: false, error: "Request timed out. Try again." };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

window.api = {
  getState: () => apiRequest("/api/state"),
  saveSettings: (partial) =>
    apiRequest("/api/settings", { method: "PATCH", body: partial }),
  previewResumeName: async (partial) => {
    const r = await apiRequest("/api/preview-resume-name", {
      method: "POST",
      body: partial,
    });
    return r.name || "";
  },
  pickResume: async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/pdf,.pdf";
    return new Promise((resolve) => {
      input.addEventListener("change", async () => {
        const file = input.files && input.files[0];
        if (!file) {
          resolve({ canceled: true });
          return;
        }
        const fd = new FormData();
        fd.append("resume", file, file.name);
        try {
          const res = await fetch("/api/resume", {
            method: "POST",
            body: fd,
            credentials: "same-origin",
          });
          const data = await res.json();
          resolve(data);
        } catch (err) {
          resolve({ ok: false, error: String(err.message || err) });
        }
      });
      input.click();
    });
  },
  clearLog: () => apiRequest("/api/clear-log", { method: "POST", body: {} }),
  connectAccount: () =>
    apiRequest("/api/connect/start", { method: "POST", body: {} }),
  cancelConnect: () =>
    apiRequest("/api/connect/cancel", { method: "POST", body: {} }),
  connectStatus: () => apiRequest("/api/connect/status"),
  connectInput: (action) =>
    apiRequest("/api/connect/input", { method: "POST", body: action }),
  runNow: () => apiRequest("/api/run", { method: "POST", body: {} }),
  onStatus: () => {},
};
