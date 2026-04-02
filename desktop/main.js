import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import {
  desktopMeta,
  launchBrowserSession,
  saveDesktopSettings,
  stopAllBrowserSessions,
  stopBrowserSession,
} from "./launcher.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;

function desktopConfigPath() {
  return path.join(app.getPath("userData"), "proxy-browser.desktop.json");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 860,
    minWidth: 980,
    minHeight: 720,
    title: "Proxy Browser Desktop",
    backgroundColor: "#09131d",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
}

ipcMain.handle("desktop:get-meta", async () =>
  desktopMeta({ configPath: desktopConfigPath() })
);

ipcMain.handle("desktop:launch-browser", async (_event, payload) => {
  return launchBrowserSession({
    ...(payload || {}),
    configPath: desktopConfigPath(),
  });
});

ipcMain.handle("desktop:stop-browser", async (_event, sessionId) => {
  return stopBrowserSession(sessionId);
});

ipcMain.handle("desktop:stop-all", async () => {
  return stopAllBrowserSessions();
});

ipcMain.handle("desktop:open-external", async (_event, url) => {
  await shell.openExternal(String(url || ""));
  return true;
});

ipcMain.handle("desktop:save-settings", async (_event, payload) => {
  return saveDesktopSettings({
    configPath: desktopConfigPath(),
    settings: payload || {},
  });
});

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  stopAllBrowserSessions().catch(() => {});
});
