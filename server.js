import express from "express";
import fs from "fs/promises";
import os from "os";
import path from "path";
import puppeteer from "puppeteer";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 4317);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const USER_DATA_DIR = path.join(__dirname, "data", "chromium-profile");
const PROXY_FETCH_TIMEOUT_MS = 20000;

const app = express();

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  next();
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));

const emptySession = () => ({
  browser: null,
  page: null,
  launchedAt: null,
  headless: true,
  targetUrl: null,
  proxy: null,
  proxyMode: "direct",
  proxyService: null,
});

let session = emptySession();

function createHttpError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function allowedProxyProtocols() {
  return ["http", "https", "socks4", "socks5"];
}

function defaultPortForProtocol(protocol) {
  if (protocol === "https") {
    return 443;
  }

  if (protocol === "socks4" || protocol === "socks5") {
    return 1080;
  }

  return 80;
}

function isSessionActive() {
  return Boolean(
    session.browser &&
      session.page &&
      typeof session.page.isClosed === "function" &&
      !session.page.isClosed()
  );
}

function normalizeTargetUrl(rawUrl) {
  const trimmed = String(rawUrl || "https://example.com").trim();
  const withProtocol = /^[a-z]+:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    return new URL(withProtocol).toString();
  } catch {
    throw createHttpError("Target URL must be a valid absolute URL.");
  }
}

function normalizeJsonObjectInput(rawValue, label) {
  if (!rawValue) {
    return {};
  }

  if (typeof rawValue === "object" && !Array.isArray(rawValue)) {
    return rawValue;
  }

  const text = String(rawValue).trim();

  if (!text) {
    return {};
  }

  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Expected a JSON object.");
    }
    return parsed;
  } catch (error) {
    throw createHttpError(`${label} must be a valid JSON object.`);
  }
}

function parseProxyUrl(rawValue) {
  const trimmed = String(rawValue || "").trim();

  if (!trimmed) {
    return null;
  }

  const asUrl = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url;

  try {
    url = new URL(asUrl);
  } catch {
    throw createHttpError("Proxy URL is not valid.");
  }

  const protocol = url.protocol.replace(/:$/, "").toLowerCase();

  if (!allowedProxyProtocols().includes(protocol)) {
    throw createHttpError(
      "Proxy protocol must be http, https, socks4, or socks5."
    );
  }

  return normalizeProxyConfig({
    protocol,
    host: url.hostname,
    port: url.port || defaultPortForProtocol(protocol),
    username: decodeURIComponent(url.username || ""),
    password: decodeURIComponent(url.password || ""),
  });
}

function normalizeProxyConfig(rawProxy = {}) {
  if (typeof rawProxy === "string") {
    return parseProxyUrl(rawProxy);
  }

  if (!rawProxy || typeof rawProxy !== "object") {
    return null;
  }

  const stringProxy =
    rawProxy.url || rawProxy.proxyUrl || rawProxy.uri || rawProxy.server;

  if (stringProxy && String(stringProxy).includes("://")) {
    return parseProxyUrl(stringProxy);
  }

  const protocol = String(rawProxy.protocol || "http").toLowerCase();
  const host = String(
    rawProxy.host ||
      rawProxy.hostname ||
      rawProxy.proxy_host ||
      rawProxy.proxyHost ||
      rawProxy.proxy_address ||
      ""
  ).trim();
  const portValue =
    rawProxy.port ??
    rawProxy.proxy_port ??
    rawProxy.proxyPort ??
    rawProxy.proxyPortNumber;
  const username = String(
    rawProxy.username || rawProxy.user || rawProxy.proxy_username || ""
  ).trim();
  const password = String(
    rawProxy.password || rawProxy.pass || rawProxy.proxy_password || ""
  ).trim();
  const bypass = String(rawProxy.bypass || rawProxy.proxyBypass || "").trim();

  if (!host) {
    if (portValue || username || password || bypass || stringProxy) {
      throw createHttpError(
        "Proxy host is required when proxy details are provided."
      );
    }

    return null;
  }

  if (!allowedProxyProtocols().includes(protocol)) {
    throw createHttpError(
      "Proxy protocol must be http, https, socks4, or socks5."
    );
  }

  const port = Number(portValue || defaultPortForProtocol(protocol));

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw createHttpError("Proxy port must be an integer between 1 and 65535.");
  }

  return {
    protocol,
    host,
    port,
    username,
    password,
    bypass,
  };
}

