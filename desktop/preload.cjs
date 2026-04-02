const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopApi", {
  getMeta: () => ipcRenderer.invoke("desktop:get-meta"),
  launchBrowser: (payload) => ipcRenderer.invoke("desktop:launch-browser", payload),
  stopBrowser: (sessionId) => ipcRenderer.invoke("desktop:stop-browser", sessionId),
  stopAll: () => ipcRenderer.invoke("desktop:stop-all"),
  openExternal: (url) => ipcRenderer.invoke("desktop:open-external", url),
});
