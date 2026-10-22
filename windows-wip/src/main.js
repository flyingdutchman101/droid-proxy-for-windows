const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, execFile } = require("child_process");
const { createFrontProxy } = require("./proxy");

const APP_NAME = "DroidProxy Windows";
const AUTH_DIR = path.join(os.homedir(), ".cli-proxy-api");
const SETTINGS_PATH = path.join(AUTH_DIR, "droidproxy-windows.json");
const CONFIG_PATH = path.join(AUTH_DIR, "droidproxy-windows-config.yaml");
const FACTORY_SETTINGS_PATH = path.join(os.homedir(), ".factory", "settings.json");

const DEFAULT_SETTINGS = {
  host: "127.0.0.1",
  port: 8317,
  requestTimeout: "10m",
  requestRetry: 3,
  debug: false,
  model: "gpt-6.1-sol",
  maxOutputTokens: 128000,
  enableThinking: true,
  reasoningEffort: "medium"
};

// Auth file `type` -> login flag. Gemini goes through Google Antigravity OAuth,
// matching the macOS app.
const PROVIDERS = {
  codex: { label: "Codex", loginFlag: "-codex-login" },
  claude: { label: "Claude", loginFlag: "-claude-login" },
  antigravity: { label: "Gemini", loginFlag: "-antigravity-login" }
};

const ALL_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

function claudeModel(model, displayName, extra = {}) {
  return { model, displayName, providerKey: "claude", provider: "anthropic", maxOutputTokens: 128000, supportedReasoningEfforts: ALL_EFFORTS, defaultReasoningEffort: "xhigh", ...extra };
}

function geminiModel(model, displayName, efforts = ["high"]) {
  return { model, displayName, providerKey: "antigravity", provider: "openai", maxOutputTokens: 65536, supportedReasoningEfforts: efforts, defaultReasoningEffort: efforts[0] };
}

const FACTORY_MODELS = [
  {
    model: "gpt-6-astra",
    displayName: "DroidProxy: GPT 6 Astra",
    providerKey: "codex",
    provider: "openai",
    maxContextLimit: 272000,
    supportedReasoningEfforts: ALL_EFFORTS,
    defaultReasoningEffort: "medium"
  },
  {
    model: "gpt-6.1-sol",
    displayName: "DroidProxy: GPT 6.1 Sol",
    providerKey: "codex",
    provider: "openai",
    maxContextLimit: 272000,
    supportedReasoningEfforts: ALL_EFFORTS,
    defaultReasoningEffort: "medium"
  },
  {
    model: "gpt-6-luna",
    displayName: "DroidProxy: GPT 6 Luna",
    providerKey: "codex",
    provider: "openai",
    maxContextLimit: 272000,
    supportedReasoningEfforts: ALL_EFFORTS,
    defaultReasoningEffort: "medium"
  },
  claudeModel("claude-fable-5-1", "DroidProxy: Fable 5.1"),
  claudeModel("claude-opus-5-5", "DroidProxy: Opus 5.5"),
  claudeModel("claude-sonnet-5-5", "DroidProxy: Sonnet 5.5"),
  claudeModel("claude-haiku-5-5", "DroidProxy: Haiku 5.5", { maxContextLimit: 1000000 }),
  geminiModel("gemini-3.8-flash-high", "DroidProxy: Gemini 3.8 Flash (High)"),
  // Antigravity only serves this to paid (non-trial) Google AI Pro/Ultra accounts.
  geminiModel("gemini-4-argon-high", "DroidProxy: Gemini 4 Argon (High)")
];
const DROIDPROXY_MODEL_PREFIXES = ["custom:droidproxy:", "custom:CC:"];

let mainWindow;
let proxyProcess = null;
let frontProxy = null;
let logs = [];
let settings = loadSettings();

function getResourcePath(...parts) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "resources", ...parts);
  }
  return path.join(__dirname, "..", "resources", ...parts);
}

