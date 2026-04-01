const SETTINGS_KEY = "proxy-pwa-launcher:settings:v5";
const INSTALL_TOKEN_KEY = "proxy-pwa-launcher:install-token:v1";
const SESSION_HEADER_NAME = "X-Launcher-Token";
const SECRET_FIELD_NAMES = new Set(["proxyPassword", "proxyServiceApiKey"]);
const APP_CONFIG = window.PROXY_LAUNCHER_CONFIG || {};
const IPROYAL_PRESET = {
  proxyMode: "manual",
  proxyProtocol: "http",
  proxyHost: "geo.iproyal.com",
  proxyPort: "12321",
  proxyUsername: "5YzAQaZQMzdWkYTM",
  proxyBypass: "localhost;127.0.0.1;<local>",
  proxyServiceCountry: "gb",
  proxyServiceRegion: "kent",
};

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
const stopButton = document.querySelector("#stopButton");
const screenshotButton = document.querySelector("#screenshotButton");
const resolveProxyButton = document.querySelector("#resolveProxyButton");
const applyPresetButton = document.querySelector("#applyPresetButton");
const copyHostButton = document.querySelector("#copyHostButton");
const copyPortButton = document.querySelector("#copyPortButton");
const copyUsernameButton = document.querySelector("#copyUsernameButton");
const pastePasswordButton = document.querySelector("#pastePasswordButton");
const copyProxyUrlButton = document.querySelector("#copyProxyUrlButton");
const connectBackendButton = document.querySelector("#connectBackendButton");
const backendBaseUrlInput = document.querySelector("#backendBaseUrl");
const launchForm = document.querySelector("#launchForm");
const navigateForm = document.querySelector("#navigateForm");
const screenshotImage = document.querySelector("#screenshotImage");
const previewPlaceholder = document.querySelector("#previewPlaceholder");
const logList = document.querySelector("#logList");
const accessUrlList = document.querySelector("#accessUrlList");
const mobileNote = document.querySelector("#mobileNote");
const manualProxyFields = document.querySelector("#manualProxyFields");
const serviceProxyFields = document.querySelector("#serviceProxyFields");

const stateValue = document.querySelector("#stateValue");
const modeValue = document.querySelector("#modeValue");
const urlValue = document.querySelector("#urlValue");
const proxyValue = document.querySelector("#proxyValue");
const providerValue = document.querySelector("#providerValue");
const launchedValue = document.querySelector("#launchedValue");
const proxyPasswordInput = launchForm.querySelector('[name="proxyPassword"]');

const appState = {
  installPrompt: null,
  pollTimer: null,
  screenshotUrl: null,
  installToken: getInstallToken(),
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

function isGitHubPagesHost() {
  return location.hostname.endsWith("github.io");
}

function configuredBackendBaseUrl() {
  return String(APP_CONFIG.defaultBackendBaseUrl || "").trim().replace(
    /\/$/,
    ""
  );
}

function defaultBackendBaseUrl() {
  const configuredBaseUrl = configuredBackendBaseUrl();

  if (configuredBaseUrl) {
    return configuredBaseUrl;
  }

  return isGitHubPagesHost() ? "" : location.origin;
}

function normalizeBackendBaseUrl(rawValue, { allowBlank = false } = {}) {
  const trimmed = String(rawValue || "").trim();

  if (!trimmed) {
    if (allowBlank) {
      return "";
    }

    const fallback = defaultBackendBaseUrl();
    if (!fallback) {
      throw new Error("Set Backend helper URL first.");
    }

    return fallback;
  }

  const withProtocol = /^[a-z]+:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let url;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new Error("Backend helper URL must be a valid URL.");
  }

  return url.toString().replace(/\/$/, "");
}

function getBackendBaseUrl({ allowBlank = false } = {}) {
  return normalizeBackendBaseUrl(backendBaseUrlInput?.value, { allowBlank });
}

