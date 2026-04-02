const browserSelect = document.querySelector("#browserSelect");
const urlInput = document.querySelector("#urlInput");
const refreshButton = document.querySelector("#refreshButton");
const stopAllButton = document.querySelector("#stopAllButton");
const launchButton = document.querySelector("#launchButton");
const proxyStatusValue = document.querySelector("#proxyStatusValue");
const browserStatusValue = document.querySelector("#browserStatusValue");
const routeValue = document.querySelector("#routeValue");
const sessionList = document.querySelector("#sessionList");
const logList = document.querySelector("#logList");
const settingsForm = document.querySelector("#settingsForm");
const protocolSelect = document.querySelector("#protocolSelect");
const hostInput = document.querySelector("#hostInput");
const portInput = document.querySelector("#portInput");
const usernameInput = document.querySelector("#usernameInput");
const passwordInput = document.querySelector("#passwordInput");
const bypassInput = document.querySelector("#bypassInput");
const defaultUrlInput = document.querySelector("#defaultUrlInput");
const saveSettingsButton = document.querySelector("#saveSettingsButton");
const settingsHint = document.querySelector("#settingsHint");

const state = {
  busy: false,
  meta: null,
};

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

function setInputValue(input, value) {
  if (document.activeElement === input) {
    return;
  }

  input.value = value ?? "";
}

function updateButtonState() {
  const hasActiveSessions = Boolean(state.meta?.activeSessions?.length);
  const canLaunch = Boolean(state.meta?.proxyReady && state.meta?.browsers?.length);

  launchButton.disabled = state.busy || !canLaunch;
  refreshButton.disabled = state.busy;
  stopAllButton.disabled = state.busy || !hasActiveSessions;
  saveSettingsButton.disabled = state.busy;
  browserSelect.disabled = state.busy || !state.meta?.browsers?.length;
  urlInput.disabled = state.busy;
}

function renderBrowsers(meta) {
  const previousSelection = browserSelect.value;

  browserSelect.innerHTML = "";

  for (const browser of meta.browsers || []) {
    const option = document.createElement("option");
    option.value = browser.id;
    option.textContent = `${browser.name}  (${browser.path})`;
    browserSelect.appendChild(option);
  }

  if ((meta.browsers || []).some((browser) => browser.id === previousSelection)) {
    browserSelect.value = previousSelection;
  }
}

function renderSessions(meta) {
  sessionList.innerHTML = "";

  if (!meta.activeSessions?.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No launched local browsers are active.";
    sessionList.appendChild(empty);
    return;
  }

  for (const session of meta.activeSessions) {
    const card = document.createElement("article");
    card.className = "session-card";

    const title = document.createElement("h3");
    title.textContent = session.browserName;
    card.appendChild(title);

    const details = document.createElement("p");
    details.className = "hint";
    details.textContent = `${session.targetUrl}  |  PID ${session.pid}`;
    card.appendChild(details);

    const started = document.createElement("p");
    started.className = "hint";
    started.textContent = `Started ${new Date(session.startedAt).toLocaleString()}`;
    card.appendChild(started);

    const actions = document.createElement("div");
    actions.className = "actions";

    const stopButton = document.createElement("button");
    stopButton.className = "ghost";
    stopButton.textContent = "Stop";
    stopButton.disabled = state.busy;
    stopButton.addEventListener("click", async () => {
      try {
        await runAction(() => window.desktopApi.stopBrowser(session.id));
        addLog(`Stopped ${session.browserName}.`, "success");
      } catch (error) {
        addLog(error.message, "error");
      }
    });

    actions.appendChild(stopButton);
    card.appendChild(actions);
    sessionList.appendChild(card);
  }
}

function renderSettings(meta) {
  const settings = meta.settings || {};
  const proxy = settings.proxy || {};

  setInputValue(protocolSelect, proxy.protocol || "http");
  setInputValue(hostInput, proxy.host || "");
  setInputValue(portInput, proxy.port || "");
  setInputValue(usernameInput, proxy.username || "");
  setInputValue(passwordInput, proxy.password || "");
  setInputValue(bypassInput, proxy.bypass || "");
  setInputValue(defaultUrlInput, settings.defaultTargetUrl || meta.defaultTargetUrl || "");
  setInputValue(urlInput, settings.defaultTargetUrl || meta.defaultTargetUrl || "");

  if (meta.configWritePath) {
    settingsHint.textContent = `Settings are stored locally on this device at ${meta.configWritePath}.`;
  } else {
    settingsHint.textContent =
      "Settings are stored locally on this device and used for future launches.";
  }
}

function renderMeta(meta) {
  state.meta = meta;

  proxyStatusValue.textContent = meta.proxyReady ? "Ready" : "Needs settings";
  browserStatusValue.textContent = meta.browsers?.length
    ? meta.browsers.map((browser) => browser.name).join(", ")
    : "No supported browser found";
  routeValue.textContent = meta.proxy
    ? `${meta.proxy.protocol}://${meta.proxy.host}:${meta.proxy.port}  (${meta.proxy.username}${meta.proxy.passwordSet ? ", password ready" : ", password missing"})`
    : "No proxy route configured";

  renderBrowsers(meta);
  renderSettings(meta);
  renderSessions(meta);
  updateButtonState();
}

async function refreshMeta({ quiet = false } = {}) {
  const meta = await window.desktopApi.getMeta();
  renderMeta(meta);

  if (!quiet) {
    addLog("Desktop launcher state refreshed.", "success");
  }
}

async function runAction(fn) {
  state.busy = true;
  updateButtonState();

  try {
    const result = await fn();
    await refreshMeta({ quiet: true });
    return result;
  } finally {
    state.busy = false;
    updateButtonState();
  }
}

function currentSettingsPayload() {
  return {
    defaultTargetUrl: defaultUrlInput.value,
    proxy: {
      protocol: protocolSelect.value,
      host: hostInput.value,
      port: portInput.value,
      username: usernameInput.value,
      password: passwordInput.value,
      bypass: bypassInput.value,
    },
  };
}

launchButton.addEventListener("click", async () => {
  try {
    const result = await runAction(() =>
      window.desktopApi.launchBrowser({
        browserId: browserSelect.value,
        targetUrl: urlInput.value,
      })
    );
    addLog(result.message, "success");
  } catch (error) {
    addLog(error.message, "error");
  }
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    await runAction(() => window.desktopApi.saveSettings(currentSettingsPayload()));
    addLog("Proxy settings saved locally.", "success");
  } catch (error) {
    addLog(error.message, "error");
  }
});

refreshButton.addEventListener("click", async () => {
  try {
    await refreshMeta();
  } catch (error) {
    addLog(error.message, "error");
  }
});

stopAllButton.addEventListener("click", async () => {
  try {
    const result = await runAction(() => window.desktopApi.stopAll());
    addLog(result.message, "success");
  } catch (error) {
    addLog(error.message, "error");
  }
});

addLog("Desktop launcher ready.");

refreshMeta({ quiet: true }).catch((error) => {
  addLog(error.message, "error");
});
