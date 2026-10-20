// electron/preload.js — Bridge between Electron's sandboxed renderer
// and the main process. Exposes a tiny `sag` API on window for the
// React UI to call into the main process (open logs dir, restart
// backend, etc.) without giving the renderer Node access.
//
// Keep this surface minimal. Every method here is a privilege grant:
// the user is trusting the renderer to call it for legitimate reasons.
// Don't expose `shell`, `child_process`, or anything that could be
// abused into code execution.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sag", {
  getLogsDir: () => ipcRenderer.invoke("sag:get-logs-dir"),
  openLogsDir: () => ipcRenderer.invoke("sag:open-logs-dir"),
  openDataDir: () => ipcRenderer.invoke("sag:open-data-dir"),
  restartBackend: () => ipcRenderer.invoke("sag:restart-backend"),
  getVersion: () => ipcRenderer.invoke("sag:get-version"),
});