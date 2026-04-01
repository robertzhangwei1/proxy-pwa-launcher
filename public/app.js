const INSTALL_TOKEN_KEY = "proxy-pwa-launcher:install-token:v3";
const SESSION_HEADER_NAME = "X-Launcher-Token";
const APP_CONFIG = window.PROXY_LAUNCHER_CONFIG || {};

const PLATFORM_CONFIG = {
  android: {
    installFallback:
      "Open this page in Chrome or Edge on Android, then choose Install app or Add to Home screen.",
  },
  ios: {
    installFallback:
      "Open this page in Safari, tap Share, then choose Add to Home Screen.",
  },
};

const platform = document.body.dataset.platform || "android";

const installButton = document.querySelector("#installButton");
const refreshButton = document.querySelector("#refreshButton");
const launchButton = document.querySelector("#launchButton");
const goButton = document.querySelector("#goButton");
const backButton = document.querySelector("#backButton");
const forwardButton = document.querySelector("#forwardButton");
const reloadButton = document.querySelector("#reloadButton");
const stopButton = document.querySelector("#stopButton");
const addressForm = document.querySelector("#addressForm");
const urlInput = document.querySelector("#urlInput");
const statePill = document.querySelector("#statePill");
const titleValue = document.querySelector("#titleValue");
const modeValue = document.querySelector("#modeValue");
const urlValue = document.querySelector("#urlValue");
const focusedValue = document.querySelector("#focusedValue");
const mobileNote = document.querySelector("#mobileNote");
const launchHint = document.querySelector("#launchHint");
const browserSurface = document.querySelector("#browserSurface");
const previewOverlay = document.querySelector("#previewOverlay");
const screenshotImage = document.querySelector("#screenshotImage");
const previewPlaceholder = document.querySelector("#previewPlaceholder");
const textInput = document.querySelector("#textInput");
const sendTextButton = document.querySelector("#sendTextButton");
const logList = document.querySelector("#logList");
const keyButtons = Array.from(document.querySelectorAll("[data-key]"));

const appState = {
  actionInFlight: false,
  gestureStart: null,
  installPrompt: null,
  installToken: getInstallToken(),
  latestMeta: null,
  latestSession: null,
  pollTimer: null,
  resizeTimer: null,
  screenshotUrl: null,
};

