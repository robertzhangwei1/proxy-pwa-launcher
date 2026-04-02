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

const BUILTIN_PROXY_PROTOCOL = "http";
const BUILTIN_PROXY_HOST = "geo.iproyal.com";
const BUILTIN_PROXY_PORT = "12321";
const BUILTIN_PROXY_USERNAME = "5YzAQaZQMzdWkYTM";
const BUILTIN_PROXY_BYPASS = "localhost;127.0.0.1;<local>";
const BUILTIN_DEFAULT_TARGET_URL = "https://www.google.com";

const activeSessions = new Map();

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

const MAC_BROWSER_CANDIDATES = [
  {
    id: "chrome",
    name: "Google Chrome",
    paths: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ],
  },
  {
    id: "edge",
    name: "Microsoft Edge",
    paths: [
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ],
  },
];

function macExecutableDir() {
  if (process.platform !== "darwin") {
    return "";
  }

  return path.dirname(process.execPath);
}

function macAppBundleDir() {
  const executableDir = macExecutableDir();

  if (!executableDir) {
    return "";
  }

  return path.resolve(executableDir, "..", "..");
}

function macAppSiblingDir() {
  const bundleDir = macAppBundleDir();

  if (!bundleDir) {
    return "";
  }

  return path.dirname(bundleDir);
}

function uniquePaths(paths) {
  return [...new Set(paths.filter(Boolean).map((entry) => path.resolve(entry)))];
}

function configCandidatePaths(preferredConfigPath) {
  return uniquePaths([
    preferredConfigPath,
    path.join(process.cwd(), "proxy-browser.desktop.json"),
    path.join(path.dirname(process.execPath), "proxy-browser.desktop.json"),
    path.join(macAppSiblingDir(), "proxy-browser.desktop.json"),
    path.join(PROJECT_ROOT, "proxy-browser.desktop.json"),
  ]);
}

function isConfiguredSecret(rawValue) {
  const normalized = String(rawValue || "").trim();

  if (!normalized) {
    return false;
  }

  return normalized.toLowerCase() !== "replace-with-real-password";
}

function readDesktopConfigFile({ preferredConfigPath } = {}) {
  for (const candidatePath of configCandidatePaths(preferredConfigPath)) {
    if (!fsSync.existsSync(candidatePath)) {
      continue;
    }

    try {
      return {
        config: JSON.parse(fsSync.readFileSync(candidatePath, "utf8")),
        path: candidatePath,
      };
    } catch {
      continue;
    }
  }

  return {
    config: {},
    path: "",
  };
}

function normalizeText(rawValue) {
  return String(rawValue ?? "").trim();
}

function normalizeTargetUrl(rawUrl) {
  const trimmed = normalizeText(rawUrl || BUILTIN_DEFAULT_TARGET_URL);
  const withProtocol = /^[a-z]+:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  return new URL(withProtocol).toString();
}

function normalizeProtocol(rawValue) {
  return normalizeText(rawValue || BUILTIN_PROXY_PROTOCOL).toLowerCase() ||
    BUILTIN_PROXY_PROTOCOL;
}

function resolveRuntimeConfig({ preferredConfigPath } = {}) {
  const fileState = readDesktopConfigFile({ preferredConfigPath });
  const fileConfig = fileState.config || {};
  const fileProxy = fileConfig.proxy || {};

  return {
    configFileDetected: Boolean(Object.keys(fileConfig).length),
    configFilePath: fileState.path,
    configWritePath: preferredConfigPath ? path.resolve(preferredConfigPath) : "",
    browserPath:
      process.env.DESKTOP_BROWSER_PATH ||
      fileConfig.browserPath ||
      "",
    defaultTargetUrl:
      process.env.DESKTOP_DEFAULT_URL ||
      fileConfig.defaultTargetUrl ||
      BUILTIN_DEFAULT_TARGET_URL,
    proxy: {
      protocol:
        process.env.DESKTOP_PROXY_PROTOCOL ||
        process.env.DEFAULT_PROXY_PROTOCOL ||
        fileProxy.protocol ||
        BUILTIN_PROXY_PROTOCOL,
      host:
        process.env.DESKTOP_PROXY_HOST ||
        process.env.DEFAULT_PROXY_HOST ||
        fileProxy.host ||
        BUILTIN_PROXY_HOST,
      port:
        process.env.DESKTOP_PROXY_PORT ||
        process.env.DEFAULT_PROXY_PORT ||
        fileProxy.port ||
        BUILTIN_PROXY_PORT,
      username:
        process.env.DESKTOP_PROXY_USERNAME ||
        process.env.DEFAULT_PROXY_USERNAME ||
        fileProxy.username ||
        BUILTIN_PROXY_USERNAME,
      password:
        process.env.DESKTOP_PROXY_PASSWORD ||
        process.env.DEFAULT_PROXY_PASSWORD ||
        fileProxy.password ||
        "",
      bypass:
        process.env.DESKTOP_PROXY_BYPASS ||
        process.env.DEFAULT_PROXY_BYPASS ||
        fileProxy.bypass ||
        BUILTIN_PROXY_BYPASS,
    },
  };
}

