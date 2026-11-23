const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  getState: () => ipcRenderer.invoke("get-state"),
  saveSettings: (partial) => ipcRenderer.invoke("save-settings", partial),
  pickResume: () => ipcRenderer.invoke("pick-resume"),
  connectAccount: () => ipcRenderer.invoke("connect-account"),
  runNow: () => ipcRenderer.invoke("run-now"),
  clearLog: () => ipcRenderer.invoke("clear-log"),
  previewResumeName: (identity) =>
    ipcRenderer.invoke("preview-resume-name", identity),
  onStatus: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("status", handler);
    return () => ipcRenderer.removeListener("status", handler);
  },
});