function cliBinaryPath() {
  return getResourcePath("bin", "cli-proxy-api.exe");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf8");
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(nextSettings) {
  settings = sanitizeSettings({ ...settings, ...nextSettings });
  ensureDir(AUTH_DIR);
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  writeConfig();
  return settings;
}

function sanitizeSettings(value) {
  const port = Number(value.port);
  const retry = Number(value.requestRetry);
  const maxOutputTokens = Number(value.maxOutputTokens);
  const host = String(value.host || DEFAULT_SETTINGS.host).trim();
  const timeout = String(value.requestTimeout || DEFAULT_SETTINGS.requestTimeout).trim();
  const modelDefinition = FACTORY_MODELS.find((item) => item.model === value.model) || FACTORY_MODELS[0];
  const model = modelDefinition.model;
  const reasoningEffort = modelDefinition.supportedReasoningEfforts.includes(value.reasoningEffort)
    ? value.reasoningEffort
    : modelDefinition.defaultReasoningEffort;

  return {
    host: /^[a-zA-Z0-9.:-]+$/.test(host) ? host : DEFAULT_SETTINGS.host,
    port: Number.isInteger(port) && port >= 1024 && port <= 65534 ? port : DEFAULT_SETTINGS.port,
    requestTimeout: timeout || DEFAULT_SETTINGS.requestTimeout,
    requestRetry: Number.isInteger(retry) && retry >= 0 && retry <= 10 ? retry : DEFAULT_SETTINGS.requestRetry,
    debug: Boolean(value.debug),
    model,
    maxOutputTokens: Number.isInteger(maxOutputTokens) && maxOutputTokens >= 1024 ? maxOutputTokens : DEFAULT_SETTINGS.maxOutputTokens,
    enableThinking: Boolean(value.enableThinking),
    reasoningEffort
  };
}

// cli-proxy-api listens one port above the public port; the front proxy owns
// the public port Factory talks to (8317 -> 8318, like the macOS app).
function backendPort() {
  return settings.port + 1;
}

function writeConfig() {
  ensureDir(AUTH_DIR);
  const templatePath = getResourcePath("config.template.yaml");
  let config = fs.readFileSync(templatePath, "utf8");
  config = config
    .replaceAll("__PORT__", String(backendPort()))
    .replaceAll("__HOST__", settings.host)
    .replaceAll("__DEBUG__", String(Boolean(settings.debug)))
    .replaceAll("__REQUEST_RETRY__", String(settings.requestRetry))
    .replaceAll("__REQUEST_TIMEOUT__", settings.requestTimeout);
  fs.writeFileSync(CONFIG_PATH, config);
  return CONFIG_PATH;
}

function log(line) {
  const stamp = new Date().toLocaleTimeString();
  logs.push(`[${stamp}] ${line}`);
  logs = logs.slice(-500);
  if (mainWindow) {
    mainWindow.webContents.send("state:logs", logs);
  }
}

function proxyState() {
  return {
    running: Boolean(proxyProcess && !proxyProcess.killed),
    pid: proxyProcess?.pid ?? null,
    baseUrl: `http://${settings.host}:${settings.port}/v1`
  };
}

function sendState() {
  if (!mainWindow) return;
  mainWindow.webContents.send("state:proxy", proxyState());
}

function killOrphanedProxy() {
  return new Promise((resolve) => {
    execFile("taskkill.exe", ["/IM", "cli-proxy-api.exe", "/F"], { windowsHide: true }, () => resolve());
  });
}

async function startProxy() {
  if (proxyProcess) return proxyState();

  const binary = cliBinaryPath();
  if (!fs.existsSync(binary)) {
    throw new Error(`Missing bundled proxy binary at ${binary}`);
  }

  writeConfig();
  await killOrphanedProxy();

  await startFrontProxy();

  proxyProcess = spawn(binary, ["-config", CONFIG_PATH], {
    cwd: path.dirname(binary),
    windowsHide: true,
    env: process.env
  });

  log(`Started cli-proxy-api on ${settings.host}:${backendPort()} (PID ${proxyProcess.pid})`);

  proxyProcess.stdout.on("data", (chunk) => log(chunk.toString().trim()));
  proxyProcess.stderr.on("data", (chunk) => log(chunk.toString().trim()));
  proxyProcess.on("exit", (code) => {
    log(`cli-proxy-api exited with code ${code}`);
    proxyProcess = null;
    stopFrontProxy();
    sendState();
  });

  sendState();
  return proxyState();
}

function startFrontProxy() {
  return new Promise((resolve, reject) => {
    const server = createFrontProxy({ targetHost: settings.host, targetPort: backendPort(), log });
    server.once("error", (error) => {
      reject(new Error(`Could not listen on ${settings.host}:${settings.port}: ${error.message}`));
    });
    server.listen(settings.port, settings.host, () => {
      frontProxy = server;
      log(`Front proxy listening on ${settings.host}:${settings.port}`);
      resolve();
    });
  });
}

function stopFrontProxy() {
  if (!frontProxy) return;
  frontProxy.close();
  frontProxy.closeAllConnections();
  frontProxy = null;
}

function stopProxy() {
  stopFrontProxy();
  if (!proxyProcess) return proxyState();
  log(`Stopping cli-proxy-api (PID ${proxyProcess.pid})`);
  proxyProcess.kill();
  proxyProcess = null;
  sendState();
  return proxyState();
}

function runLogin(providerKey) {
  const provider = PROVIDERS[providerKey];
  return new Promise((resolve, reject) => {
    if (!provider) {
      reject(new Error(`Unknown provider ${providerKey}`));
      return;
    }
    const binary = cliBinaryPath();
    if (!fs.existsSync(binary)) {
      reject(new Error(`Missing bundled proxy binary at ${binary}`));
      return;
    }

    writeConfig();
    const login = spawn(binary, ["--config", CONFIG_PATH, provider.loginFlag], {
      cwd: path.dirname(binary),
      windowsHide: true,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    log(`Started ${provider.label} login flow (PID ${login.pid})`);
    let output = "";
    login.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      log(text.trim());
    });
    login.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      log(text.trim());
    });

    // Codex login otherwise blocks on a manual callback prompt.
    if (providerKey === "codex") {
      setTimeout(() => {
        if (!login.killed) {
          login.stdin.write("\n");
        }
      }, 12000);
    }

    setTimeout(() => resolve({ started: true, output }), 1000);
    login.on("error", reject);
    login.on("exit", (code) => {
      log(`${provider.label} login command exited with code ${code}`);
      if (mainWindow) mainWindow.webContents.send("state:accountsChanged");
    });
  });
}