async function pathExists(candidatePath) {
  try {
    await fs.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

export async function discoverBrowsers({ configuredBrowserPath } = {}) {
  const found = [];
  const platformCandidates =
    process.platform === "darwin"
      ? MAC_BROWSER_CANDIDATES
      : WINDOWS_BROWSER_CANDIDATES;

  if (configuredBrowserPath && (await pathExists(configuredBrowserPath))) {
    found.push({
      id: "custom",
      name: "Configured Browser",
      path: configuredBrowserPath,
    });
  }

  for (const candidate of platformCandidates) {
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

function proxyReady(config) {
  return Boolean(
    config.host &&
      config.port &&
      config.username &&
      isConfiguredSecret(config.password)
  );
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
    passwordSet: isConfiguredSecret(config.password),
    bypass: config.bypass,
  };
}

function buildUpstreamProxyUrl(config) {
  if (!proxyReady(config)) {
    throw new Error(
      "Desktop proxy settings are incomplete. Save a valid password before launching."
    );
  }

  const username = encodeURIComponent(config.username || "");
  const password = encodeURIComponent(config.password || "");
  return `${config.protocol}://${username}:${password}@${config.host}:${config.port}`;
}

function sessionRoot() {
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "ProxyBrowserDesktop",
      "sessions"
    );
  }

  return path.join(
    os.homedir(),
    "AppData",
    "Local",
    "ProxyBrowserDesktop",
    "sessions"
  );
}

function createSessionId() {
  return `session-${Date.now().toString(36)}-${Math.random()
    .toString(16)
    .slice(2, 10)}`;
}

async function resolveBrowser(browserId, { configuredBrowserPath } = {}) {
  const browsers = await discoverBrowsers({ configuredBrowserPath });

  if (!browsers.length) {
    throw new Error(
      "No supported desktop browser was found. Install Chrome or Edge first."
    );
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
  if (process.platform === "darwin") {
    await new Promise((resolve) => {
      const killer = spawn(
        "sh",
        [
          "-lc",
          `pkill -TERM -P ${pid} >/dev/null 2>&1; kill -TERM ${pid} >/dev/null 2>&1 || true`,
        ],
        {
          stdio: "ignore",
        }
      );

      killer.once("exit", () => resolve());
      killer.once("error", () => resolve());
    });
    return;
  }

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
    await fs.rm(session.profileDir, { recursive: true, force: true }).catch(
      () => {}
    );
  }
}

function buildSavedConfig(existingConfig = {}, settings = {}) {
  const existingProxy = existingConfig.proxy || {};
  const nextProxy = settings.proxy || settings;

  let defaultTargetUrl = BUILTIN_DEFAULT_TARGET_URL;

  try {
    defaultTargetUrl = normalizeTargetUrl(
      settings.defaultTargetUrl ?? existingConfig.defaultTargetUrl
    );
  } catch {
    defaultTargetUrl = BUILTIN_DEFAULT_TARGET_URL;
  }

  return {
    defaultTargetUrl,
    browserPath: normalizeText(
      settings.browserPath ?? existingConfig.browserPath ?? ""
    ),
    proxy: {
      protocol: normalizeProtocol(
        nextProxy.protocol ?? existingProxy.protocol ?? BUILTIN_PROXY_PROTOCOL
      ),
      host: normalizeText(
        nextProxy.host ?? existingProxy.host ?? BUILTIN_PROXY_HOST
      ),
      port: normalizeText(
        nextProxy.port ?? existingProxy.port ?? BUILTIN_PROXY_PORT
      ),
      username: normalizeText(
        nextProxy.username ?? existingProxy.username ?? BUILTIN_PROXY_USERNAME
      ),
      password: normalizeText(
        nextProxy.password ?? existingProxy.password ?? ""
      ),
      bypass: normalizeText(
        nextProxy.bypass ?? existingProxy.bypass ?? BUILTIN_PROXY_BYPASS
      ),
    },
  };
}

export async function saveDesktopSettings({ configPath, settings } = {}) {
  if (!configPath) {
    throw new Error("Desktop settings path is unavailable.");
  }

  const resolvedConfigPath = path.resolve(configPath);
  const existingState = readDesktopConfigFile({
    preferredConfigPath: resolvedConfigPath,
  });
  const nextConfig = buildSavedConfig(existingState.config, settings);

  await fs.mkdir(path.dirname(resolvedConfigPath), { recursive: true });
  await fs.writeFile(
    resolvedConfigPath,
    `${JSON.stringify(nextConfig, null, 2)}\n`,
    "utf8"
  );

  return desktopMeta({ configPath: resolvedConfigPath });
}

export async function launchBrowserSession({
  browserId,
  targetUrl,
  configPath,
} = {}) {
  const runtimeConfig = resolveRuntimeConfig({ preferredConfigPath: configPath });
  const browser = await resolveBrowser(browserId, {
    configuredBrowserPath: runtimeConfig.browserPath,
  });
  const normalizedUrl = normalizeTargetUrl(
    targetUrl || runtimeConfig.defaultTargetUrl
  );
  const upstreamProxyUrl = buildUpstreamProxyUrl(runtimeConfig.proxy);
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
      bypass: runtimeConfig.proxy.bypass,
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

export async function desktopMeta({ configPath } = {}) {
  const runtimeConfig = resolveRuntimeConfig({ preferredConfigPath: configPath });
  const browsers = await discoverBrowsers({
    configuredBrowserPath: runtimeConfig.browserPath,
  });

  return {
    defaultTargetUrl: runtimeConfig.defaultTargetUrl,
    browsers,
    proxyReady: proxyReady(runtimeConfig.proxy),
    proxy: redactProxy(runtimeConfig.proxy),
    configFileDetected: runtimeConfig.configFileDetected,
    configFilePath: runtimeConfig.configFilePath,
    configWritePath: runtimeConfig.configWritePath,
    settings: {
      defaultTargetUrl: runtimeConfig.defaultTargetUrl,
      browserPath: runtimeConfig.browserPath,
      proxy: {
        protocol: runtimeConfig.proxy.protocol,
        host: runtimeConfig.proxy.host,
        port: runtimeConfig.proxy.port,
        username: runtimeConfig.proxy.username,
        password: runtimeConfig.proxy.password,
        bypass: runtimeConfig.proxy.bypass,
      },
    },
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