function normalizeProxyMode(rawMode, body = {}) {
  const explicitMode = String(rawMode || "").trim().toLowerCase();

  if (explicitMode) {
    if (!["direct", "manual", "service"].includes(explicitMode)) {
      throw createHttpError(
        "Proxy mode must be one of direct, manual, or service."
      );
    }

    return explicitMode;
  }

  if (body?.proxyService?.endpoint) {
    return "service";
  }

  const manualProxy =
    body?.proxy?.host ||
    body?.proxy?.url ||
    body?.proxy?.proxyUrl ||
    body?.proxy?.server;

  return manualProxy ? "manual" : "direct";
}

function normalizeProxyServiceConfig(rawService = {}) {
  const endpoint = String(rawService.endpoint || "").trim();

  if (!endpoint) {
    throw createHttpError("Proxy service endpoint is required.");
  }

  let endpointUrl;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    throw createHttpError("Proxy service endpoint must be a valid URL.");
  }

  const method = String(rawService.method || "POST").trim().toUpperCase();
  if (!["GET", "POST"].includes(method)) {
    throw createHttpError("Proxy service method must be GET or POST.");
  }

  const apiKey = String(rawService.apiKey || "").trim();
  const authHeaderName = String(
    rawService.authHeaderName || "Authorization"
  ).trim();
  const authScheme = String(rawService.authScheme || "Bearer").trim();
  const responsePath = String(rawService.responsePath || "").trim();
  const country = String(rawService.country || "").trim();
  const region = String(rawService.region || "").trim();
  const sessionId = String(rawService.sessionId || "").trim();
  const extraHeaders = normalizeJsonObjectInput(
    rawService.extraHeaders,
    "Proxy service extra headers"
  );
  const extraPayload = normalizeJsonObjectInput(
    rawService.extraPayload,
    "Proxy service extra payload"
  );

  return {
    endpoint: endpointUrl.toString(),
    method,
    apiKey,
    authHeaderName,
    authScheme,
    responsePath,
    country,
    region,
    sessionId,
    extraHeaders,
    extraPayload,
  };
}

function redactProxy(proxy) {
  if (!proxy) {
    return null;
  }

  return {
    protocol: proxy.protocol,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username || "",
    passwordSet: Boolean(proxy.password),
    bypass: proxy.bypass || "",
  };
}

function redactProxyService(proxyService) {
  if (!proxyService) {
    return null;
  }

  return {
    endpoint: proxyService.endpoint,
    method: proxyService.method,
    authHeaderName: proxyService.authHeaderName,
    authScheme: proxyService.authScheme,
    apiKeySet: Boolean(proxyService.apiKey),
    responsePath: proxyService.responsePath,
    country: proxyService.country,
    region: proxyService.region,
    sessionId: proxyService.sessionId,
    lastResolvedAt: proxyService.lastResolvedAt || null,
  };
}

function proxyServerString(proxy) {
  return `${proxy.protocol}://${proxy.host}:${proxy.port}`;
}

function extractByPath(value, rawPath) {
  const pathSegments = String(rawPath || "")
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);

  let current = value;
  for (const segment of pathSegments) {
    if (!current || typeof current !== "object" || !(segment in current)) {
      return undefined;
    }
    current = current[segment];
  }

  return current;
}

function parseServiceBody(rawBody, contentType) {
  const text = String(rawBody || "").trim();

  if (!text) {
    return null;
  }

  if (String(contentType || "").includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      throw createHttpError(
        "Proxy service returned invalid JSON.",
        502
      );
    }
  }

  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return text;
}

function candidateProxyValues(payload, responsePath) {
  if (responsePath) {
    return [extractByPath(payload, responsePath)];
  }

  if (typeof payload === "string") {
    return [payload];
  }

  return [
    payload?.proxy,
    payload?.proxyUrl,
    payload?.proxy_url,
    payload?.url,
    payload?.uri,
    payload?.server,
    payload?.data?.proxy,
    payload?.data?.proxyUrl,
    payload?.data?.url,
    payload?.result?.proxy,
    payload?.result?.proxyUrl,
    payload?.result?.url,
    payload?.data,
    payload?.result,
    payload,
  ];
}

function normalizeProxyFromServicePayload(payload, responsePath) {
  for (const candidate of candidateProxyValues(payload, responsePath)) {
    if (!candidate) {
      continue;
    }

    try {
      const proxy = normalizeProxyConfig(candidate);
      if (proxy) {
        return proxy;
      }
    } catch (error) {
      // Keep scanning candidates until one matches a supported shape.
    }
  }

  throw createHttpError(
    "Proxy service response did not contain a supported proxy shape.",
    502
  );
}

