const INSTALL_TOKEN_KEY = "proxy-pwa-launcher:install-token:v2";
const SESSION_HEADER_NAME = "X-Launcher-Token";
const APP_CONFIG = window.PROXY_LAUNCHER_CONFIG || {};

const PLATFORM_CONFIG = {
  android: {
    installFallback:
      "Install hint: open the page in Chrome or Edge on Android and choose Install app or Add to Home screen.",
  },
  ios: {
    installFallback:
      "Install hint: open the page in Safari, tap Share, then choose Add to Home Screen.",
  },
};

const platform = document.body.dataset.platform || "android";

const installButton = document.querySelector("#installButton");
const refreshButton = document.querySelector("#refreshButton");
const launchButton = document.querySelector("#launchButton");
const stopButton = document.querySelector("#stopButton");
const screenshotButton = document.querySelector("#screenshotButton");
const screenshotImage = document.querySelector("#screenshotImage");
const previewPlaceholder = document.querySelector("#previewPlaceholder");
const logList = document.querySelector("#logList");
const mobileNote = document.querySelector("#mobileNote");
const launchHint = document.querySelector("#launchHint");
const stateValue = document.querySelector("#stateValue");
const modeValue = document.querySelector("#modeValue");
const urlValue = document.querySelector("#urlValue");
const proxyValue = document.querySelector("#proxyValue");
const launchedValue = document.querySelector("#launchedValue");

const appState = {
  installPrompt: null,
  pollTimer: null,
  screenshotUrl: null,
  installToken: getInstallToken(),
  latestMeta: null,
};

if (platform === "ios") {
  installButton.hidden = false;
  installButton.textContent = "Install Help";
}

function addLog(message, tone = "info") {
  const item = document.createElement("li");
  item.className = `log-item log-${tone}`;

  const stamp = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  item.textContent = `${stamp}  ${message}`;
  logList.prepend(item);

  while (logList.children.length > 8) {
    logList.removeChild(logList.lastChild);
  }
}

function randomHex(byteCount) {
  const bytes = new Uint8Array(byteCount);

  if (window.crypto?.getRandomValues) {
    window.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < byteCount; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    ""
  );
}

function createInstallToken() {
  const prefix = platform || "mobile";

  if (window.crypto?.randomUUID) {
    return `${prefix}-${window.crypto.randomUUID()}-${randomHex(8)}`;
  }

  return `${prefix}-${Date.now().toString(36)}-${randomHex(16)}`;
}

function isValidInstallToken(rawValue) {
  return /^[A-Za-z0-9._:-]{24,200}$/.test(String(rawValue || "").trim());
}

function getInstallToken() {
  const existingToken = localStorage.getItem(INSTALL_TOKEN_KEY);

  if (isValidInstallToken(existingToken)) {
    return String(existingToken).trim();
  }

  const freshToken = createInstallToken();
  localStorage.setItem(INSTALL_TOKEN_KEY, freshToken);
  return freshToken;
}

function getBackendBaseUrl() {
  const configured = String(APP_CONFIG.defaultBackendBaseUrl || "").trim();

  if (configured) {
    return configured.replace(/\/$/, "");
  }

  return location.origin.replace(/\/$/, "");
}

function buildBackendUrl(path) {
  const baseUrl = getBackendBaseUrl();
  const relativePath = String(path || "").replace(/^\/+/, "");
  return new URL(relativePath, `${baseUrl}/`).toString();
}

async function apiRequest(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    [SESSION_HEADER_NAME]: appState.installToken,
    ...(options.headers || {}),
  };

  const response = await fetch(buildBackendUrl(path), {
    mode: "cors",
    ...options,
    headers,
  });

  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : null;

  if (!response.ok) {
    throw new Error(payload?.error || `Request failed with ${response.status}`);
  }

  return payload;
}

function prettyMode(value) {
  if (value === "manual") {
    return "IPRoyal preset";
  }

  if (value === "service") {
    return "Provider API";
  }

  return "Direct";
}

function renderStatus(session) {
  stateValue.textContent = session.active ? "Live browser" : "Ready";
  modeValue.textContent = prettyMode(session.proxyMode || "manual");
  urlValue.textContent =
    session.currentUrl ||
    session.targetUrl ||
    appState.latestMeta?.defaultTargetUrl ||
    "-";
  proxyValue.textContent = session.proxy
    ? `${session.proxy.host}:${session.proxy.port}`
    : "Built-in route";
  launchedValue.textContent = session.launchedAt
    ? new Date(session.launchedAt).toLocaleString()
    : "Not launched yet";

  if (!session.active) {
    if (appState.screenshotUrl) {
      URL.revokeObjectURL(appState.screenshotUrl);
      appState.screenshotUrl = null;
    }
    screenshotImage.hidden = true;
    previewPlaceholder.hidden = false;
  }
}