function listAccounts() {
  try {
    return fs.readdirSync(AUTH_DIR)
      .filter((file) => file.endsWith(".json"))
      .map((file) => {
        const filePath = path.join(AUTH_DIR, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
          const type = String(data.type || "").toLowerCase();
          if (!PROVIDERS[type]) return null;
          const expired = data.expired ? Date.parse(data.expired) : null;
          return {
            id: file,
            provider: type,
            providerLabel: PROVIDERS[type].label,
            email: data.email || data.login || file,
            disabled: Boolean(data.disabled),
            expired: Number.isFinite(expired) ? new Date(expired).toISOString() : null,
            isExpired: Number.isFinite(expired) ? expired < Date.now() : false,
            path: filePath,
            hasAccessToken: Boolean(data.access_token)
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function readAuthValues(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

async function fetchCodexUsage(accountId) {
  const account = listAccounts().find((item) => item.id === accountId && item.provider === "codex");
  if (!account) throw new Error("Codex account not found");

  const auth = readAuthValues(account.path);
  if (!auth.access_token) throw new Error("Missing access token");

  const headers = {
    Authorization: `Bearer ${auth.access_token}`,
    Accept: "application/json",
    "User-Agent": "codex-cli"
  };
  if (auth.account_id) {
    headers["ChatGPT-Account-Id"] = auth.account_id;
  }

  const response = await fetch("https://chatgpt.com/backend-api/wham/usage", { headers });
  if (!response.ok) {
    throw new Error(`Usage API returned ${response.status}`);
  }

  const json = await response.json();
  return parseUsageWindows(json);
}

function fetchUsage(accountId) {
  const account = listAccounts().find((item) => item.id === accountId);
  if (!account) throw new Error("Account not found");
  if (account.provider === "claude") return fetchClaudeUsage(account);
  if (account.provider === "antigravity") return fetchGeminiUsage(account);
  return fetchCodexUsage(accountId);
}

const CLAUDE_USAGE_BUCKETS = [
  ["five_hour", "5-hour"],
  ["seven_day", "Weekly"],
  ["seven_day_opus", "Weekly (Opus)"],
  ["seven_day_sonnet", "Weekly (Sonnet)"],
  ["seven_day_oauth_apps", "Weekly (OAuth Apps)"],
  ["seven_day_cowork", "Weekly (Cowork)"]
];

async function fetchClaudeUsage(account) {
  let auth = readAuthValues(account.path);
  if (!auth.access_token) throw new Error("Missing access token");

  let token = account.isExpired ? await refreshClaudeTokens(account.path, auth) : auth.access_token;
  let response = await claudeUsageRequest(token);
  if (response.status === 401 || response.status === 403) {
    auth = readAuthValues(account.path);
    token = await refreshClaudeTokens(account.path, auth);
    response = await claudeUsageRequest(token);
  }
  if (!response.ok) throw new Error(`Claude usage API returned ${response.status}`);

  const json = await response.json();
  // `utilization` is already a 0-100 percentage.
  return CLAUDE_USAGE_BUCKETS
    .filter(([key]) => typeof numberValue(json?.[key]?.utilization) === "number")
    .map(([key, title]) => usageWindow(title, {
      used_percent: Math.max(0, Math.min(100, numberValue(json[key].utilization))),
      resets_at: json[key].resets_at
    }));
}

function claudeUsageRequest(token) {
  return fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" }
  });
}

async function refreshClaudeTokens(filePath, auth) {
  if (!auth.refresh_token) throw new Error("No refresh token available");
  const response = await fetch("https://platform.claude.com/v1/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      grant_type: "refresh_token",
      refresh_token: auth.refresh_token
    })
  });
  if (!response.ok) throw new Error(`Claude token refresh failed (${response.status})`);

  const tokens = await response.json();
  if (!tokens.access_token || !tokens.refresh_token) throw new Error("Invalid token refresh response");
  // Re-read so fields cli-proxy-api wrote meanwhile are kept.
  const current = readAuthValues(filePath);
  current.access_token = tokens.access_token;
  current.refresh_token = tokens.refresh_token;
  current.expired = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString().replace(/\.\d+Z$/, "Z");
  current.last_refresh = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  fs.writeFileSync(filePath, JSON.stringify(current, null, 2));
  return tokens.access_token;
}

// Cloud Code only answers quota requests from the Antigravity Hub client family.
const ANTIGRAVITY_HEADERS = { "Content-Type": "application/json", "User-Agent": "antigravity/hub/2.9.1 windows/amd64" };

async function cloudCodeRequest(url, token, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...ANTIGRAVITY_HEADERS, Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });
  if (response.status === 401) throw new Error("Gemini token expired. Start the server so it refreshes, then retry.");
  if (!response.ok) throw new Error(`Gemini quota API returned ${response.status}`);
  return response.json();
}