function hasConfiguredBackend() {
  return Boolean(getBackendBaseUrl({ allowBlank: true }));
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

function selectedProxyMode() {
  const selected = launchForm.querySelector('input[name="proxyMode"]:checked');
  return selected ? selected.value : "manual";
}

function setSectionEnabled(section, enabled) {
  section.hidden = !enabled;
  for (const field of section.querySelectorAll("input, select, textarea")) {
    field.disabled = !enabled;
  }
}

function syncModeSections() {
  const mode = selectedProxyMode();
  setSectionEnabled(manualProxyFields, mode === "manual");
  setSectionEnabled(serviceProxyFields, mode === "service");
}

function setFormField(name, value) {
  const fields = launchForm.querySelectorAll(`[name="${name}"]`);
  for (const field of fields) {
    if (field.type === "radio") {
      field.checked = field.value === value;
    } else if (field.type === "checkbox") {
      field.checked = Boolean(value);
    } else {
      field.value = value ?? "";
    }
  }
}

function readFormValue(name) {
  const field = launchForm.querySelector(`[name="${name}"]`);
  return field ? String(field.value || "").trim() : "";
}

async function copyText(text, successMessage) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const tempInput = document.createElement("textarea");
      tempInput.value = text;
      tempInput.setAttribute("readonly", "");
      tempInput.style.position = "absolute";
      tempInput.style.left = "-9999px";
      document.body.append(tempInput);
      tempInput.select();
      document.execCommand("copy");
      tempInput.remove();
    }
    addLog(successMessage, "success");
  } catch (error) {
    addLog(`Copy failed: ${error.message}`, "error");
  }
}

async function pastePasswordFromClipboard() {
  if (!navigator.clipboard?.readText) {
    addLog(
      "Clipboard paste is not available here. Tap the password field and paste manually.",
      "error"
    );
    return;
  }

  try {
    const password = await navigator.clipboard.readText();
    if (!password.trim()) {
      addLog("Clipboard is empty.", "error");
      return;
    }

    proxyPasswordInput.value = password.trim();
    addLog("Password pasted from clipboard.", "success");
  } catch (error) {
    addLog(
      `Clipboard paste failed: ${error.message}. Paste the password manually if needed.`,
      "error"
    );
  }
}

function currentProxyUrlTemplate() {
  const protocol = readFormValue("proxyProtocol") || IPROYAL_PRESET.proxyProtocol;
  const host = readFormValue("proxyHost") || IPROYAL_PRESET.proxyHost;
  const port = readFormValue("proxyPort") || IPROYAL_PRESET.proxyPort;
  const username =
    readFormValue("proxyUsername") || IPROYAL_PRESET.proxyUsername;
  const password = readFormValue("proxyPassword");
  const passwordToken = password
    ? encodeURIComponent(password)
    : "<YOUR_PASSWORD>";

  return `${protocol}://${encodeURIComponent(username)}:${passwordToken}@${host}:${port}`;
}

function applyIproyalPreset({ keepPassword = true } = {}) {
  setFormField("proxyMode", IPROYAL_PRESET.proxyMode);
  setFormField("proxyProtocol", IPROYAL_PRESET.proxyProtocol);
  setFormField("proxyHost", IPROYAL_PRESET.proxyHost);
  setFormField("proxyPort", IPROYAL_PRESET.proxyPort);
  setFormField("proxyUsername", IPROYAL_PRESET.proxyUsername);
  setFormField("proxyBypass", IPROYAL_PRESET.proxyBypass);
  setFormField("proxyServiceCountry", IPROYAL_PRESET.proxyServiceCountry);
  setFormField("proxyServiceRegion", IPROYAL_PRESET.proxyServiceRegion);

  if (!keepPassword) {
    setFormField("proxyPassword", "");
  }

  syncModeSections();
}

function formSnapshot() {
  const snapshot = {};

  for (const element of launchForm.elements) {
    if (!element.name) {
      continue;
    }

    if (element.type === "checkbox") {
      snapshot[element.name] = element.checked;
      continue;
    }

    if (element.type === "radio") {
      if (element.checked) {
        snapshot[element.name] = element.value;
      }
      continue;
    }

    snapshot[element.name] = element.value;
  }

  snapshot.backendBaseUrl = getBackendBaseUrl({ allowBlank: true });
  return snapshot;
}

function persistSettings() {
  const snapshot = formSnapshot();

  for (const name of SECRET_FIELD_NAMES) {
    delete snapshot[name];
  }

  localStorage.setItem(SETTINGS_KEY, JSON.stringify(snapshot));
}

