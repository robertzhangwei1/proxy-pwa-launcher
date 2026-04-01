import { createHash } from "crypto";
import express from "express";
import fs from "fs/promises";
import os from "os";
import path from "path";
import puppeteer from "puppeteer";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parsePositiveInt(process.env.PORT, 4317);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const SESSION_DATA_ROOT = path.join(__dirname, "data", "sessions");
const PROXY_FETCH_TIMEOUT_MS = parsePositiveInt(
  process.env.PROXY_FETCH_TIMEOUT_MS,
  20_000
);
const SESSION_IDLE_TIMEOUT_MINUTES = parsePositiveInt(
  process.env.SESSION_IDLE_TIMEOUT_MINUTES,
  20
);
const SESSION_IDLE_TIMEOUT_MS = SESSION_IDLE_TIMEOUT_MINUTES * 60_000;
const SESSION_SWEEP_INTERVAL_MS = parsePositiveInt(
  process.env.SESSION_SWEEP_INTERVAL_MS,
  60_000
);
const MAX_CONCURRENT_SESSIONS = parsePositiveInt(
  process.env.MAX_CONCURRENT_SESSIONS,
  10
);
const SESSION_TOKEN_HEADER = "x-launcher-token";
const PUBLIC_BASE_URL = normalizeOptionalUrl(process.env.PUBLIC_BASE_URL);
const CORS_ALLOWED_ORIGINS = parseAllowedOrigins(
  process.env.CORS_ALLOW_ORIGIN || "*"
);
const DEFAULT_TARGET_URL = normalizeTargetUrl(
  process.env.DEFAULT_TARGET_URL || "https://www.google.com",
  {
    allowDefault: false,
    label: "Default target URL",
  }
);
const DEFAULT_HEADLESS = parseBooleanValue(process.env.DEFAULT_HEADLESS, true);
const DEFAULT_PROXY = normalizeProxyConfig({
  protocol: process.env.DEFAULT_PROXY_PROTOCOL || "http",
  host: process.env.DEFAULT_PROXY_HOST || "",
  port: process.env.DEFAULT_PROXY_PORT || "",
  username: process.env.DEFAULT_PROXY_USERNAME || "",
  password: process.env.DEFAULT_PROXY_PASSWORD || "",
  bypass: process.env.DEFAULT_PROXY_BYPASS || "",
});

const sessions = new Map();
let sweepInProgress = false;

const app = express();
app.set("trust proxy", true);

app.use((req, res, next) => {
  applyCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    if (!originIsAllowed(req.get("origin"))) {
      res.status(403).end();
      return;
    }

    res.status(204).end();
    return;
  }

  next();
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));