async function fetchGeminiUsage(account) {
  const auth = readAuthValues(account.path);
  const token = auth.access_token || auth.token?.access_token;
  if (!token) throw new Error("Missing access token");

  let project = auth.project_id || auth.project;
  if (!project) {
    const codeAssist = await cloudCodeRequest("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", token, {
      metadata: { ideType: "ANTIGRAVITY", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" }
    });
    const ref = codeAssist?.cloudaicompanionProject;
    project = typeof ref === "string" ? ref : ref?.id;
  }
  const body = project ? { project } : {};

  try {
    const summary = await cloudCodeRequest("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", token, body);
    const windows = parseGeminiQuotaSummary(summary);
    if (windows.length) return windows;
  } catch (error) {
    log(`Gemini quota summary unavailable, using per-model quota: ${error.message}`);
  }

  const models = await cloudCodeRequest("https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels", token, body);
  return parseGeminiModelQuotas(models);
}

// Groups such as "Gemini Models" / "Claude and GPT models", each with 5-hour and
// weekly buckets carrying a 0-1 remaining fraction.
function parseGeminiQuotaSummary(json) {
  const payload = json?.response || json?.summary || json;
  const groups = Array.isArray(payload?.groups) ? payload.groups : [];
  return groups.flatMap((group) => (Array.isArray(group.buckets) ? group.buckets : [])
    .filter((bucket) => !bucket.disabled)
    .map((bucket) => {
      const fraction = numberValue(bucket.remaining?.remainingFraction ?? bucket.remainingFraction);
      if (typeof fraction !== "number") return null;
      const groupName = group.displayName || group.name || "Gemini";
      const bucketName = bucket.displayName || bucket.name || bucket.window || bucket.bucketId || "Limit";
      const window = usageWindow(`${groupName} · ${bucketName}`, { used_percent: (1 - fraction) * 100, resetTime: bucket.resetTime });
      if (!window.resetText && bucket.description) window.resetText = bucket.description;
      return window;
    })
    .filter(Boolean));
}

function parseGeminiModelQuotas(json) {
  const models = json?.models && typeof json.models === "object" ? json.models : {};
  const wanted = new Set(FACTORY_MODELS.filter((item) => item.providerKey === "antigravity").map((item) => item.model));
  return Object.entries(models)
    .filter(([id, model]) => wanted.has(id) && typeof numberValue(model?.quotaInfo?.remainingFraction) === "number")
    .map(([id, model]) => usageWindow(model.displayName || model.label || id, {
      used_percent: (1 - numberValue(model.quotaInfo.remainingFraction)) * 100,
      resetTime: model.quotaInfo.resetTime
    }));
}

function parseUsageWindows(json) {
  const rateLimit = json?.rate_limit;
  if (rateLimit) {
    return [
      usageWindow("5-hour", rateLimit.primary_window),
      usageWindow("Weekly", rateLimit.secondary_window)
    ].filter(Boolean);
  }
  return [];
}

function usageWindow(title, value) {
  if (!value || typeof value !== "object") return null;
  const usedPercent = numberValue(value.used_percent);
  const resetDate = resetDateFrom(value);
  return {
    title,
    usedPercent,
    remainingPercent: typeof usedPercent === "number" ? Math.max(0, 100 - usedPercent) : null,
    resetText: resetDate ? formatReset(resetDate) : resetTextFrom(value),
    resetDate: resetDate ? resetDate.toISOString() : null
  };
}

function numberValue(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace("%", ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function resetDateFrom(value) {
  for (const [key, item] of Object.entries(value)) {
    if (!key.toLowerCase().includes("reset")) continue;
    if (typeof item === "string") {
      const parsed = Date.parse(item);
      if (Number.isFinite(parsed)) return new Date(parsed);
    }
    if (typeof item === "number") {
      if (key.toLowerCase().includes("after")) return new Date(Date.now() + item * 1000);
      return new Date(item > 10000000000 ? item : item * 1000);
    }
  }
  return null;
}

function resetTextFrom(value) {
  for (const [key, item] of Object.entries(value)) {
    if (key.toLowerCase().includes("reset") && typeof item === "string") return item;
  }
  return null;
}

function formatReset(date) {
  const absolute = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
  const diffMs = date.getTime() - Date.now();
  const diffMinutes = Math.round(diffMs / 60000);
  const relative = Math.abs(diffMinutes) < 120
    ? `${Math.abs(diffMinutes)} minute${Math.abs(diffMinutes) === 1 ? "" : "s"} ${diffMinutes >= 0 ? "from now" : "ago"}`
    : `${Math.round(Math.abs(diffMinutes) / 60)} hour${Math.round(Math.abs(diffMinutes) / 60) === 1 ? "" : "s"} ${diffMinutes >= 0 ? "from now" : "ago"}`;
  return `${relative} (${absolute})`;
}

function factoryModels() {
  const origin = `http://${settings.host}:${settings.port}`;
  return FACTORY_MODELS.map((modelDefinition, index) => {
    const entry = {
      model: modelDefinition.model,
      id: `custom:droidproxy:${modelDefinition.model}`,
      index,
      // Anthropic clients append /v1/messages themselves.
      baseUrl: modelDefinition.provider === "anthropic" ? origin : `${origin}/v1`,
      apiKey: "dummy-not-used",
      displayName: modelDefinition.displayName,
      maxOutputTokens: modelDefinition.maxOutputTokens || settings.maxOutputTokens,
      noImageSupport: false,
      provider: modelDefinition.provider
    };
    if (modelDefinition.maxContextLimit) {
      entry.maxContextLimit = modelDefinition.maxContextLimit;
    }
    if (settings.enableThinking) {
      entry.enableThinking = true;
      entry.supportedReasoningEfforts = modelDefinition.supportedReasoningEfforts;
      entry.defaultReasoningEffort = modelDefinition.defaultReasoningEffort;
      entry.reasoningEffort = modelDefinition.defaultReasoningEffort;
    }
    return entry;
  });
}

function factoryStatus() {
  try {
    const settingsJson = JSON.parse(fs.readFileSync(FACTORY_SETTINGS_PATH, "utf8"));
    const customModels = Array.isArray(settingsJson.customModels) ? settingsJson.customModels : [];
    const expectedIds = new Set(factoryModels().map((model) => model.id));
    const installedIds = new Set(customModels
      .map((model) => model?.id)
      .filter((id) => typeof id === "string" && DROIDPROXY_MODEL_PREFIXES.some((prefix) => id.startsWith(prefix))));
    const installed = expectedIds.size > 0
      && installedIds.size === expectedIds.size
      && [...expectedIds].every((id) => installedIds.has(id));
    return { installed, path: FACTORY_SETTINGS_PATH };
  } catch {
    return { installed: false, path: FACTORY_SETTINGS_PATH };
  }
}

function applyFactoryModels() {
  ensureDir(path.dirname(FACTORY_SETTINGS_PATH));
  let factorySettings = {};
  if (fs.existsSync(FACTORY_SETTINGS_PATH)) {
    factorySettings = JSON.parse(fs.readFileSync(FACTORY_SETTINGS_PATH, "utf8"));
    const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
    fs.copyFileSync(FACTORY_SETTINGS_PATH, path.join(path.dirname(FACTORY_SETTINGS_PATH), `settings.json.droidproxy-windows-${timestamp}.bak`));
  }

  const existing = Array.isArray(factorySettings.customModels) ? factorySettings.customModels : [];
  const kept = existing.filter((model) => {
    const id = model?.id;
    return typeof id !== "string" || !DROIDPROXY_MODEL_PREFIXES.some((prefix) => id.startsWith(prefix));
  });

  const startIndex = kept.length;
  const nextModels = factoryModels().map((model, offset) => ({ ...model, index: startIndex + offset }));
  factorySettings.customModels = [...kept, ...nextModels];
  fs.writeFileSync(FACTORY_SETTINGS_PATH, JSON.stringify(factorySettings, null, 2).replaceAll("\\/", "/"));
  return factoryStatus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 820,
    minWidth: 420,
    minHeight: 640,
    title: APP_NAME,
    icon: getResourcePath("icon.png"),
    backgroundColor: "#0b0e11",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  ensureDir(AUTH_DIR);
  writeConfig();
  createWindow();
  // Factory can't reach the custom models until the proxy is up, so start it right away.
  startProxy().catch((error) => log(`Auto-start failed: ${error.message}`));
});

app.on("window-all-closed", () => {
  stopProxy();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  stopProxy();
});

ipcMain.handle("settings:get", () => settings);
ipcMain.handle("settings:save", (_event, nextSettings) => saveSettings(nextSettings));
ipcMain.handle("proxy:start", () => startProxy());
ipcMain.handle("proxy:stop", () => stopProxy());
ipcMain.handle("proxy:state", () => proxyState());
ipcMain.handle("logs:get", () => logs);
ipcMain.handle("auth:login", (_event, providerKey) => runLogin(providerKey));
ipcMain.handle("auth:accounts", () => listAccounts());
ipcMain.handle("usage:fetch", (_event, accountId) => fetchUsage(accountId));
ipcMain.handle("factory:status", () => factoryStatus());
ipcMain.handle("factory:apply", () => applyFactoryModels());
ipcMain.handle("paths:openAuth", () => {
  ensureDir(AUTH_DIR);
  shell.openPath(AUTH_DIR);
});
ipcMain.handle("paths:openFactory", () => {
  ensureDir(path.dirname(FACTORY_SETTINGS_PATH));
  shell.openPath(path.dirname(FACTORY_SETTINGS_PATH));
});