function restoreSettings() {
  let saved;

  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
  } catch {
    saved = null;
  }

  if (!saved || typeof saved !== "object") {
    if (backendBaseUrlInput) {
      backendBaseUrlInput.value = defaultBackendBaseUrl();
    }
    applyIproyalPreset({ keepPassword: false });
    setFormField("headless", true);
    persistSettings();
    return;
  }

  if (backendBaseUrlInput) {
    backendBaseUrlInput.value = saved.backendBaseUrl ?? defaultBackendBaseUrl();
  }

  for (const [name, value] of Object.entries(saved)) {
    if (name === "backendBaseUrl") {
      continue;
    }
    setFormField(name, value);
  }

  syncModeSections();
}

function normalizeLaunchPayload() {
  const formData = new FormData(launchForm);
  const proxyMode = selectedProxyMode();

  const payload = {
    targetUrl: String(formData.get("targetUrl") || "").trim(),
    headless: formData.get("headless") === "on",
    proxyMode,
  };

  if (proxyMode === "manual") {
    payload.proxy = {
      protocol: String(formData.get("proxyProtocol") || "http").trim(),
      host: String(formData.get("proxyHost") || "").trim(),
      port: String(formData.get("proxyPort") || "").trim(),
      username: String(formData.get("proxyUsername") || "").trim(),
      password: String(formData.get("proxyPassword") || "").trim(),
      bypass: String(formData.get("proxyBypass") || "").trim(),
    };
  }

  if (proxyMode === "service") {
    payload.proxyService = {
      endpoint: String(formData.get("proxyServiceEndpoint") || "").trim(),
      method: String(formData.get("proxyServiceMethod") || "POST").trim(),
      apiKey: String(formData.get("proxyServiceApiKey") || "").trim(),
      authHeaderName: String(
        formData.get("proxyServiceAuthHeaderName") || "Authorization"
      ).trim(),
      authScheme: String(
        formData.get("proxyServiceAuthScheme") || "Bearer"
      ).trim(),
      responsePath: String(
        formData.get("proxyServiceResponsePath") || ""
      ).trim(),
      country: String(formData.get("proxyServiceCountry") || "").trim(),
      region: String(formData.get("proxyServiceRegion") || "").trim(),
      sessionId: String(formData.get("proxyServiceSessionId") || "").trim(),
      extraHeaders: String(
        formData.get("proxyServiceExtraHeaders") || ""
      ).trim(),
      extraPayload: String(
        formData.get("proxyServiceExtraPayload") || ""
      ).trim(),
    };
  }

  return payload;
}

function prettyMode(value) {
  if (value === "manual") {
    return "IPRoyal manual";
  }

  if (value === "service") {
    return "Custom provider API";
  }

  return "Direct";
}

function deriveProviderLabel(session) {
  if (session.proxyService) {
    return new URL(session.proxyService.endpoint).host;
  }

  if (session.proxy?.host === IPROYAL_PRESET.proxyHost) {
    return "IPRoyal screenshot preset";
  }

  if (session.proxyMode === "manual") {
    return "Manual entry";
  }

  return "None";
}

function renderStatus(session) {
  stateValue.textContent = session.active ? "Live browser" : "No live browser";
  modeValue.textContent = prettyMode(session.proxyMode || "direct");
  urlValue.textContent = session.currentUrl || session.targetUrl || "-";
  proxyValue.textContent = session.proxy
    ? `${session.proxy.protocol}://${session.proxy.host}:${session.proxy.port}`
    : "Direct connection";
  providerValue.textContent = deriveProviderLabel(session);
  launchedValue.textContent = session.launchedAt
    ? new Date(session.launchedAt).toLocaleString()
    : "-";

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
  if (mobileNote) {
    const notes = [meta.mobileNote, meta.sessionIsolationNote].filter(Boolean);
    mobileNote.textContent = notes.join(" ");
  }

  accessUrlList.replaceChildren();
  const pageName = location.pathname.split("/").pop() || "android.html";

  for (const url of meta.accessUrls || []) {
    const helperInstallUrl = new URL(pageName, `${url}/`).toString();
    const link = document.createElement("a");
    link.className = "chip";
    link.href = helperInstallUrl;
    link.textContent = helperInstallUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    accessUrlList.append(link);
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
        // Keep polling quiet during temporary failures.
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
  if (!hasConfiguredBackend()) {
    if (!quiet) {
      addLog("Set Backend helper URL first.", "error");
    }
    return null;
  }

  const meta = await apiRequest("api/meta");
  renderMeta(meta);

  if (!quiet) {
    addLog(
      `Connected to shared backend for ${platform}. This install stays isolated from other users.`,
      "success"
    );
  }

  return meta;
}

async function refreshStatus({ quiet = false } = {}) {
  if (!hasConfiguredBackend()) {
    if (!quiet) {
      addLog("Set Backend helper URL first.", "error");
    }
    return null;
  }

  const session = await apiRequest("api/session");
  renderStatus(session);
  syncPolling(session.active);

  if (session.active) {
    await refreshScreenshot();
  }

  if (!quiet) {
    addLog(
      session.active
        ? `Session active at ${session.currentUrl || session.targetUrl}.`
        : "No live session detected."
    );
  }

  return session;
}

backendBaseUrlInput.addEventListener("input", () => {
  persistSettings();
});

backendBaseUrlInput.addEventListener("change", () => {
  persistSettings();
});

launchForm.addEventListener("change", (event) => {
  if (event.target.name === "proxyMode") {
    syncModeSections();
  }
  persistSettings();
});

launchForm.addEventListener("input", () => {
  persistSettings();
});

connectBackendButton.addEventListener("click", async () => {
  try {
    backendBaseUrlInput.value = getBackendBaseUrl();
    persistSettings();
    await Promise.all([refreshMeta(), refreshStatus()]);
  } catch (error) {
    addLog(error.message, "error");
  }
});

launchForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    const payload = normalizeLaunchPayload();
    const result = await apiRequest("api/session/start", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    addLog(result.message, "success");
    renderStatus(result.session);
    syncPolling(true);
    await refreshScreenshot();
  } catch (error) {
    addLog(error.message, "error");
  }
});

