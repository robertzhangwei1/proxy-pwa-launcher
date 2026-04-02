import { spawn } from "child_process";
import dotenv from "dotenv";
import fsSync from "fs";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { anonymizeProxy, closeAnonymizedProxy } from "proxy-chain";

dotenv.config({ quiet: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

const activeSessions = new Map();

function readDesktopConfigFile() {
  const candidatePaths = [
    path.join(process.cwd(), "proxy-browser.desktop.json"),
    path.join(path.dirname(process.execPath), "proxy-browser.desktop.json"),
    path.join(PROJECT_ROOT, "proxy-browser.desktop.json"),
  ];

  for (const candidatePath of candidatePaths) {
    if (!fsSync.existsSync(candidatePath)) {
      continue;
    }

    try {
      return JSON.parse(fsSync.readFileSync(candidatePath, "utf8"));
    } catch {
      continue;
    }
  }

  return {};
}

const FILE_CONFIG = readDesktopConfigFile();
const FILE_PROXY = FILE_CONFIG.proxy || {};

const DEFAULT_PROXY_PROTOCOL =
  process.env.DESKTOP_PROXY_PROTOCOL ||
  process.env.DEFAULT_PROXY_PROTOCOL ||
  FILE_PROXY.protocol ||
  "http";
const DEFAULT_PROXY_HOST =
  process.env.DESKTOP_PROXY_HOST ||
  process.env.DEFAULT_PROXY_HOST ||
  FILE_PROXY.host ||
  "geo.iproyal.com";
const DEFAULT_PROXY_PORT =
  process.env.DESKTOP_PROXY_PORT ||
  process.env.DEFAULT_PROXY_PORT ||
  FILE_PROXY.port ||
  "12321";
const DEFAULT_PROXY_USERNAME =
  process.env.DESKTOP_PROXY_USERNAME ||
  process.env.DEFAULT_PROXY_USERNAME ||
  FILE_PROXY.username ||
  "5YzAQaZQMzdWkYTM";
const DEFAULT_PROXY_PASSWORD =
  process.env.DESKTOP_PROXY_PASSWORD ||
  process.env.DEFAULT_PROXY_PASSWORD ||
  FILE_PROXY.password ||
  "";
const DEFAULT_PROXY_BYPASS =
  process.env.DESKTOP_PROXY_BYPASS ||
  process.env.DEFAULT_PROXY_BYPASS ||
  FILE_PROXY.bypass ||
  "localhost;127.0.0.1;<local>";
const DEFAULT_TARGET_URL =
  process.env.DESKTOP_DEFAULT_URL ||
  FILE_CONFIG.defaultTargetUrl ||
  "https://www.google.com";
const CONFIGURED_BROWSER_PATH =
  process.env.DESKTOP_BROWSER_PATH ||
  FILE_CONFIG.browserPath ||
  "";

const WINDOWS_BROWSER_CANDIDATES = [
  {
    id: "chrome",
    name: "Google Chrome",
    paths: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ],
  },
  {
    id: "edge",
    name: "Microsoft Edge",
    paths: [
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ],
  },
];

function normalizeTargetUrl(rawUrl) {
  const trimmed = String(rawUrl || DEFAULT_TARGET_URL).trim();
  const withProtocol = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return new URL(withProtocol).toString();
}

async function pathExists(candidatePath) {
  try {
    await fs.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

export async function discoverBrowsers() {
  const found = [];

  if (CONFIGURED_BROWSER_PATH && (await pathExists(CONFIGURED_BROWSER_PATH))) {
    found.push({
      id: "custom",
      name: "Configured Browser",
      path: CONFIGURED_BROWSER_PATH,
    });
  }

  for (const candidate of WINDOWS_BROWSER_CANDIDATES) {
    for (const candidatePath of candidate.paths) {
      if (await pathExists(candidatePath)) {
        if (found.some((browser) => browser.path === candidatePath)) {
          break;
        }

        found.push({
          id: candidate.id,
          name: candidate.name,
          path: candidatePath,
        });
        break;
      }
    }
  }

  return found;
}

function proxyConfig() {
  return {
    protocol: DEFAULT_PROXY_PROTOCOL,
    host: DEFAULT_PROXY_HOST,
    port: DEFAULT_PROXY_PORT,
    username: DEFAULT_PROXY_USERNAME,
    password: DEFAULT_PROXY_PASSWORD,
    bypass: DEFAULT_PROXY_BYPASS,
  };
}

function proxyReady() {
  const config = proxyConfig();
  return Boolean(config.host && config.port && config.username && config.password);
}

function redactProxy(config) {
  if (!config.host) {
    return null;
  }

  return {
    protocol: config.protocol,
    host: config.host,
    port: config.port,
    username: config.username ? `${config.username.slice(0, 4)}...` : "",
    passwordSet: Boolean(config.password),
    bypass: config.bypass,
  };
}

function buildUpstreamProxyUrl(config) {
  if (!proxyReady()) {
    throw new Error("Desktop proxy settings are incomplete. Add DESKTOP_PROXY_PASSWORD or DEFAULT_PROXY_PASSWORD before launching.");
  }

  const username = encodeURIComponent(config.username || "");
  const password = encodeURIComponent(config.password || "");
  return `${config.protocol}://${username}:${password}@${config.host}:${config.port}`;
}

function sessionRoot() {
  return path.join(os.homedir(), "AppData", "Local", "ProxyBrowserDesktop", "sessions");
}

function createSessionId() {
  return `session-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
}

async function resolveBrowser(browserId) {
  const browsers = await discoverBrowsers();

  if (!browsers.length) {
    throw new Error("No supported desktop browser was found. Install Chrome or Edge first.");
  }

  if (!browserId) {
    return browsers[0];
  }

  const chosen = browsers.find((browser) => browser.id === browserId);

  if (!chosen) {
    throw new Error(`Browser "${browserId}" is not available on this machine.`);
  }

  return chosen;
}

function browserArgs({ targetUrl, profileDir, localProxyUrl, bypass }) {
  const localUrl = new URL(localProxyUrl);
  const args = [
    `--user-data-dir=${profileDir}`,
    `--proxy-server=${localUrl.protocol}//${localUrl.host}`,
    "--new-window",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
  ];

  if (bypass) {
    args.push(`--proxy-bypass-list=${bypass}`);
  }

  args.push(targetUrl);
  return args;
}

async function killProcessTree(pid) {
  await new Promise((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });

    killer.once("exit", () => resolve());
    killer.once("error", () => resolve());
  });
}