if (platform === "ios") {
  installButton.hidden = false;
  installButton.textContent = "Install Help";
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function addLog(message, tone = "info") {
  if (!logList) {
    return;
  }

  const item = document.createElement("li");
  item.className = `log-item log-${tone}`;

  const stamp = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  item.textContent = `${stamp}  ${message}`;
  logList.prepend(item);

  while (logList.children.length > 10) {
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

function buildBackendUrl(relativePath) {
  const baseUrl = getBackendBaseUrl();
  const normalizedPath = String(relativePath || "").replace(/^\/+/, "");
  return new URL(normalizedPath, `${baseUrl}/`).toString();
}

async function apiRequest(relativePath, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    [SESSION_HEADER_NAME]: appState.installToken,
    ...(options.headers || {}),
  };

  const response = await fetch(buildBackendUrl(relativePath), {
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

function prettyRouteLabel(session) {
  if (session?.proxyMode === "manual") {
    return "Built-in UK proxy route";
  }

  if (session?.proxyMode === "service") {
    return "Provider API route";
  }

  return "Direct route";
}

function getFocusedLabel(session) {
  const tag = session?.pageMetrics?.focusedTag;
  const type = session?.pageMetrics?.focusedType;

  if (!tag) {
    return "None";
  }

  if (type) {
    return `${tag} (${type})`;
  }

  return tag;
}

function setButtonState(active, session) {
  const busy = appState.actionInFlight;
  const live = Boolean(active);

  launchButton.disabled = busy;
  goButton.disabled = busy;
  backButton.disabled = busy || !live || !session?.canGoBack;
  forwardButton.disabled = busy || !live || !session?.canGoForward;
  reloadButton.disabled = busy || !live;
  stopButton.disabled = busy || !live;
  sendTextButton.disabled = busy || !live || !textInput.value.trim();

  for (const button of keyButtons) {
    button.disabled = busy || !live;
  }
}

function clearPreview() {
  if (appState.screenshotUrl) {
    URL.revokeObjectURL(appState.screenshotUrl);
    appState.screenshotUrl = null;
  }

  screenshotImage.hidden = true;
  previewPlaceholder.hidden = false;
}

function renderMeta(meta) {
  appState.latestMeta = meta;

  mobileNote.textContent = [
    meta.mobileNote,
    meta.sessionIsolationNote,
  ]
    .filter(Boolean)
    .join(" ");

  if (!appState.latestSession?.active && !urlInput.matches(":focus")) {
    urlInput.value = meta.defaultTargetUrl || "https://www.google.com";
  }

  if (!appState.latestSession?.active) {
    launchHint.textContent =
      "Launch the remote browser, then tap the page to focus fields, swipe vertically to scroll, and use the text tray below to type.";
  }
}

function renderSession(session) {
  appState.latestSession = session;

  const live = Boolean(session?.active);
  statePill.textContent = live ? "Live" : "Ready";
  statePill.className = `status-pill${live ? " live" : ""}`;

  titleValue.textContent = live
    ? session.title || "Remote browser live"
    : "Remote browser ready";
  modeValue.textContent = prettyRouteLabel(session);
  urlValue.textContent =
    session.currentUrl ||
    session.targetUrl ||
    appState.latestMeta?.defaultTargetUrl ||
    "-";
  focusedValue.textContent = getFocusedLabel(session);

  if (!urlInput.matches(":focus")) {
    urlInput.value =
      session.currentUrl ||
      session.targetUrl ||
      appState.latestMeta?.defaultTargetUrl ||
      "https://www.google.com";
  }

  if (live) {
    launchHint.textContent =
      "Tap anywhere in the live page to click. Swipe up or down on the page to scroll remotely.";
  } else {
    launchHint.textContent =
      "Launch the remote browser, then tap the page to focus fields, swipe vertically to scroll, and use the text tray below to type.";
    clearPreview();
  }

  setButtonState(live, session);
}

function syncPolling(active) {
  if (appState.pollTimer) {
    clearInterval(appState.pollTimer);
    appState.pollTimer = null;
  }

  if (active) {
    appState.pollTimer = setInterval(() => {
      if (!appState.actionInFlight) {
        refreshStatus({ quiet: true }).catch(() => {});
      }
    }, 2200);
  }
}

async function refreshScreenshot() {
  if (!appState.latestSession?.active) {
    clearPreview();
    return;
  }

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
      clearPreview();
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
    clearPreview();
  }
}

async function refreshMeta({ quiet = false } = {}) {
  const meta = await apiRequest("api/meta");
  renderMeta(meta);

  if (!quiet) {
    addLog("Connected to the hosted proxy browser.", "success");
  }

  return meta;
}

async function refreshStatus({ quiet = false } = {}) {
  const session = await apiRequest("api/session");
  renderSession(session);
  syncPolling(session.active);

  if (session.active) {
    await refreshScreenshot();
  }

  if (!quiet) {
    addLog(
      session.active
        ? `Remote browser live at ${session.currentUrl || session.targetUrl}.`
        : "Remote browser is ready to launch."
    );
  }

  return session;
}

function getTargetUrl() {
  return (
    String(urlInput.value || "").trim() ||
    appState.latestSession?.currentUrl ||
    appState.latestMeta?.defaultTargetUrl ||
    "https://www.google.com"
  );
}

function getDesiredViewport() {
  const candidateWidth = Math.min(
    browserSurface?.clientWidth || window.innerWidth - 24,
    window.innerWidth - 24
  );
  const width = clamp(Math.round(candidateWidth), 360, 520);
  const height = clamp(Math.round(width * 2.1), 700, 1100);

  return { width, height };
}

async function runAction(relativePath, body = {}, { quiet = false } = {}) {
  if (appState.actionInFlight) {
    return null;
  }

  appState.actionInFlight = true;
  setButtonState(appState.latestSession?.active, appState.latestSession);

  try {
    const result = await apiRequest(relativePath, {
      method: "POST",
      body: JSON.stringify(body),
    });

    renderSession(result.session);

    if (result.session?.active) {
      await refreshScreenshot();
    }

    if (!quiet && result.message) {
      addLog(result.message, "success");
    }

    return result;
  } catch (error) {
    addLog(error.message, "error");
    throw error;
  } finally {
    appState.actionInFlight = false;
    setButtonState(appState.latestSession?.active, appState.latestSession);
  }
}

async function launchBrowser() {
  await runAction(
    "api/session/start",
    {
      targetUrl: getTargetUrl(),
      viewport: getDesiredViewport(),
    },
    { quiet: false }
  );
  syncPolling(true);
}

async function navigateBrowser() {
  if (!appState.latestSession?.active) {
    await launchBrowser();
    return;
  }

  await runAction(
    "api/session/navigate",
    {
      targetUrl: getTargetUrl(),
    },
    { quiet: false }
  );
}

async function syncViewport() {
  if (!appState.latestSession?.active || appState.actionInFlight) {
    return;
  }

  const currentViewport = appState.latestSession.viewport || {};
  const nextViewport = getDesiredViewport();
  const changed =
    Math.abs((currentViewport.width || 0) - nextViewport.width) >= 24 ||
    Math.abs((currentViewport.height || 0) - nextViewport.height) >= 40;

  if (!changed) {
    return;
  }

  await runAction(
    "api/session/resize",
    {
      viewport: nextViewport,
    },
    { quiet: true }
  );
  addLog(
    `Viewport synced to ${nextViewport.width} x ${nextViewport.height}.`,
    "info"
  );
}

function eventPoint(event) {
  if ("clientX" in event && "clientY" in event) {
    return { x: event.clientX, y: event.clientY };
  }

  const touch = event.changedTouches?.[0] || event.touches?.[0];

  if (!touch) {
    return null;
  }

  return { x: touch.clientX, y: touch.clientY };
}

async function handleGestureEnd(point) {
  if (!point || !appState.gestureStart || !appState.latestSession?.active) {
    appState.gestureStart = null;
    return;
  }

  const rect = previewOverlay.getBoundingClientRect();
  const startPoint = appState.gestureStart;
  const dx = point.x - startPoint.x;
  const dy = point.y - startPoint.y;
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  appState.gestureStart = null;

  if (!rect.width || !rect.height) {
    return;
  }

  if (absDy > 18 && absDy > absDx * 1.15) {
    const remoteHeight = appState.latestSession.viewport?.height || rect.height;
    let deltaY = Math.round((-dy * remoteHeight * 1.8) / rect.height);
    deltaY = clamp(deltaY, -1800, 1800);

    if (Math.abs(deltaY) < 80) {
      deltaY = deltaY >= 0 ? 120 : -120;
    }

    await runAction(
      "api/session/scroll",
      {
        deltaX: 0,
        deltaY,
      },
      { quiet: true }
    );
    addLog("Scrolled the remote page.", "info");
    return;
  }

  const xRatio = clamp((point.x - rect.left) / rect.width, 0.01, 0.99);
  const yRatio = clamp((point.y - rect.top) / rect.height, 0.01, 0.99);

  await runAction(
    "api/session/tap",
    {
      xRatio,
      yRatio,
    },
    { quiet: true }
  );
  addLog("Sent tap to the remote page.", "info");
}

function rememberGestureStart(event) {
  if (!appState.latestSession?.active || appState.actionInFlight) {
    return;
  }

  const point = eventPoint(event);

  if (!point) {
    return;
  }

  appState.gestureStart = point;
  if (typeof event.pointerId === "number") {
    try {
      previewOverlay.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is optional on some mobile browsers.
    }
  }
  event.preventDefault();
}

async function finishGesture(event) {
  if (!appState.latestSession?.active || appState.actionInFlight) {
    return;
  }

  const point = eventPoint(event);
  event.preventDefault();
  await handleGestureEnd(point);
}

launchButton.addEventListener("click", async () => {
  try {
    await launchBrowser();
  } catch {
    // Error already logged in runAction.
  }
});

addressForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    await navigateBrowser();
  } catch {
    // Error already logged in runAction.
  }
});

backButton.addEventListener("click", async () => {
  try {
    await runAction("api/session/back");
  } catch {
    // Error already logged in runAction.
  }
});

forwardButton.addEventListener("click", async () => {
  try {
    await runAction("api/session/forward");
  } catch {
    // Error already logged in runAction.
  }
});

reloadButton.addEventListener("click", async () => {
  try {
    await runAction("api/session/reload");
  } catch {
    // Error already logged in runAction.
  }
});

stopButton.addEventListener("click", async () => {
  try {
    await runAction("api/session/stop");
    syncPolling(false);
  } catch {
    // Error already logged in runAction.
  }
});

refreshButton.addEventListener("click", async () => {
  if (appState.actionInFlight) {
    return;
  }

  try {
    await Promise.all([refreshMeta(), refreshStatus()]);
  } catch (error) {
    addLog(error.message, "error");
  }
});

textInput.addEventListener("input", () => {
  setButtonState(appState.latestSession?.active, appState.latestSession);
});

sendTextButton.addEventListener("click", async () => {
  const text = textInput.value;

  if (!text.trim()) {
    return;
  }

  try {
    await runAction(
      "api/session/type",
      {
        text,
      },
      { quiet: true }
    );
    addLog(`Typed ${text.length} characters into the remote page.`, "success");
    textInput.value = "";
    setButtonState(appState.latestSession?.active, appState.latestSession);
  } catch {
    // Error already logged in runAction.
  }
});

for (const button of keyButtons) {
  button.addEventListener("click", async () => {
    try {
      await runAction(
        "api/session/key",
        {
          key: button.dataset.key,
        },
        { quiet: true }
      );
      addLog(`Pressed ${button.dataset.key} on the remote page.`, "info");
    } catch {
      // Error already logged in runAction.
    }
  });
}

previewOverlay.addEventListener("pointerdown", rememberGestureStart);
previewOverlay.addEventListener("pointerup", (event) => {
  finishGesture(event).catch(() => {});
  if (typeof event.pointerId === "number") {
    try {
      previewOverlay.releasePointerCapture(event.pointerId);
    } catch {
      // Ignore browsers that do not keep pointer capture state.
    }
  }
});
previewOverlay.addEventListener("pointercancel", () => {
  appState.gestureStart = null;
});
previewOverlay.addEventListener(
  "wheel",
  (event) => {
    if (!appState.latestSession?.active || appState.actionInFlight) {
      return;
    }

    event.preventDefault();
    const rect = previewOverlay.getBoundingClientRect();
    const remoteHeight = appState.latestSession.viewport?.height || rect.height;
    const deltaY = clamp(
      Math.round((event.deltaY * remoteHeight) / Math.max(rect.height, 1)),
      -1600,
      1600
    );

    runAction(
      "api/session/scroll",
      {
        deltaX: 0,
        deltaY,
      },
      { quiet: true }
    )
      .then(() => addLog("Scrolled the remote page.", "info"))
      .catch(() => {});
  },
  { passive: false }
);

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
      "info"
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
  addLog("Installed successfully.", "success");
  installButton.hidden = true;
});

window.addEventListener("resize", () => {
  clearTimeout(appState.resizeTimer);
  appState.resizeTimer = setTimeout(() => {
    syncViewport().catch(() => {});
  }, 450);
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("./sw.js")
    .then(() => addLog("Offline shell ready.", "success"))
    .catch((error) =>
      addLog(`Service worker registration failed: ${error.message}`, "error")
    );
}

addLog("This install controls a private hosted browser session.");

Promise.all([refreshMeta({ quiet: true }), refreshStatus({ quiet: true })]).catch(
  (error) => addLog(error.message, "error")
);