function renderMeta(meta) {
  appState.latestMeta = meta;

  if (mobileNote) {
    const notes = [meta.mobileNote, meta.sessionIsolationNote].filter(Boolean);
    mobileNote.textContent = notes.join(" ");
  }

  if (launchHint) {
    launchHint.textContent = `Ready to launch ${meta.defaultTargetUrl} through the built-in UK proxy preset.`;
  }
}

function syncPolling(active) {
  if (appState.pollTimer) {
    clearInterval(appState.pollTimer);
    appState.pollTimer = null;
  }

  if (active) {
    appState.pollTimer = setInterval(async () => {
      try {
        await refreshStatus({ quiet: true });
      } catch {
        // Ignore polling noise during transient network issues.
      }
    }, 5000);
  }
}

async function refreshScreenshot() {
  try {
    const response = await fetch(
      `${buildBackendUrl("api/session/screenshot")}?t=${Date.now()}`,
      {
        cache: "no-store",
        mode: "cors",
        headers: {
          [SESSION_HEADER_NAME]: appState.installToken,
        },
      }
    );

    if (!response.ok) {
      if (appState.screenshotUrl) {
        URL.revokeObjectURL(appState.screenshotUrl);
        appState.screenshotUrl = null;
      }
      screenshotImage.hidden = true;
      previewPlaceholder.hidden = false;
      return;
    }

    const blob = await response.blob();
    if (appState.screenshotUrl) {
      URL.revokeObjectURL(appState.screenshotUrl);
    }
    appState.screenshotUrl = URL.createObjectURL(blob);
    screenshotImage.src = appState.screenshotUrl;
    screenshotImage.hidden = false;
    previewPlaceholder.hidden = true;
  } catch {
    screenshotImage.hidden = true;
    previewPlaceholder.hidden = false;
  }
}

async function refreshMeta({ quiet = false } = {}) {
  const meta = await apiRequest("api/meta");
  renderMeta(meta);

  if (!quiet) {
    addLog("Connected to the hosted browser service.", "success");
  }

  return meta;
}

async function refreshStatus({ quiet = false } = {}) {
  const session = await apiRequest("api/session");
  renderStatus(session);
  syncPolling(session.active);

  if (session.active) {
    await refreshScreenshot();
  }

  if (!quiet) {
    addLog(
      session.active
        ? `Browser is live at ${session.currentUrl || session.targetUrl}.`
        : "Ready for one-tap launch."
    );
  }

  return session;
}

launchButton.addEventListener("click", async () => {
  try {
    const result = await apiRequest("api/session/start", {
      method: "POST",
      body: JSON.stringify({}),
    });

    addLog(result.message, "success");
    renderStatus(result.session);
    syncPolling(true);
    await refreshScreenshot();
  } catch (error) {
    addLog(error.message, "error");
  }
});

stopButton.addEventListener("click", async () => {
  try {
    const result = await apiRequest("api/session/stop", {
      method: "POST",
      body: JSON.stringify({}),
    });
    addLog(result.message, "success");
    renderStatus(result.session);
    syncPolling(false);
  } catch (error) {
    addLog(error.message, "error");
  }
});

screenshotButton.addEventListener("click", async () => {
  await refreshScreenshot();
  addLog("Preview refreshed.");
});

refreshButton.addEventListener("click", async () => {
  try {
    await Promise.all([refreshMeta(), refreshStatus()]);
  } catch (error) {
    addLog(error.message, "error");
  }
});

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  appState.installPrompt = event;
  installButton.hidden = false;
});

installButton.addEventListener("click", async () => {
  if (!appState.installPrompt) {
    addLog(
      PLATFORM_CONFIG[platform]?.installFallback ||
        "Install prompt is not available in this browser.",
      "error"
    );
    return;
  }

  appState.installPrompt.prompt();
  const choice = await appState.installPrompt.userChoice;
  addLog(`Install prompt result: ${choice.outcome}.`);
  appState.installPrompt = null;
  installButton.hidden = true;
});

window.addEventListener("appinstalled", () => {
  addLog("PWA installed successfully.", "success");
  installButton.hidden = true;
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("./sw.js")
    .then(() => addLog("Service worker registered.", "success"))
    .catch((error) =>
      addLog(`Service worker registration failed: ${error.message}`, "error")
    );
}

addLog("This install is ready for one-tap launch.");

Promise.all([refreshMeta({ quiet: true }), refreshStatus({ quiet: true })]).catch(
  (error) => addLog(error.message, "error")
);