resolveProxyButton.addEventListener("click", async () => {
  try {
    const payload = normalizeLaunchPayload();
    const result = await apiRequest("api/proxy/resolve", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    addLog(result.message, "success");
  } catch (error) {
    addLog(error.message, "error");
  }
});

applyPresetButton.addEventListener("click", () => {
  applyIproyalPreset({ keepPassword: false });
  persistSettings();
  addLog("IPRoyal screenshot preset reapplied.", "success");
});

copyHostButton.addEventListener("click", async () => {
  await copyText(
    readFormValue("proxyHost") || IPROYAL_PRESET.proxyHost,
    "Proxy host copied."
  );
});

copyPortButton.addEventListener("click", async () => {
  await copyText(
    readFormValue("proxyPort") || IPROYAL_PRESET.proxyPort,
    "Proxy port copied."
  );
});

copyUsernameButton.addEventListener("click", async () => {
  await copyText(
    readFormValue("proxyUsername") || IPROYAL_PRESET.proxyUsername,
    "Proxy username copied."
  );
});

pastePasswordButton.addEventListener("click", async () => {
  await pastePasswordFromClipboard();
});

copyProxyUrlButton.addEventListener("click", async () => {
  await copyText(currentProxyUrlTemplate(), "Proxy URL copied.");
});

navigateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const navigateUrl = String(
    new FormData(navigateForm).get("navigateUrl") || ""
  ).trim();

  if (!navigateUrl) {
    addLog("Enter a URL before navigating.", "error");
    return;
  }

  try {
    const result = await apiRequest("api/session/navigate", {
      method: "POST",
      body: JSON.stringify({ targetUrl: navigateUrl }),
    });

    addLog(result.message, "success");
    renderStatus(result.session);
    await refreshScreenshot();
  } catch (error) {
    addLog(error.message, "error");
  }
});

stopButton.addEventListener("click", async () => {
  try {
    const result = await apiRequest("api/session/stop", { method: "POST" });
    addLog(result.message, "success");
    renderStatus(result.session);
    syncPolling(false);
  } catch (error) {
    addLog(error.message, "error");
  }
});

refreshButton.addEventListener("click", async () => {
  try {
    await Promise.all([refreshMeta(), refreshStatus()]);
  } catch (error) {
    addLog(error.message, "error");
  }
});

screenshotButton.addEventListener("click", async () => {
  if (!hasConfiguredBackend()) {
    addLog("Set Backend helper URL first.", "error");
    return;
  }

  await refreshScreenshot();
  addLog("Preview refreshed.");
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

restoreSettings();
addLog("This install has its own private session key for the shared backend.");

if (hasConfiguredBackend()) {
  Promise.all([
    refreshMeta({ quiet: true }),
    refreshStatus({ quiet: true }),
  ]).catch((error) => addLog(error.message, "error"));
} else {
  addLog("Set Backend helper URL, then tap Connect Backend.", "info");
}
