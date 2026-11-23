async function api(path, options = {}) {
  const opts = { credentials: "same-origin", ...options };
  if (opts.body && typeof opts.body === "object" && !(opts.body instanceof FormData)) {
    opts.headers = {
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    };
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, opts);
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    return res.json();
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return res;
}

window.api = {
  getState: () => api("/api/state"),
  saveSettings: (partial) =>
    api("/api/settings", { method: "PATCH", body: partial }),
  previewResumeName: async (partial) => {
    const r = await api("/api/preview-resume-name", {
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
  clearLog: () => api("/api/clear-log", { method: "POST", body: {} }),
  connectAccount: () => api("/api/connect/start", { method: "POST", body: {} }),
  cancelConnect: () => api("/api/connect/cancel", { method: "POST", body: {} }),
  connectStatus: () => api("/api/connect/status"),
  connectInput: (action) =>
    api("/api/connect/input", { method: "POST", body: action }),
  runNow: () => api("/api/run", { method: "POST", body: {} }),
  onStatus: () => {},
};