async function fetchProxyFromService(proxyService) {
  const endpointUrl = new URL(proxyService.endpoint);
  const payload = {
    ...proxyService.extraPayload,
  };

  if (proxyService.country) {
    payload.country = proxyService.country;
  }
  if (proxyService.region) {
    payload.region = proxyService.region;
  }
  if (proxyService.sessionId) {
    payload.sessionId = proxyService.sessionId;
  }

  const headers = {
    ...proxyService.extraHeaders,
  };

  if (proxyService.apiKey) {
    headers[proxyService.authHeaderName] = proxyService.authScheme
      ? `${proxyService.authScheme} ${proxyService.apiKey}`
      : proxyService.apiKey;
  }

  const requestOptions = {
    method: proxyService.method,
    headers,
    signal: AbortSignal.timeout(PROXY_FETCH_TIMEOUT_MS),
  };

  if (proxyService.method === "GET") {
    for (const [key, value] of Object.entries(payload)) {
      if (value === undefined || value === null || value === "") {
        continue;
      }
      endpointUrl.searchParams.set(
        key,
        typeof value === "object" ? JSON.stringify(value) : String(value)
      );
    }
  } else {
    requestOptions.headers["Content-Type"] = "application/json";
    requestOptions.body = JSON.stringify(payload);
  }

  let response;
  try {
    response = await fetch(endpointUrl, requestOptions);
  } catch (error) {
    throw createHttpError(
      `Proxy service request failed: ${error.message}`,
      502
    );
  }

  const rawBody = await response.text();

  if (!response.ok) {
    const snippet = rawBody.trim().slice(0, 240);
    throw createHttpError(
      `Proxy service request failed with ${response.status} ${response.statusText}${snippet ? `: ${snippet}` : "."}`,
      502
    );
  }

  const parsedBody = parseServiceBody(
    rawBody,
    response.headers.get("content-type")
  );
  const proxy = normalizeProxyFromServicePayload(
    parsedBody,
    proxyService.responsePath
  );

  return {
    proxy,
    proxyService: {
      ...proxyService,
      lastResolvedAt: new Date().toISOString(),
    },
  };
}

async function resolveProxySelection(body = {}) {
  const proxyMode = normalizeProxyMode(body.proxyMode, body);

  if (proxyMode === "direct") {
    return {
      proxyMode,
      proxy: null,
      proxyService: null,
    };
  }

  if (proxyMode === "manual") {
    const proxy = normalizeProxyConfig(body.proxy || {});

    if (!proxy) {
      throw createHttpError("Manual proxy mode requires proxy details.");
    }

    return {
      proxyMode,
      proxy,
      proxyService: null,
    };
  }

  const proxyService = normalizeProxyServiceConfig(body.proxyService || {});
  const resolved = await fetchProxyFromService(proxyService);

  return {
    proxyMode,
    proxy: resolved.proxy,
    proxyService: resolved.proxyService,
  };
}

function getAccessUrls() {
  const urls = new Set([`http://localhost:${PORT}`]);
  const interfaces = os.networkInterfaces();

  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses || []) {
      if (address.family !== "IPv4" || address.internal) {
        continue;
      }
      urls.add(`http://${address.address}:${PORT}`);
    }
  }

  return Array.from(urls);
}

function getServerMeta() {
  return {
    host: HOST,
    port: PORT,
    accessUrls: getAccessUrls(),
    mobileNote:
      "On mobile, the installed PWA is a control panel. The proxied browsing happens in the backend Chromium session, not inside the phone tab itself.",
  };
}

async function readSessionStatus() {
  const active = isSessionActive();
  let title = null;
  let currentUrl = null;

  if (active) {
    currentUrl = session.page.url();
    try {
      title = await session.page.title();
    } catch {
      title = null;
    }
  }

  return {
    active,
    launchedAt: session.launchedAt,
    headless: session.headless,
    targetUrl: session.targetUrl,
    currentUrl,
    title,
    proxyMode: session.proxyMode,
    proxy: redactProxy(session.proxy),
    proxyService: redactProxyService(session.proxyService),
  };
}

async function stopSession() {
  const browser = session.browser;
  session = emptySession();

  if (browser) {
    try {
      await browser.close();
    } catch {
      // Ignore shutdown errors during cleanup.
    }
  }
}