function parsePositiveInt(rawValue, fallback) {
  const parsed = Number(rawValue);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseBooleanValue(rawValue, fallback) {
  const normalized = String(rawValue || "").trim().toLowerCase();

  if (!normalized) {
    return fallback;
  }

  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function normalizeOptionalUrl(rawValue) {
  const trimmed = String(rawValue || "").trim();

  if (!trimmed) {
    return "";
  }

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return "";
  }

  return url.toString().replace(/\/$/, "");
}

function parseAllowedOrigins(rawValue) {
  const origins = String(rawValue || "*")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return origins.length ? origins : ["*"];
}

function originIsAllowed(origin) {
  if (!origin) {
    return true;
  }

  return (
    CORS_ALLOWED_ORIGINS.includes("*") || CORS_ALLOWED_ORIGINS.includes(origin)
  );
}

function applyCorsHeaders(req, res) {
  const origin = req.get("origin");

  if (originIsAllowed(origin)) {
    res.setHeader(
      "Access-Control-Allow-Origin",
      origin && !CORS_ALLOWED_ORIGINS.includes("*") ? origin : origin || "*"
    );
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    `Content-Type, ${SESSION_TOKEN_HEADER}`
  );
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

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

function normalizeTargetUrl(
  rawUrl,
  { allowDefault = true, label = "Target URL" } = {}
) {
  const fallback = allowDefault ? DEFAULT_TARGET_URL : "";
  const trimmed = String(rawUrl || fallback).trim();

  if (!trimmed) {
    throw createHttpError(`${label} must be a valid absolute URL.`);
  }

  const withProtocol = /^[a-z]+:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  try {
    return new URL(withProtocol).toString();
  } catch {
    throw createHttpError(`${label} must be a valid absolute URL.`);
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
  } catch {
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
      throw createHttpError("Proxy service returned invalid JSON.", 502);
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
    } catch {
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
  const hasExplicitSelection = Boolean(
    body?.proxyMode ||
      body?.proxyService?.endpoint ||
      body?.proxy?.host ||
      body?.proxy?.url ||
      body?.proxy?.proxyUrl ||
      body?.proxy?.server
  );

  if (!hasExplicitSelection) {
    return {
      proxyMode: DEFAULT_PROXY ? "manual" : "direct",
      proxy: DEFAULT_PROXY,
      proxyService: null,
    };
  }

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

function profileDirectoryForToken(token) {
  const tokenHash = createHash("sha256").update(token).digest("hex");
  return path.join(SESSION_DATA_ROOT, tokenHash);
}

function createSessionRecord(token) {
  const now = new Date().toISOString();

  return {
    token,
    browser: null,
    page: null,
    launchedAt: null,
    headless: true,
    targetUrl: null,
    proxy: null,
    proxyMode: "direct",
    proxyService: null,
    userDataDir: profileDirectoryForToken(token),
    createdAt: now,
    lastSeenAt: now,
    lastActivityAt: null,
  };
}

function resetSessionState(record) {
  record.browser = null;
  record.page = null;
  record.launchedAt = null;
  record.headless = true;
  record.targetUrl = null;
  record.proxy = null;
  record.proxyMode = "direct";
  record.proxyService = null;
  record.lastActivityAt = null;
}

function isSessionActive(record) {
  return Boolean(
    record?.browser &&
      record?.page &&
      typeof record.page.isClosed === "function" &&
      !record.page.isClosed()
  );
}

function markSessionSeen(record) {
  record.lastSeenAt = new Date().toISOString();
}

function markSessionActivity(record) {
  const now = new Date().toISOString();
  record.lastSeenAt = now;
  record.lastActivityAt = now;
}

function sessionExpiryIso(record) {
  const touchedAt = Date.parse(record.lastSeenAt || record.createdAt);

  if (!Number.isFinite(touchedAt)) {
    return null;
  }

  return new Date(touchedAt + SESSION_IDLE_TIMEOUT_MS).toISOString();
}

async function cleanupProfileDirectory(record) {
  await fs.rm(record.userDataDir, { recursive: true, force: true }).catch(
    () => {}
  );
}

function countActiveSessions() {
  let activeCount = 0;

  for (const record of sessions.values()) {
    if (isSessionActive(record)) {
      activeCount += 1;
    }
  }

  return activeCount;
}

async function stopSession(record, { removeRecord = false } = {}) {
  const browser = record.browser;

  resetSessionState(record);
  markSessionSeen(record);

  if (browser) {
    try {
      await browser.close();
    } catch {
      // Ignore shutdown errors during cleanup.
    }
  }

  await cleanupProfileDirectory(record);

  if (removeRecord) {
    sessions.delete(record.token);
  }
}

async function cleanupExpiredSessions() {
  if (sweepInProgress) {
    return;
  }

  sweepInProgress = true;

  try {
    const now = Date.now();
    const expiredRecords = [];

    for (const record of sessions.values()) {
      const lastSeenAt = Date.parse(record.lastSeenAt || record.createdAt);

      if (!Number.isFinite(lastSeenAt)) {
        expiredRecords.push(record);
        continue;
      }

      if (now - lastSeenAt >= SESSION_IDLE_TIMEOUT_MS) {
        expiredRecords.push(record);
      }
    }

    for (const record of expiredRecords) {
      await stopSession(record, { removeRecord: true });
    }
  } finally {
    sweepInProgress = false;
  }
}

async function stopAllSessions() {
  for (const record of [...sessions.values()]) {
    await stopSession(record, { removeRecord: true });
  }
}

function readSessionToken(req) {
  const rawToken =
    req.get(SESSION_TOKEN_HEADER) ||
    req.query.sessionToken ||
    req.body?.sessionToken;
  const token = String(rawToken || "").trim();

  if (!token) {
    throw createHttpError(
      "Session token missing. Reopen or refresh the installed PWA.",
      400
    );
  }

  if (token.length < 24 || token.length > 200) {
    throw createHttpError("Session token is invalid.", 400);
  }

  if (!/^[A-Za-z0-9._:-]+$/.test(token)) {
    throw createHttpError("Session token contains unsupported characters.", 400);
  }

  return token;
}

async function getSessionRecord(req) {
  const token = readSessionToken(req);
  await cleanupExpiredSessions();

  let record = sessions.get(token);
  if (!record) {
    if (countActiveSessions() >= MAX_CONCURRENT_SESSIONS) {
      throw createHttpError(
        "The shared launcher is at capacity. Try again in a few minutes.",
        503
      );
    }

    record = createSessionRecord(token);
    sessions.set(token, record);
  }

  markSessionSeen(record);
  return record;
}

function requestOrigin(req) {
  const host = req.get("x-forwarded-host") || req.get("host");

  if (!host) {
    return "";
  }

  const forwardedProto = req
    .get("x-forwarded-proto")
    ?.split(",")
    .shift()
    ?.trim();
  const protocol = forwardedProto || req.protocol || "http";

  return `${protocol}://${host}`;
}

function getAccessUrls(req) {
  const urls = new Set([`http://localhost:${PORT}`]);
  const currentOrigin = requestOrigin(req);

  if (PUBLIC_BASE_URL) {
    urls.add(PUBLIC_BASE_URL);
  }

  if (currentOrigin) {
    urls.add(currentOrigin);
  }

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

function getServerMeta(req) {
  return {
    host: HOST,
    port: PORT,
    publicBaseUrl: PUBLIC_BASE_URL || requestOrigin(req),
    accessUrls: getAccessUrls(req),
    sessionHeaderName: SESSION_TOKEN_HEADER,
    quickLaunchReady: true,
    defaultTargetUrl: DEFAULT_TARGET_URL,
    defaultHeadless: DEFAULT_HEADLESS,
    defaultProxyMode: DEFAULT_PROXY ? "manual" : "direct",
    sessionIdleTimeoutMinutes: SESSION_IDLE_TIMEOUT_MINUTES,
    maxConcurrentSessions: MAX_CONCURRENT_SESSIONS,
    mobileNote:
      "Tap Launch Browser to start a proxied backend session. The actual browsing runs in backend Chromium, not in the phone tab itself.",
    sessionIsolationNote:
      "Each installed app keeps a private session token on that device, so users do not share screenshots, tabs, or proxy state.",
  };
}

async function readSessionStatus(record) {
  const active = isSessionActive(record);
  let title = null;
  let currentUrl = null;

  if (active) {
    currentUrl = record.page.url();
    try {
      title = await record.page.title();
    } catch {
      title = null;
    }
  }

  return {
    active,
    createdAt: record.createdAt,
    launchedAt: record.launchedAt,
    headless: record.headless,
    targetUrl: record.targetUrl,
    currentUrl,
    title,
    proxyMode: record.proxyMode,
    proxy: redactProxy(record.proxy),
    proxyService: redactProxyService(record.proxyService),
    lastSeenAt: record.lastSeenAt,
    lastActivityAt: record.lastActivityAt,
    idleExpiresAt: sessionExpiryIso(record),
  };
}

async function startSession(record, config) {
  await stopSession(record);
  await fs.mkdir(record.userDataDir, { recursive: true });

  const args = [
    "--start-maximized",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--disable-setuid-sandbox",
  ];

  if (config.proxy) {
    args.push(`--proxy-server=${proxyServerString(config.proxy)}`);
    if (config.proxy.bypass) {
      args.push(`--proxy-bypass-list=${config.proxy.bypass}`);
    }
  }

  const browser = await puppeteer.launch({
    headless: config.headless,
    userDataDir: record.userDataDir,
    defaultViewport: config.headless ? { width: 430, height: 932 } : null,
    protocolTimeout: 120_000,
    args,
  });

  browser.once("disconnected", () => {
    const currentRecord = sessions.get(record.token);

    if (!currentRecord || currentRecord.browser !== browser) {
      return;
    }

    resetSessionState(currentRecord);
    markSessionSeen(currentRecord);
    cleanupProfileDirectory(currentRecord).catch(() => {});
  });

  try {
    const [page] = await browser.pages();
    const activePage = page || (await browser.newPage());

    if (config.proxy && (config.proxy.username || config.proxy.password)) {
      await activePage.authenticate({
        username: config.proxy.username || "",
        password: config.proxy.password || "",
      });
    }

    await activePage.setViewport({ width: 430, height: 932, isMobile: true });
    await activePage.goto(config.targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });

    record.browser = browser;
    record.page = activePage;
    record.launchedAt = new Date().toISOString();
    record.headless = config.headless;
    record.targetUrl = config.targetUrl;
    record.proxy = config.proxy;
    record.proxyMode = config.proxyMode;
    record.proxyService = config.proxyService;
    markSessionActivity(record);
  } catch (error) {
    try {
      await browser.close();
    } catch {
      // Ignore shutdown errors during launch rollback.
    }

    resetSessionState(record);
    markSessionSeen(record);
    await cleanupProfileDirectory(record);
    throw error;
  }
}

function sendError(res, error) {
  res.status(error.statusCode || 500).json({ error: error.message });
}

app.get("/api/meta", (req, res) => {
  res.json(getServerMeta(req));
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    meta: getServerMeta(req),
    service: {
      sessionCount: sessions.size,
      activeSessions: countActiveSessions(),
    },
  });
});

app.get("/api/session", async (req, res) => {
  try {
    const record = await getSessionRecord(req);
    res.json(await readSessionStatus(record));
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/proxy/resolve", async (req, res) => {
  try {
    await getSessionRecord(req);
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
    sendError(res, error);
  }
});

app.post("/api/session/start", async (req, res) => {
  try {
    const record = await getSessionRecord(req);
    const targetUrl = normalizeTargetUrl(req.body?.targetUrl);
    const headless =
      req.body?.headless === undefined
        ? DEFAULT_HEADLESS
        : Boolean(req.body?.headless);
    const resolved = await resolveProxySelection(req.body || {});

    await startSession(record, {
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
      session: await readSessionStatus(record),
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/session/navigate", async (req, res) => {
  try {
    const record = await getSessionRecord(req);

    if (!isSessionActive(record)) {
      throw createHttpError("No live browser session. Start one first.", 409);
    }

    const targetUrl = normalizeTargetUrl(req.body?.targetUrl, {
      allowDefault: false,
    });
    await record.page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    record.targetUrl = targetUrl;
    markSessionActivity(record);

    res.json({
      message: `Navigated to ${targetUrl}`,
      session: await readSessionStatus(record),
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/session/stop", async (req, res) => {
  try {
    const record = await getSessionRecord(req);
    await stopSession(record);

    res.json({
      message: "Browser session stopped.",
      session: await readSessionStatus(record),
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/session/screenshot", async (req, res) => {
  try {
    const record = await getSessionRecord(req);

    if (!isSessionActive(record)) {
      throw createHttpError("No active browser session.", 404);
    }

    const screenshot = await record.page.screenshot({
      type: "png",
      captureBeyondViewport: false,
      fullPage: false,
    });

    markSessionActivity(record);
    res.setHeader("Cache-Control", "no-store");
    res.type("png").send(screenshot);
  } catch (error) {
    sendError(res, error);
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

const sweepTimer = setInterval(() => {
  cleanupExpiredSessions().catch((error) => {
    console.error("Session cleanup failed:", error);
  });
}, SESSION_SWEEP_INTERVAL_MS);

if (typeof sweepTimer.unref === "function") {
  sweepTimer.unref();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    clearInterval(sweepTimer);
    await stopAllSessions();
    process.exit(0);
  });
}

app.listen(PORT, HOST, () => {
  console.log(`Proxy PWA launcher running on ${HOST}:${PORT}`);
  console.log(`Idle session timeout: ${SESSION_IDLE_TIMEOUT_MINUTES} minutes`);
  console.log(`Max concurrent sessions: ${MAX_CONCURRENT_SESSIONS}`);
  if (PUBLIC_BASE_URL) {
    console.log(`Public backend URL: ${PUBLIC_BASE_URL}`);
  }
  for (const accessUrl of getAccessUrls({ get: () => undefined, protocol: "http" })) {
    console.log(`Reachable URL: ${accessUrl}`);
  }
  console.log(
    "Each installed PWA keeps its own private session token, so different users stay isolated on the shared backend."
  );
});