async function cleanupSession(sessionId) {
  const session = activeSessions.get(sessionId);

  if (!session) {
    return;
  }

  activeSessions.delete(sessionId);

  if (session.localProxyUrl) {
    await closeAnonymizedProxy(session.localProxyUrl, true).catch(() => {});
  }

  if (session.profileDir) {
    await fs.rm(session.profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function launchBrowserSession({ browserId, targetUrl } = {}) {
  const browser = await resolveBrowser(browserId);
  const config = proxyConfig();
  const normalizedUrl = normalizeTargetUrl(targetUrl);
  const upstreamProxyUrl = buildUpstreamProxyUrl(config);
  const localProxyUrl = await anonymizeProxy(upstreamProxyUrl);
  const sessionId = createSessionId();
  const profileDir = path.join(sessionRoot(), sessionId);

  await fs.mkdir(profileDir, { recursive: true });

  const child = spawn(
    browser.path,
    browserArgs({
      targetUrl: normalizedUrl,
      profileDir,
      localProxyUrl,
      bypass: config.bypass,
    }),
    {
      detached: false,
      stdio: "ignore",
      windowsHide: false,
    }
  );

  const session = {
    id: sessionId,
    browserId: browser.id,
    browserName: browser.name,
    browserPath: browser.path,
    targetUrl: normalizedUrl,
    profileDir,
    localProxyUrl,
    pid: child.pid,
    startedAt: new Date().toISOString(),
  };

  activeSessions.set(sessionId, session);

  child.once("exit", () => {
    cleanupSession(sessionId).catch(() => {});
  });

  child.once("error", () => {
    cleanupSession(sessionId).catch(() => {});
  });

  child.unref();

  return {
    session,
    message: `${browser.name} launched through the local proxy bridge.`,
  };
}

export async function stopBrowserSession(sessionId) {
  const session = activeSessions.get(sessionId);

  if (!session) {
    return {
      message: "That browser session is already closed.",
    };
  }

  if (session.pid) {
    await killProcessTree(session.pid).catch(() => {});
  }

  await cleanupSession(sessionId);

  return {
    message: "Browser session stopped.",
  };
}

export async function stopAllBrowserSessions() {
  const sessionIds = [...activeSessions.keys()];

  for (const sessionId of sessionIds) {
    await stopBrowserSession(sessionId);
  }

  return {
    message: sessionIds.length
      ? "All launched browser sessions were stopped."
      : "No launched browser sessions were active.",
  };
}

export async function desktopMeta() {
  const browsers = await discoverBrowsers();
  const config = proxyConfig();

  return {
    defaultTargetUrl: DEFAULT_TARGET_URL,
    browsers,
    proxyReady: proxyReady(),
    proxy: redactProxy(config),
    configFileDetected: Boolean(Object.keys(FILE_CONFIG).length),
    activeSessions: [...activeSessions.values()].map((session) => ({
      id: session.id,
      browserId: session.browserId,
      browserName: session.browserName,
      targetUrl: session.targetUrl,
      pid: session.pid,
      startedAt: session.startedAt,
    })),
  };
}