async function startSession({ targetUrl, headless, proxy, proxyMode, proxyService }) {
  await stopSession();
  await fs.mkdir(USER_DATA_DIR, { recursive: true });

  const args = [
    "--start-maximized",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--disable-setuid-sandbox",
  ];

  if (proxy) {
    args.push(`--proxy-server=${proxyServerString(proxy)}`);
    if (proxy.bypass) {
      args.push(`--proxy-bypass-list=${proxy.bypass}`);
    }
  }

  const browser = await puppeteer.launch({
    headless,
    userDataDir: USER_DATA_DIR,
    defaultViewport: headless ? { width: 430, height: 932 } : null,
    protocolTimeout: 120000,
    args,
  });

  browser.once("disconnected", () => {
    if (session.browser === browser) {
      session = emptySession();
    }
  });

  try {
    const [page] = await browser.pages();
    const activePage = page || (await browser.newPage());

    if (proxy && (proxy.username || proxy.password)) {
      await activePage.authenticate({
        username: proxy.username || "",
        password: proxy.password || "",
      });
    }

    await activePage.setViewport({ width: 430, height: 932, isMobile: true });
    await activePage.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });

    session = {
      browser,
      page: activePage,
      launchedAt: new Date().toISOString(),
      headless,
      targetUrl,
      proxy,
      proxyMode,
      proxyService,
    };
  } catch (error) {
    await browser.close().catch(() => {});
    session = emptySession();
    throw error;
  }
}

app.get("/api/meta", (req, res) => {
  res.json(getServerMeta());
});

app.get("/api/health", async (req, res) => {
  res.json({
    ok: true,
    meta: getServerMeta(),
    session: await readSessionStatus(),
  });
});

app.get("/api/session", async (req, res) => {
  res.json(await readSessionStatus());
});

app.post("/api/proxy/resolve", async (req, res) => {
  try {
    const resolved = await resolveProxySelection(req.body || {});
    res.json({
      proxyMode: resolved.proxyMode,
      proxy: redactProxy(resolved.proxy),
      proxyService: redactProxyService(resolved.proxyService),
      message: resolved.proxy
        ? `Resolved ${resolved.proxyMode} proxy ${proxyServerString(resolved.proxy)}`
        : "Direct mode selected. No proxy will be used.",
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post("/api/session/start", async (req, res) => {
  try {
    const targetUrl = normalizeTargetUrl(req.body?.targetUrl);
    const headless = Boolean(req.body?.headless);
    const resolved = await resolveProxySelection(req.body || {});

    await startSession({
      targetUrl,
      headless,
      proxy: resolved.proxy,
      proxyMode: resolved.proxyMode,
      proxyService: resolved.proxyService,
    });

    const routeLabel = resolved.proxy
      ? `through ${proxyServerString(resolved.proxy)}`
      : "without a proxy";

    res.json({
      message: `Browser launched ${routeLabel} using ${resolved.proxyMode} mode.`,
      session: await readSessionStatus(),
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post("/api/session/navigate", async (req, res) => {
  if (!isSessionActive()) {
    return res
      .status(409)
      .json({ error: "No live browser session. Start one first." });
  }

  try {
    const targetUrl = normalizeTargetUrl(req.body?.targetUrl);
    await session.page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    session.targetUrl = targetUrl;

    res.json({
      message: `Navigated to ${targetUrl}`,
      session: await readSessionStatus(),
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post("/api/session/stop", async (req, res) => {
  await stopSession();
  res.json({
    message: "Browser session stopped.",
    session: await readSessionStatus(),
  });
});

app.get("/api/session/screenshot", async (req, res) => {
  if (!isSessionActive()) {
    return res.status(404).json({ error: "No active browser session." });
  }

  try {
    const screenshot = await session.page.screenshot({
      type: "png",
      captureBeyondViewport: false,
      fullPage: false,
    });

    res.setHeader("Cache-Control", "no-store");
    res.type("png").send(screenshot);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    res.status(404).json({ error: "Not found." });
    return;
  }

  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await stopSession();
    process.exit(0);
  });
}

app.listen(PORT, HOST, () => {
  console.log(`Proxy PWA launcher running on ${HOST}:${PORT}`);
  for (const accessUrl of getAccessUrls()) {
    console.log(`Open from this network: ${accessUrl}`);
  }
  console.log(
    "Install the PWA in your browser, then use it as a mobile-friendly control panel for the backend browser session."
  );
});
