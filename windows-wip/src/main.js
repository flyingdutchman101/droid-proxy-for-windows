const { app, BrowserWindow, ipcMain, shell, Tray, Menu, safeStorage, screen, net, clipboard } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, execFile } = require("child_process");
const crypto = require("crypto");

// Usage and balance requests use Chromium's network stack, which trusts the
// Windows certificate store. Node's bundled CA list rejected chatgpt.com with
// CERT_HAS_EXPIRED after a certificate-chain change.
const httpFetch = (url, options) => net.fetch(url, options);
const { createFrontProxy } = require("./proxy");
const {
  AUTO_MODEL_ID,
  AUTO_ROLE_IDS,
  ROLES,
  DEFAULT_ROLE_MODELS,
  CATEGORIES,
  DEFAULT_CATEGORY_MODELS,
  DEFAULT_CHAINS,
  DEFAULT_CLASSIFIER_MODELS,
  DEFAULT_OVERFLOW_THRESHOLD,
  DEFAULT_OVERFLOW_MODELS,
  DEFAULT_MISSION_OVERFLOW_MODELS,
  DEFAULT_PREMIUM,
  DEFAULT_PACE,
  createRouter
} = require("./router");
const { API_PROVIDERS, apiModelId, providerRegion, providerModels, regionForKey, effortsForModel, apiKeysYaml } = require("./providers");
const { createUsageTracker } = require("./usage");
const { pathToFileURL } = require("url");
const { createManager } = require("./manager/manager");
const { createMedia, TTS_MODELS, VIDEO_MODELS, VOICES, ASPECT_RATIOS, RESOLUTIONS } = require("./media");

const APP_NAME = "VeryCuteDroidProxy";
const APP_USER_MODEL_ID = "io.automaze.droidproxy.windows";

// Keep the pre-rename data folder: it holds the single-instance lock and the
// runtime copy of the backend, so builds before and after the rename still see
// each other instead of fighting over the port.
app.setPath("userData", path.join(app.getPath("appData"), "droidproxy-windows"));
const AUTH_DIR = path.join(os.homedir(), ".cli-proxy-api");
const SETTINGS_PATH = path.join(AUTH_DIR, "droidproxy-windows.json");
const CONFIG_PATH = path.join(AUTH_DIR, "droidproxy-windows-config.yaml");
const LOG_PATH = path.join(AUTH_DIR, "droidproxy-windows.log");
const FACTORY_SETTINGS_PATH = path.join(os.homedir(), ".factory", "settings.json");

// Saved routing choices that still name an older model version move to the
// newer one once; picking the old model again afterwards sticks.
const MODEL_MIGRATIONS = [{ id: "fable-5-2", from: "claude-fable-5-1", to: "claude-fable-5-2" }];

const DEFAULT_SETTINGS = {
  host: "127.0.0.1",
  port: 8317,
  requestTimeout: "10m",
  requestRetry: 3,
  debug: false,
  model: "gpt-6.1-sol",
  maxOutputTokens: 128000,
  enableThinking: true,
  reasoningEffort: "medium",
  autoEnabled: true,
  categoryModels: DEFAULT_CATEGORY_MODELS,
  // { [category]: { orchestrator|worker|validator: { model, backup, backup2 } } }
  roleModels: DEFAULT_ROLE_MODELS,
  classifierModels: DEFAULT_CLASSIFIER_MODELS,
  // Balanced: pick within each pool by remaining subscription quota.
  balanced: true,
  overflowThreshold: DEFAULT_OVERFLOW_THRESHOLD,
  overflowModels: DEFAULT_OVERFLOW_MODELS,
  missionOverflowModels: DEFAULT_MISSION_OVERFLOW_MODELS,
  // Fable for chosen task types while Claude has plenty of quota.
  premium: DEFAULT_PREMIUM,
  // Pace boost: while a plan's weekly/monthly window is ahead of pace by
  // `surplus` points, use its strongest models (at max effort if effortBoost).
  pace: DEFAULT_PACE,
  fallbackEnabled: true,
  fallbackChains: DEFAULT_CHAINS,
  // { [providerKey]: { region, keyEnc } }; keys are encrypted with Windows DPAPI.
  apiProviders: {},
  // Google Gemini API key for voice and video generation (not a chat upstream).
  googleMedia: {}
};

// Auth file `type` -> login flag. Gemini goes through Google Antigravity OAuth,
// matching the macOS app.
const PROVIDERS = {
  codex: { label: "Codex", loginFlag: "-codex-login" },
  claude: { label: "Claude", loginFlag: "-claude-login" },
  antigravity: { label: "Gemini", loginFlag: "-antigravity-login" },
  kimi: { label: "Kimi", loginFlag: "-kimi-login" }
};

const ALL_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

function claudeModel(model, displayName, extra = {}) {
  return { model, displayName, providerKey: "claude", provider: "anthropic", maxOutputTokens: 128000, supportedReasoningEfforts: ALL_EFFORTS, defaultReasoningEffort: "xhigh", ...extra };
}

function geminiModel(model, displayName, efforts = ["high"], extra = {}) {
  return { model, displayName, providerKey: "antigravity", provider: "openai", maxOutputTokens: 65536, supportedReasoningEfforts: efforts, defaultReasoningEffort: efforts[0], ...extra };
}

function kimiModel(model, displayName, maxOutputTokens, effort) {
  return { model, displayName, providerKey: "kimi", provider: "openai", maxOutputTokens, supportedReasoningEfforts: [effort], defaultReasoningEffort: effort };
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
    model: "gpt-6.1-terra",
    displayName: "DroidProxy: GPT 6.1 Terra",
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
  claudeModel("claude-fable-5-2", "DroidProxy: Fable 5.2"),
  claudeModel("claude-fable-5-1", "DroidProxy: Fable 5.1"),
  claudeModel("claude-opus-5-5", "DroidProxy: Opus 5.5"),
  claudeModel("claude-sonnet-5-5", "DroidProxy: Sonnet 5.5"),
  claudeModel("claude-haiku-5-5", "DroidProxy: Haiku 5.5", { maxContextLimit: 1000000 }),
  geminiModel("gemini-3.8-flash-high", "DroidProxy: Gemini 3.8 Flash (High)"),
  // Antigravity only serves this to paid (non-trial) Google AI Pro/Ultra accounts.
  geminiModel("gemini-4-argon-high", "DroidProxy: Gemini 4 Argon (High)"),
  // Google's frontier coding / long-horizon model (Oct 2026); served on
  // Google AI Ultra through Antigravity. Google rejects anything over 1,048,576
  // tokens and counts tokens differently from Factory, so Factory is told
  // 900k to compact with headroom.
  geminiModel("gemini-4-carbon-high", "DroidProxy: Gemini 4 Carbon (High)", ["high"], { maxContextLimit: 900000 }),
  // Claude served by the Google AI Pro/Ultra subscription instead of a Claude one.
  // The ag- aliases are rewritten to Antigravity's IDs in proxy.js, as on macOS.
  geminiModel("ag-c55o-high", "DroidProxy: Claude Opus 5.5 (High) via Google", ["high"], { maxOutputTokens: 128000, maxContextLimit: 1000000 }),
  geminiModel("ag-c55s-high", "DroidProxy: Claude Sonnet 5.5 (High) via Google", ["high"], { maxOutputTokens: 128000, maxContextLimit: 1000000 }),
  // CLIProxyAPI strips the kimi- prefix and sends Kimi Code's native model ID.
  kimiModel("kimi-k3", "DroidProxy: Kimi K3", 65536, "max"),
  kimiModel("kimi-k2.6", "DroidProxy: Kimi K2.6", 262144, "high")
];
const DROIDPROXY_MODEL_PREFIXES = ["custom:droidproxy:", "custom:CC:"];

// Factory's "Behaves like" (baseModelId): the built-in model whose prompts,
// tools, and reasoning levels a custom model inherits. IDs from Factory's
// Available Models page (Nov 2026). Models with no built-in twin map to the
// closest one in the same family; the proxy then maps any reasoning level the
// real model rejects to its nearest supported level. API models are looked up
// by their upstream name.
const BASE_MODEL_IDS = {
  "gpt-6-astra": "gpt-6-astra",
  "gpt-6.1-sol": "gpt-6.1-sol",
  "gpt-6.1-terra": "gpt-6.1-sol",
  "gpt-6-luna": "gpt-6-luna",
  "claude-fable-5-2": "claude-fable-5.1",
  "claude-fable-5-1": "claude-fable-5.1",
  "claude-opus-5-5": "claude-opus-5-5",
  "claude-sonnet-5-5": "claude-sonnet-5-5",
  "claude-haiku-5-5": "claude-haiku-5-5",
  "gemini-3.8-flash-high": "gemini-3.8-flash",
  "gemini-4-argon-high": "gemini-3.8-flash",
  "gemini-4-carbon-high": "gemini-3.8-flash",
  "ag-c55o-high": "claude-opus-5-5",
  "ag-c55s-high": "claude-sonnet-5-5",
  "kimi-k3": "kimi-k3",
  "kimi-k2.6": "kimi-k3",
  "kimi-k3.1-pro": "kimi-k3",
  "deepseek-v4-pro": "deepseek-v4-pro",
  "deepseek-flash": "deepseek-v4.1-flash",
  "glm-5.3": "glm-5.3",
  "qwen3.8-max": "qwen3.8-max",
  "qwen3.8-max-0902": "qwen3.8-max",
  "qwen3.8-flash": "qwen3.8-max"
};
// Auto requests arrive in Anthropic format and usually land on a strong model.
const AUTO_BASE_MODEL_ID = "claude-opus-5-5";

function baseModelIdFor(model) {
  if (AUTO_FACTORY_MODELS.some((item) => item.model === model)) return AUTO_BASE_MODEL_ID;
  return BASE_MODEL_IDS[model] || BASE_MODEL_IDS[model.split("/").pop()] || null;
}

// Reasoning levels each model accepts, for the proxy's effort mapping.
function effortsFor(model) {
  const api = effortsForModel(model);
  if (api) return api;
  return FACTORY_MODELS.find((item) => item.model === model)?.supportedReasoningEfforts || null;
}

let mainWindow;
let proxyProcess = null;
let frontProxy = null;
let router = null;
let usageTracker = null;
let tray = null;
let trayHintShown = false;
let isQuitting = false;
let logs = [];
let settings = loadSettings();
let resourcesRoot = null;

function bundledResourcesDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "resources");
  }
  return path.join(__dirname, "..", "resources");
}

function getResourcePath(...parts) {
  return path.join(resourcesRoot || bundledResourcesDir(), ...parts);
}

// The portable exe unpacks every launch into the same temp folder, and a second
// launch deletes or overwrites the running instance's files there (including the
// backend). Run from a private copy instead so relaunches cannot touch it.
function syncRuntimeResources() {
  const source = bundledResourcesDir();
  if (!app.isPackaged) return source;

  const target = path.join(app.getPath("userData"), "runtime");
  const copyTree = (from, to) => {
    ensureDir(to);
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (entry.isDirectory()) {
        copyTree(src, dst);
        continue;
      }
      const srcStat = fs.statSync(src);
      const dstStat = fs.existsSync(dst) ? fs.statSync(dst) : null;
      if (dstStat && dstStat.size === srcStat.size && Math.abs(dstStat.mtimeMs - srcStat.mtimeMs) < 2000) continue;
      fs.copyFileSync(src, dst);
      fs.utimesSync(dst, srcStat.atime, srcStat.mtime);
    }
  };

  try {
    copyTree(source, target);
    return target;
  } catch (error) {
    log(`Could not prepare runtime copy, using bundled resources: ${error.message}`);
    return source;
  }
}

function cliBinaryPath() {
  return getResourcePath("bin", "cli-proxy-api.exe");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function migrateSettings(saved) {
  const done = new Set(Array.isArray(saved.migrations) ? saved.migrations : []);
  for (const { id, from, to } of MODEL_MIGRATIONS) {
    if (done.has(id)) continue;
    const swap = (value) => (value === from ? to : value);
    if (saved.premium?.model) saved.premium.model = swap(saved.premium.model);
    for (const category of Object.keys(saved.categoryModels || {})) saved.categoryModels[category] = swap(saved.categoryModels[category]);
    for (const roles of Object.values(saved.roleModels || {})) {
      for (const cell of Object.values(roles || {})) {
        for (const slot of ["model", "backup", "backup2"]) if (cell && cell[slot]) cell[slot] = swap(cell[slot]);
      }
    }
    for (const key of ["overflowModels", "missionOverflowModels", "classifierModels"]) {
      if (Array.isArray(saved[key])) saved[key] = saved[key].map(swap);
    }
    if (saved.fallbackChains) {
      for (const [model, chain] of Object.entries(saved.fallbackChains)) saved.fallbackChains[model] = Array.isArray(chain) ? chain.map(swap) : chain;
      if (saved.fallbackChains[from] && !saved.fallbackChains[to]) saved.fallbackChains[to] = DEFAULT_CHAINS[to] || saved.fallbackChains[from];
    }
    done.add(id);
  }
  saved.migrations = [...done];
  return saved;
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf8");
    return sanitizeSettings({ ...DEFAULT_SETTINGS, ...migrateSettings(JSON.parse(raw)) });
  } catch {
    return sanitizeSettings({ ...DEFAULT_SETTINGS });
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
    reasoningEffort,
    migrations: Array.isArray(value.migrations) ? value.migrations.filter((item) => typeof item === "string") : MODEL_MIGRATIONS.map((item) => item.id),
    autoEnabled: value.autoEnabled !== false,
    categoryModels: Object.fromEntries(Object.keys(CATEGORIES).map((category) => {
      const chosen = value.categoryModels?.[category];
      return [category, typeof chosen === "string" && chosen ? chosen : DEFAULT_CATEGORY_MODELS[category]];
    })),
    roleModels: Object.fromEntries(Object.keys(CATEGORIES).map((category) => [category, Object.fromEntries(ROLES.map((roleName) => {
      const fallback = DEFAULT_ROLE_MODELS[category][roleName];
      const chosen = value.roleModels?.[category]?.[roleName] || {};
      const model = typeof chosen.model === "string" && chosen.model ? chosen.model : fallback.model;
      const backup = typeof chosen.backup === "string" ? chosen.backup : fallback.backup;
      const backup2 = typeof chosen.backup2 === "string" ? chosen.backup2 : fallback.backup2;
      const cleanBackup = backup === model ? "" : backup;
      return [roleName, { model, backup: cleanBackup, backup2: backup2 === model || backup2 === cleanBackup ? "" : backup2 }];
    }))])),
    classifierModels: stringList(value.classifierModels, DEFAULT_CLASSIFIER_MODELS),
    balanced: value.balanced !== false,
    overflowThreshold: Number.isFinite(Number(value.overflowThreshold)) ? Math.min(100, Math.max(0, Number(value.overflowThreshold))) : DEFAULT_OVERFLOW_THRESHOLD,
    overflowModels: stringList(value.overflowModels, DEFAULT_OVERFLOW_MODELS).slice(0, 4),
    missionOverflowModels: stringList(value.missionOverflowModels, DEFAULT_MISSION_OVERFLOW_MODELS).slice(0, 4),
    premium: {
      enabled: value.premium?.enabled !== false,
      model: typeof value.premium?.model === "string" && value.premium.model ? value.premium.model : DEFAULT_PREMIUM.model,
      threshold: Number.isFinite(Number(value.premium?.threshold)) ? Math.min(100, Math.max(0, Number(value.premium.threshold))) : DEFAULT_PREMIUM.threshold,
      categories: stringList(value.premium?.categories, DEFAULT_PREMIUM.categories).filter((category) => CATEGORIES[category])
    },
    // Replaces the older 24-hour "expiringBoost" rule; its on/off carries over.
    pace: {
      enabled: (value.pace?.enabled ?? value.expiringBoost?.enabled) !== false,
      surplus: Number.isFinite(Number(value.pace?.surplus)) ? Math.min(100, Math.max(0, Number(value.pace.surplus))) : DEFAULT_PACE.surplus,
      effortBoost: value.pace?.effortBoost !== false
    },
    fallbackEnabled: value.fallbackEnabled !== false,
    fallbackChains: Object.fromEntries(Object.entries(value.fallbackChains || DEFAULT_CHAINS)
      .filter(([model]) => typeof model === "string" && model)
      .map(([model, chain]) => [model, stringList(chain, []).filter((item) => item !== model).slice(0, 6)])),
    apiProviders: Object.fromEntries(Object.entries(value.apiProviders || {})
      .filter(([key, entry]) => API_PROVIDERS[key] && typeof entry?.keyEnc === "string" && entry.keyEnc)
      .map(([key, entry]) => [key, { region: providerRegionKey(key, entry.region), keyEnc: entry.keyEnc }])),
    googleMedia: typeof value.googleMedia?.keyEnc === "string" && value.googleMedia.keyEnc ? { keyEnc: value.googleMedia.keyEnc } : {}
  };
}

function stringList(value, fallback) {
  if (!Array.isArray(value)) return [...fallback];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function providerRegionKey(providerKey, regionKey) {
  const regions = API_PROVIDERS[providerKey].regions;
  return regions[regionKey] ? regionKey : Object.keys(regions)[0];
}

function encryptSecret(secret) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows encryption is not available, so the key cannot be stored safely.");
  return safeStorage.encryptString(secret).toString("base64");
}

function decryptSecret(encoded) {
  try {
    return safeStorage.decryptString(Buffer.from(encoded, "base64"));
  } catch (error) {
    if (Date.now() - lastDecryptWarning > 60 * 1000) {
      lastDecryptWarning = Date.now();
      log(`Could not decrypt a saved API key (${error.message}); will retry`);
    }
    return "";
  }
}
let lastDecryptWarning = 0;

// Decryption can fail transiently when Windows starts the app very early, which
// used to drop every API provider from the backend config until the next
// restart. Rewrite the config once all saved keys decrypt again.
let apiProvidersInConfig = 0;
function ensureApiKeysInConfig() {
  const saved = Object.keys(settings.apiProviders || {}).length;
  if (apiProvidersInConfig >= saved) return;
  const before = apiProvidersInConfig;
  writeConfig();
  if (apiProvidersInConfig > before) log(`API providers restored in backend config (${apiProvidersInConfig} of ${saved})`);
}

function configuredApiProviders() {
  return Object.fromEntries(Object.entries(settings.apiProviders || {})
    .map(([key, entry]) => [key, { region: entry.region, apiKey: decryptSecret(entry.keyEnc) }])
    .filter(([, entry]) => entry.apiKey));
}

// API-key models become Factory models only once their provider has a key.
function apiFactoryModels() {
  return Object.entries(configuredApiProviders()).flatMap(([providerKey, entry]) => providerModels(providerKey, entry.region).map((model) => ({
    model: apiModelId(providerKey, model.name),
    displayName: `DroidProxy: ${model.displayName}`,
    providerKey,
    provider: "generic-chat-completion-api",
    maxOutputTokens: model.maxOutputTokens,
    maxContextLimit: model.maxContextLimit,
    supportedReasoningEfforts: model.efforts,
    defaultReasoningEffort: model.efforts.includes("high") ? "high" : model.efforts[0]
  })));
}

// Factory sends Auto requests in Anthropic format; CLIProxyAPI translates them
// for whichever provider's model the router picks.
const autoFactoryModel = (model, displayName) => ({
  model,
  displayName,
  providerKey: "auto",
  provider: "anthropic",
  maxOutputTokens: 128000,
  supportedReasoningEfforts: ALL_EFFORTS,
  defaultReasoningEffort: "high"
});
const ROLE_LABELS = { orchestrator: "Orchestrator", worker: "Worker", validator: "Validator" };
const AUTO_FACTORY_MODELS = [
  autoFactoryModel(AUTO_MODEL_ID, "DroidProxy: Auto (best model per task)"),
  ...Object.entries(AUTO_ROLE_IDS).map(([model, roleName]) => autoFactoryModel(model, `DroidProxy: Auto · ${ROLE_LABELS[roleName]}`))
];

const factoryModelId = (model) => `custom:droidproxy:${model.replaceAll("/", "-")}`;

// Where Factory keeps the model for each mode, with its reasoning-effort key.
// Spec mode plans, so it defaults to the orchestrator role.
const FACTORY_MODE_SLOTS = [
  { key: "normal", label: "Normal sessions", model: ["sessionDefaultSettings", "model"], effort: ["sessionDefaultSettings", "reasoningEffort"], recommended: AUTO_MODEL_ID },
  { key: "spec", label: "Spec mode", model: ["sessionDefaultSettings", "specModeModel"], effort: ["sessionDefaultSettings", "specModeReasoningEffort"], recommended: `${AUTO_MODEL_ID}-orchestrator` },
  { key: "orchestrator", label: "Mission orchestrator", model: ["missionOrchestratorModel"], effort: ["missionOrchestratorReasoningEffort"], recommended: `${AUTO_MODEL_ID}-orchestrator` },
  { key: "worker", label: "Mission worker", model: ["missionModelSettings", "workerModel"], effort: ["missionModelSettings", "workerReasoningEffort"], recommended: `${AUTO_MODEL_ID}-worker` },
  { key: "validator", label: "Mission validator", model: ["missionModelSettings", "validationWorkerModel"], effort: ["missionModelSettings", "validationWorkerReasoningEffort"], recommended: `${AUTO_MODEL_ID}-validator` }
];

function allModelDefinitions() {
  return [...FACTORY_MODELS, ...apiFactoryModels()];
}

function modelOptions() {
  return allModelDefinitions().map((item) => ({
    id: item.model,
    label: item.displayName.replace(/^DroidProxy: /, ""),
    provider: item.providerKey
  }));
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
  const providers = configuredApiProviders();
  config += apiKeysYaml(providers);
  fs.writeFileSync(CONFIG_PATH, config);
  apiProvidersInConfig = Object.keys(providers).length;
  return CONFIG_PATH;
}

// Also kept on disk so problems after the window was closed can be diagnosed.
function appendLogFile(entry) {
  try {
    ensureDir(AUTH_DIR);
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > 2 * 1024 * 1024) {
      fs.renameSync(LOG_PATH, `${LOG_PATH}.old`);
    }
    fs.appendFileSync(LOG_PATH, `${entry}\n`);
  } catch {
    // Logging must never break the app.
  }
}

function log(line) {
  const stamp = new Date().toLocaleTimeString();
  logs.push(`[${stamp}] ${line}`);
  logs = logs.slice(-500);
  appendLogFile(`[${new Date().toISOString()}] [pid ${process.pid}] ${line}`);
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
  updateTrayMenu();
  if (!mainWindow) return;
  mainWindow.webContents.send("state:proxy", proxyState());
}

function killOrphanedProxy() {
  log("Stopping any leftover cli-proxy-api.exe before starting a new one");
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

  const child = spawn(binary, ["-config", CONFIG_PATH], {
    cwd: path.dirname(binary),
    windowsHide: true,
    env: process.env
  });
  proxyProcess = child;

  log(`Started cli-proxy-api on ${settings.host}:${backendPort()} (PID ${child.pid})`);

  child.stdout.on("data", (chunk) => log(chunk.toString().trim()));
  child.stderr.on("data", (chunk) => log(chunk.toString().trim()));
  child.on("exit", (code) => {
    log(`cli-proxy-api exited with code ${code}`);
    // stopProxy() clears proxyProcess first, so a match here means an unexpected exit.
    const unexpected = proxyProcess === child;
    proxyProcess = null;
    stopFrontProxy();
    sendState();
    if (unexpected && !isQuitting) scheduleProxyRestart();
  });

  sendState();
  return proxyState();
}

// Keep Factory's endpoint alive if the backend dies, but stop retrying if it
// keeps crashing so a broken setup does not loop forever.
const restartTimes = [];
function scheduleProxyRestart() {
  const now = Date.now();
  while (restartTimes.length && now - restartTimes[0] > 5 * 60 * 1000) restartTimes.shift();
  if (restartTimes.length >= 5) {
    log("cli-proxy-api keeps exiting; not restarting again. Use Server status to start it.");
    return;
  }
  restartTimes.push(now);
  const delay = 2000 * restartTimes.length;
  log(`Restarting cli-proxy-api in ${delay / 1000}s`);
  setTimeout(() => {
    if (isQuitting || proxyProcess) return;
    startProxy().catch((error) => {
      log(`Restart failed: ${error.message}`);
      scheduleProxyRestart();
    });
  }, delay);
}

// Kept across backend restarts so cool-downs and Auto session choices survive.
function getRouter() {
  if (router && router.port === backendPort()) return router;
  router = createRouter({
    targetHost: settings.host,
    targetPort: backendPort(),
    log,
    getConfig: () => ({
      fallbackEnabled: settings.fallbackEnabled,
      fallbackChains: settings.fallbackChains,
      categoryModels: settings.categoryModels,
      roleModels: settings.roleModels,
      classifierModels: settings.classifierModels,
      balanced: settings.balanced,
      overflowThreshold: settings.overflowThreshold,
      overflowModels: settings.overflowModels,
      missionOverflowModels: settings.missionOverflowModels,
      premium: settings.premium,
      pace: settings.pace,
      quotaFor,
      paceFor,
      isAvailable: (model) => modelOptions().some((item) => item.id === model)
    }),
    onFallback: (from, to, until) => {
      const label = (id) => modelOptions().find((item) => item.id === id)?.label || id;
      const when = until ? ` until about ${until.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
      if (tray) tray.displayBalloon({ title: "DroidProxy backup model", content: `${label(from)} is out of quota${when}. Using ${label(to)}.` });
      sendState();
    }
  });
  router.port = backendPort();
  return router;
}

function startFrontProxy() {
  return new Promise((resolve, reject) => {
    const server = createFrontProxy({ targetHost: settings.host, targetPort: backendPort(), log, router: getRouter(), usageTracker: getUsageTracker(), effortsFor });
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

  const response = await httpFetch("https://chatgpt.com/backend-api/wham/usage", { headers });
  if (!response.ok) {
    throw new Error(`Usage API returned ${response.status}`);
  }

  const json = await response.json();
  return parseUsageWindows(json);
}

// API-key models are tracked by their provider prefix ("qwen/qwen3.8-max").
function getUsageTracker() {
  if (!usageTracker) {
    usageTracker = createUsageTracker({
      filePath: path.join(AUTH_DIR, "droidproxy-windows-api-usage.json"),
      log,
      tracks: (model) => typeof model === "string" && Object.keys(API_PROVIDERS).some((key) => model.startsWith(`${key}/`))
    });
  }
  return usageTracker;
}

// Qwen Cloud grants new accounts a free quota per model, "typically 1,000,000
// tokens" for 90 days, but exposes no API to read what's left.
const QWEN_FREE_QUOTA_TOKENS = 1000000;

const formatTokens = (count) => count >= 1e6 ? `${(count / 1e6).toFixed(2)}M` : count >= 1e3 ? `${(count / 1e3).toFixed(1)}K` : String(count);
const sinceText = (iso) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

function tokenWindows(providerKey, regionKey) {
  const models = getUsageTracker().summary();
  // Token Plan bills in Credits, so a token-based free-quota estimate would mislead.
  const estimateFreeQuota = providerKey === "qwen" && regionKey !== "tokenplan";
  return providerModels(providerKey, regionKey).map((model) => {
    const id = apiModelId(providerKey, model.name);
    const item = models[id];
    if (!item) return { title: `${model.displayName} · tokens`, detail: "No requests through DroidProxy yet" };
    const used = item.input + item.output;
    const base = {
      title: `${model.displayName} · tokens`,
      detail: `${formatTokens(item.input)} in · ${formatTokens(item.output)} out · ${item.requests} requests since ${sinceText(item.since)}`
    };
    if (item.quotaError) base.detail += ` · quota error: ${item.quotaError.message}`;
    if (!estimateFreeQuota) return base;
    const remaining = Math.max(0, 100 - (used / QWEN_FREE_QUOTA_TOKENS) * 100);
    return {
      ...base,
      title: `${model.displayName} · free quota (estimate)`,
      remainingPercent: item.quotaError ? 0 : remaining,
      detail: `${base.detail} · ${formatTokens(used)} of ${formatTokens(QWEN_FREE_QUOTA_TOKENS)}`
    };
  });
}

async function deepseekBalance(apiKey) {
  const response = await httpFetch("https://api.deepseek.com/user/balance", { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } });
  if (!response.ok) throw new Error(`DeepSeek balance API returned ${response.status}`);
  const json = await response.json();
  const symbol = { USD: "$", CNY: "¥" };
  return (json.balance_infos || []).map((info) => ({
    title: `Balance (${info.currency})`,
    detail: `${symbol[info.currency] || ""}${info.total_balance} available (granted ${info.granted_balance}, topped up ${info.topped_up_balance})${json.is_available ? "" : " · not enough to make calls"}`
  }));
}

async function apiUsage() {
  const configured = configuredApiProviders();
  return Promise.all(Object.entries(configured).map(async ([key, entry]) => {
    const result = { provider: key, label: API_PROVIDERS[key].label, windows: [], note: "" };
    try {
      if (key === "deepseek") result.windows.push(...await deepseekBalance(entry.apiKey));
    } catch (error) {
      result.error = error.message;
    }
    result.windows.push(...tokenWindows(key, entry.region));
    if (key === "qwen" && entry.region === "tokenplan") {
      result.note = "Token Plan usage is measured in monthly Credits with no usage API. Token counts cover DroidProxy traffic only; remaining Credits are at home.qwencloud.com/analytics/token-plan/individual.";
    } else if (key === "qwen") {
      result.note = "Qwen Cloud has no usage API for API keys. Counts cover DroidProxy traffic only; the console's Free Tier page (home.qwencloud.com/benefits) is authoritative.";
    }
    return result;
  }));
}

// Remaining quota per subscription pool, for balanced routing. Each value is
// the tightest window's "% left"; with several accounts the best one counts,
// since the backend rotates between them.
const QUOTA_REFRESH_MS = 10 * 60 * 1000;
let quotaCache = { buckets: {}, updatedAt: null };

function quotaBucket(model) {
  if (model.startsWith("ag-")) return "antigravity-claude";
  if (model.startsWith("claude-")) return "claude";
  if (model.startsWith("gpt-")) return "codex";
  if (model.startsWith("gemini-")) return "antigravity-gemini";
  return null;
}

function quotaFor(model) {
  const bucket = quotaBucket(model);
  const value = bucket ? quotaCache.buckets[bucket] : undefined;
  return typeof value === "number" ? value : null;
}

// Weekly/monthly windows are the ones whose unused quota is lost at reset;
// 5-hour windows refill constantly.
const isLongWindow = (title) => /week|month|7.?day|30.?day/i.test(title || "");

async function refreshQuotaCache() {
  ensureApiKeysInConfig();
  const buckets = {};
  const short = {};
  const long = {};
  let failed = 0;
  const keepMax = (target, bucket, value) => {
    if (typeof value !== "number") return;
    target[bucket] = Math.max(target[bucket] ?? -1, value);
  };
  const tightest = (windows) => {
    const values = windows.map((item) => item.remainingPercent).filter((value) => typeof value === "number");
    return values.length ? Math.min(...values) : undefined;
  };
  // Per bucket: the long window that resets soonest, with its % left.
  const keepLong = (bucket, windows) => {
    for (const item of windows.filter((entry) => isLongWindow(entry.title) && typeof entry.remainingPercent === "number" && entry.resetDate)) {
      const current = long[bucket];
      if (!current || Date.parse(item.resetDate) < Date.parse(current.resetAt)) long[bucket] = { left: item.remainingPercent, resetAt: item.resetDate, title: item.title };
    }
  };
  const record = (bucket, windows) => {
    keepMax(buckets, bucket, tightest(windows));
    keepMax(short, bucket, tightest(windows.filter((item) => !isLongWindow(item.title))));
    keepLong(bucket, windows);
  };
  for (const account of listAccounts().filter((item) => !item.disabled && ["codex", "claude", "antigravity"].includes(item.provider))) {
    try {
      const windows = await fetchUsage(account.id);
      if (account.provider !== "antigravity") {
        record(account.provider, windows);
        continue;
      }
      // Antigravity groups: "Gemini Models" vs "Claude and GPT models".
      record("antigravity-claude", windows.filter((item) => /claude|gpt/i.test(item.title)));
      record("antigravity-gemini", windows.filter((item) => !/claude|gpt/i.test(item.title)));
    } catch (error) {
      failed += 1;
      log(`Balanced routing: could not read ${account.providerLabel} quota (${error.message})`);
    }
  }
  quotaCache = { buckets, short, long, failed, updatedAt: new Date().toISOString() };
  const describe = ([key, value]) => {
    const info = paceInfo(key);
    return `${key} ${Math.round(value)}%${info ? ` (weekly ${Math.round(info.left)}%, ${info.surplus >= 0 ? "+" : ""}${Math.round(info.surplus)} vs pace${isAhead(info) ? ", boosting" : ""})` : ""}`;
  };
  log(`Balanced routing quotas: ${Object.entries(buckets).map(describe).join(", ") || "none available"}`);
  return quotaCache;
}

// Weekly pace for a plan: % left in its long window against % of the window's
// time left. surplus > 0 means quota that will reset unused at the current rate.
function paceInfo(bucket) {
  const entry = quotaCache.long?.[bucket];
  if (!entry) return null;
  const hoursLeft = (Date.parse(entry.resetAt) - Date.now()) / 3600000;
  if (!(hoursLeft > 0)) return null;
  const windowHours = /month|30.?day/i.test(entry.title || "") ? 720 : 168;
  const target = Math.min(100, (100 * hoursLeft) / windowHours);
  const shortLeft = quotaCache.short?.[bucket];
  return { left: entry.left, hoursLeft, windowHours, target, surplus: entry.left - target, shortLeft: typeof shortLeft === "number" ? shortLeft : null, resetAt: entry.resetAt };
}

function isAhead(info) {
  const rule = settings.pace;
  return Boolean(rule?.enabled && info && info.surplus >= rule.surplus && (info.shortLeft === null || info.shortLeft >= 10));
}

function paceFor(model) {
  const bucket = quotaBucket(model);
  return bucket ? paceInfo(bucket) : null;
}

function fetchUsage(accountId) {
  const account = listAccounts().find((item) => item.id === accountId);
  if (!account) throw new Error("Account not found");
  if (account.provider === "claude") return fetchClaudeUsage(account);
  if (account.provider === "antigravity") return fetchGeminiUsage(account);
  if (account.provider === "kimi") throw new Error("Kimi does not expose usage limits.");
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
  return httpFetch("https://api.anthropic.com/api/oauth/usage", {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" }
  });
}

async function refreshClaudeTokens(filePath, auth) {
  if (!auth.refresh_token) throw new Error("No refresh token available");
  const response = await httpFetch("https://platform.claude.com/v1/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      grant_type: "refresh_token",
      refresh_token: auth.refresh_token
    }).toString()
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
  const response = await httpFetch(url, {
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
      usageWindow(codexWindowTitle(rateLimit.primary_window, "5-hour"), rateLimit.primary_window),
      usageWindow(codexWindowTitle(rateLimit.secondary_window, "Weekly"), rateLimit.secondary_window)
    ].filter(Boolean);
  }
  return [];
}

// Codex no longer always sends a 5-hour primary window (in Nov 2026 the
// primary window is the 7-day one), so the title comes from its length.
function codexWindowTitle(window, fallback) {
  const seconds = numberValue(window?.limit_window_seconds);
  if (typeof seconds !== "number" || seconds <= 0) return fallback;
  const hours = seconds / 3600;
  if (hours >= 24 * 28) return "Monthly";
  if (hours >= 24 * 6) return "Weekly";
  if (hours >= 24) return `${Math.round(hours / 24)}-day`;
  return `${Math.round(hours)}-hour`;
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
  const definitions = [...(settings.autoEnabled ? AUTO_FACTORY_MODELS : []), ...allModelDefinitions()];
  return definitions.map((modelDefinition, index) => {
    const entry = {
      model: modelDefinition.model,
      id: factoryModelId(modelDefinition.model),
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
    const baseModelId = baseModelIdFor(modelDefinition.model);
    if (baseModelId) entry.baseModelId = baseModelId;
    if (settings.enableThinking && modelDefinition.supportedReasoningEfforts.length) {
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
  // Wide enough for the multi-column layout, but never larger than the screen.
  const area = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: Math.min(1120, area.width - 80),
    height: Math.min(880, area.height - 60),
    minWidth: 420,
    minHeight: 640,
    title: APP_NAME,
    icon: taskbarIconPath(),
    backgroundColor: "#0b0e11",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Pinning the running window would otherwise pin the temp-folder copy of this
  // build, which keeps launching that stale build after updates.
  const portableExe = process.env.PORTABLE_EXECUTABLE_FILE;
  if (portableExe) {
    mainWindow.setAppDetails({
      appId: APP_USER_MODEL_ID,
      relaunchCommand: `"${portableExe}"`,
      relaunchDisplayName: APP_NAME,
      // The taskbar only accepts an exe icon resource here; an .ico file shows
      // up as a blank document. The portable exe embeds the app icon.
      appIconPath: portableExe,
      appIconIndex: 0
    });
  }

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  // Closing the window hides it to the tray so Factory keeps reaching the proxy;
  // only the tray's Quit item really exits.
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
    if (!trayHintShown && tray) {
      trayHintShown = true;
      tray.displayBalloon({ title: APP_NAME, content: "Still running in the tray. Right-click the icon to quit." });
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function showWindow() {
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// Window and tray icon. Windows caches icons by file path, so an icon update
// behind the same path can keep showing old artwork; name the file after its
// content. (The taskbar group's relaunch icon must be the exe, see setAppDetails.)
function taskbarIconPath() {
  const source = getResourcePath("icon.ico");
  try {
    const hash = crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex").slice(0, 12);
    const target = path.join(app.getPath("userData"), `icon-${hash}.ico`);
    if (!fs.existsSync(target)) fs.copyFileSync(source, target);
    return target;
  } catch {
    return source;
  }
}

function createTray() {
  tray = new Tray(taskbarIconPath());
  tray.setToolTip(APP_NAME);
  tray.on("click", showWindow);
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const { running } = proxyState();
  tray.setToolTip(`${APP_NAME} · ${running ? `running on ${settings.host}:${settings.port}` : "stopped"}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: running ? `Proxy running on ${settings.host}:${settings.port}` : "Proxy stopped", enabled: false },
    { type: "separator" },
    { label: "Open DroidProxy", click: showWindow },
    { label: "Quit", click: () => { isQuitting = true; app.quit(); } }
  ]));
}

// A second launch would kill this instance's backend and fail to bind the port.
const hasInstanceLock = app.requestSingleInstanceLock();
log(`App starting (single-instance lock ${hasInstanceLock ? "acquired" : "held by another instance, exiting"}; exe ${process.execPath})`);
if (!hasInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    log("Another launch detected; showing the existing window");
    showWindow();
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId(APP_USER_MODEL_ID);
    log(`Portable exe: ${process.env.PORTABLE_EXECUTABLE_FILE || "(not running from the portable exe)"}`);
    ensureDir(AUTH_DIR);
    // A leftover backend may be running from the runtime copy and lock it.
    await killOrphanedProxy();
    resourcesRoot = syncRuntimeResources();
    log(`Using resources from ${resourcesRoot}`);
    fixApiKeyRegions();
    writeConfig();
    createTray();
    createWindow();
    // Factory can't reach the custom models until the proxy is up, so start it right away.
    startProxy().catch((error) => log(`Auto-start failed: ${error.message}`));
    getManager().start();
    // The backend renews expired OAuth tokens only once it runs, so give it a
    // minute before the first quota read, and retry soon if a plan is missing.
    setTimeout(ensureApiKeysInConfig, 15 * 1000);
    setTimeout(async () => {
      const first = await refreshQuotaCache().catch(() => null);
      if (!first || first.failed > 0) setTimeout(() => refreshQuotaCache().catch(() => {}), 2 * 60 * 1000);
    }, 60 * 1000);
    setInterval(() => refreshQuotaCache().catch(() => {}), QUOTA_REFRESH_MS);
  });
}

app.on("before-quit", () => {
  isQuitting = true;
  stopProxy();
});

// Encrypted API keys never leave the main process.
const publicSettings = ({ apiProviders, ...rest }) => rest;
ipcMain.handle("settings:get", () => publicSettings(settings));
ipcMain.handle("settings:save", (_event, nextSettings) => {
  const { apiProviders, ...allowed } = nextSettings || {};
  return publicSettings(saveSettings(allowed));
});
ipcMain.handle("proxy:start", () => startProxy());
ipcMain.handle("proxy:stop", () => stopProxy());
ipcMain.handle("proxy:state", () => proxyState());
ipcMain.handle("logs:get", () => logs);
ipcMain.handle("auth:login", (_event, providerKey) => runLogin(providerKey));
ipcMain.handle("auth:accounts", () => listAccounts());
ipcMain.handle("usage:fetch", (_event, accountId) => fetchUsage(accountId));
ipcMain.handle("usage:api", () => apiUsage());
ipcMain.handle("factory:status", () => factoryStatus());
ipcMain.handle("factory:apply", () => applyFactoryModels());

function routingState() {
  const cooling = router
    ? [...router.cooldowns.entries()].filter(([, until]) => until > Date.now()).map(([model, until]) => ({ model, until: new Date(until).toISOString() }))
    : [];
  return {
    autoEnabled: settings.autoEnabled,
    fallbackEnabled: settings.fallbackEnabled,
    categories: Object.entries(CATEGORIES).map(([key, description]) => ({ key, description })),
    categoryModels: settings.categoryModels,
    roles: ROLES.map((key) => ({ key, label: ROLE_LABELS[key] })),
    roleModels: settings.roleModels,
    fallbackChains: settings.fallbackChains,
    defaults: {
      categoryModels: DEFAULT_CATEGORY_MODELS,
      roleModels: DEFAULT_ROLE_MODELS,
      fallbackChains: DEFAULT_CHAINS,
      overflowModels: DEFAULT_OVERFLOW_MODELS,
      missionOverflowModels: DEFAULT_MISSION_OVERFLOW_MODELS
    },
    balanced: settings.balanced,
    overflowThreshold: settings.overflowThreshold,
    overflowModels: settings.overflowModels,
    missionOverflowModels: settings.missionOverflowModels,
    premium: settings.premium,
    pace: settings.pace,
    quotas: {
      ...quotaCache,
      pace: Object.fromEntries(Object.keys(quotaCache.buckets || {}).map((bucket) => {
        const info = paceInfo(bucket);
        return [bucket, info && { ...info, ahead: isAhead(info) }];
      }).filter(([, info]) => info))
    },
    models: modelOptions(),
    cooling
  };
}

const getPath = (object, keys) => keys.reduce((value, key) => (value && typeof value === "object" ? value[key] : undefined), object);
function setPath(object, keys, value) {
  let target = object;
  for (const key of keys.slice(0, -1)) {
    if (!target[key] || typeof target[key] !== "object") target[key] = {};
    target = target[key];
  }
  const last = keys[keys.length - 1];
  if (value === undefined) delete target[last];
  else target[last] = value;
}

function readFactorySettings() {
  try {
    return JSON.parse(fs.readFileSync(FACTORY_SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

// Current model per Factory mode. A DroidProxy ID that no longer exists (for
// example a renamed model) is flagged so the UI can offer a fix.
function factoryModesState() {
  const factorySettings = readFactorySettings();
  const known = new Map([...AUTO_FACTORY_MODELS, ...allModelDefinitions()].map((item) => [factoryModelId(item.model), item.model]));
  return {
    slots: FACTORY_MODE_SLOTS.map((slot) => {
      const current = getPath(factorySettings, slot.model);
      const isDroidProxy = typeof current === "string" && DROIDPROXY_MODEL_PREFIXES.some((prefix) => current.startsWith(prefix));
      return {
        key: slot.key,
        label: slot.label,
        recommended: slot.recommended,
        current: current || "",
        model: known.get(current) || "",
        missing: isDroidProxy && !known.has(current),
        external: Boolean(current) && !isDroidProxy,
        effort: getPath(factorySettings, slot.effort) || ""
      };
    }),
    models: [
      ...AUTO_FACTORY_MODELS.map((item) => ({ id: item.model, label: item.displayName.replace(/^DroidProxy: /, "") })),
      ...modelOptions()
    ],
    efforts: ALL_EFFORTS
  };
}

// `choices`: { [slotKey]: { model, effort } }; an empty model clears the key so
// Factory falls back to its default (inherit).
function applyFactoryModes(choices) {
  const usesAuto = Object.values(choices || {}).some((choice) => AUTO_FACTORY_MODELS.some((item) => item.model === choice?.model));
  if (usesAuto && !settings.autoEnabled) saveSettings({ autoEnabled: true });
  applyFactoryModels(); // backs up settings.json and makes sure the IDs exist
  const factorySettings = readFactorySettings();
  for (const slot of FACTORY_MODE_SLOTS) {
    const choice = choices?.[slot.key];
    if (!choice) continue;
    setPath(factorySettings, slot.model, choice.model ? factoryModelId(choice.model) : undefined);
    if (choice.effort !== undefined) setPath(factorySettings, slot.effort, choice.effort || undefined);
  }
  fs.writeFileSync(FACTORY_SETTINGS_PATH, JSON.stringify(factorySettings, null, 2).replaceAll("\\/", "/"));
  log(`Factory modes updated: ${Object.entries(choices || {}).map(([key, value]) => `${key}=${value.model || "default"}`).join(", ")}`);
  return factoryModesState();
}

function apiProviderState() {
  return Object.entries(API_PROVIDERS).map(([key, provider]) => {
    const configured = settings.apiProviders[key];
    return {
      key,
      label: provider.label,
      region: configured?.region || Object.keys(provider.regions)[0],
      regions: Object.entries(provider.regions).map(([regionKey, region]) => ({ key: regionKey, label: region.label, residency: region.residency })),
      models: providerModels(key, configured?.region).map((model) => model.displayName),
      configured: Boolean(configured && decryptSecret(configured.keyEnc))
    };
  });
}

ipcMain.handle("routing:get", () => routingState());
ipcMain.handle("routing:save", (_event, next) => {
  saveSettings({
    autoEnabled: next.autoEnabled,
    fallbackEnabled: next.fallbackEnabled,
    categoryModels: next.categoryModels,
    roleModels: next.roleModels,
    fallbackChains: next.fallbackChains,
    balanced: next.balanced,
    overflowThreshold: next.overflowThreshold,
    overflowModels: next.overflowModels,
    missionOverflowModels: next.missionOverflowModels,
    premium: next.premium,
    pace: next.pace
  });
  return routingState();
});
ipcMain.handle("modes:get", () => factoryModesState());
ipcMain.handle("modes:apply", (_event, choices) => applyFactoryModes(choices));
ipcMain.handle("apikeys:list", () => apiProviderState());
ipcMain.handle("apikeys:set", (_event, { provider, apiKey, region }) => {
  if (!API_PROVIDERS[provider]) throw new Error("Unknown provider");
  const current = settings.apiProviders[provider];
  const key = String(apiKey || "").trim();
  if (!key && !current) throw new Error("Enter an API key first.");
  const keyEnc = key ? encryptSecret(key) : current.keyEnc;
  const effectiveRegion = regionForKey(provider, key || decryptSecret(current.keyEnc), region);
  saveSettings({ apiProviders: { ...settings.apiProviders, [provider]: { region: effectiveRegion, keyEnc } } });
  log(`API key saved for ${API_PROVIDERS[provider].label} (${providerRegion(provider, effectiveRegion).label})`);
  return apiProviderState();
});

// Keys saved before region detection existed may sit on the wrong endpoint.
function fixApiKeyRegions() {
  for (const [provider, entry] of Object.entries(settings.apiProviders || {})) {
    const key = decryptSecret(entry.keyEnc);
    const region = key ? regionForKey(provider, key, entry.region) : entry.region;
    if (region === entry.region) continue;
    saveSettings({ apiProviders: { ...settings.apiProviders, [provider]: { ...entry, region } } });
    log(`Moved ${API_PROVIDERS[provider].label} key to ${providerRegion(provider, region).label} to match its key type`);
  }
}
ipcMain.handle("apikeys:clear", (_event, provider) => {
  const next = { ...settings.apiProviders };
  delete next[provider];
  saveSettings({ apiProviders: next });
  log(`API key removed for ${API_PROVIDERS[provider]?.label || provider}`);
  return apiProviderState();
});
// Voice and video generation with a Google Gemini API key (AI Studio). The
// Google AI Ultra sign-in does not cover these API models.
const MEDIA_DIR = path.join(app.getPath("documents"), "VeryCuteDroidProxy");
let media = null;
function getMedia() {
  if (!media) {
    media = createMedia({
      fetchImpl: httpFetch,
      getApiKey: () => (settings.googleMedia.keyEnc ? decryptSecret(settings.googleMedia.keyEnc) : ""),
      outputDir: MEDIA_DIR,
      log
    });
  }
  return media;
}

function mediaState() {
  return {
    configured: Boolean(settings.googleMedia.keyEnc && decryptSecret(settings.googleMedia.keyEnc)),
    ttsModels: TTS_MODELS,
    videoModels: VIDEO_MODELS,
    voices: VOICES,
    aspectRatios: ASPECT_RATIOS,
    resolutions: RESOLUTIONS,
    outputDir: MEDIA_DIR
  };
}

// Workstream manager: keeps enabled Factory Workstreams going unattended,
// gates merges and deploys, and improves its own prompt and lessons nightly.
let manager = null;
function getManager() {
  if (!manager) manager = createManager({ log });
  return manager;
}
function managerState() {
  return {
    ...getManager().state(),
    models: modelOptions().map((item) => ({ id: factoryModelId(item.id), label: item.label }))
  };
}
ipcMain.handle("manager:state", () => managerState());
ipcMain.handle("manager:save", (_event, next) => {
  getManager().saveConfig(next || {});
  return managerState();
});
ipcMain.handle("manager:install", () => {
  getManager().install();
  return managerState();
});
ipcMain.handle("manager:uninstall", () => {
  getManager().saveConfig({ enabled: false });
  getManager().uninstall();
  return managerState();
});
ipcMain.handle("manager:retro", async () => {
  const result = await getManager().retrospective("manual");
  return { result, state: managerState() };
});
ipcMain.handle("manager:openFolder", () => {
  ensureDir(getManager().folder);
  shell.openPath(getManager().folder);
});

ipcMain.handle("media:state", () => mediaState());
ipcMain.handle("media:setKey", (_event, apiKey) => {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("Enter an API key first.");
  saveSettings({ googleMedia: { keyEnc: encryptSecret(key) } });
  log("Google Gemini API key saved for voice and video");
  return mediaState();
});
ipcMain.handle("media:clearKey", () => {
  saveSettings({ googleMedia: {} });
  log("Google Gemini API key removed");
  return mediaState();
});
const withUrl = (result) => ({ ...result, url: pathToFileURL(result.file).href });
ipcMain.handle("media:speak", async (_event, options) => withUrl(await getMedia().speak(options || {})));
ipcMain.handle("media:video", async (_event, options) => withUrl(await getMedia().video(options || {})));
ipcMain.handle("media:openFolder", () => {
  ensureDir(MEDIA_DIR);
  shell.openPath(MEDIA_DIR);
});
// Veo with the Google AI Ultra plan: Veo is only offered in Flow and the
// Gemini app (no API for subscription credits), so the prompt is copied, the
// site opens in the default browser where the user is already signed in, and
// finished videos downloaded from there are collected into MEDIA_DIR.
const VEO_SITES = {
  flow: "https://labs.google/fx/tools/flow",
  gemini: "https://gemini.google.com/app"
};
const VEO_WATCH_MS = 3 * 60 * 60 * 1000;
const VEO_POLL_MS = 5000;
let veoWatch = null;

function sendToWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function veoWatchState() {
  return veoWatch ? { watching: true, until: veoWatch.until, collected: veoWatch.collected } : { watching: false, collected: 0 };
}

// New .mp4 files in Downloads are copied once their size has stopped changing
// (browsers write to a temporary name first, but stay safe on slow disks).
function pollVeoDownloads() {
  const watch = veoWatch;
  if (!watch) return;
  if (Date.now() > watch.until) {
    stopVeoWatch();
    return;
  }
  let names = [];
  try {
    names = fs.readdirSync(watch.dir).filter((name) => /\.mp4$/i.test(name));
  } catch (error) {
    log(`Veo: cannot read Downloads (${error.message})`);
    return;
  }
  for (const name of names) {
    if (watch.done.has(name)) continue;
    const source = path.join(watch.dir, name);
    let stat;
    try {
      stat = fs.statSync(source);
    } catch {
      continue;
    }
    if (stat.mtimeMs < watch.since) {
      watch.done.add(name);
      continue;
    }
    if (watch.sizes.get(name) !== stat.size || stat.size === 0) {
      watch.sizes.set(name, stat.size);
      continue;
    }
    watch.done.add(name);
    try {
      ensureDir(MEDIA_DIR);
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
      const target = path.join(MEDIA_DIR, `veo-${stamp}-${name.replace(/[^\w.-]+/g, "_")}`);
      fs.copyFileSync(source, target);
      watch.collected += 1;
      log(`Veo: collected ${name} -> ${target}`);
      sendToWindow("media:collected", { file: target, url: pathToFileURL(target).href, name, state: veoWatchState() });
    } catch (error) {
      log(`Veo: could not copy ${name} (${error.message})`);
    }
  }
}

function startVeoWatch() {
  const now = Date.now();
  if (veoWatch) {
    veoWatch.until = now + VEO_WATCH_MS;
  } else {
    veoWatch = { dir: app.getPath("downloads"), since: now, until: now + VEO_WATCH_MS, done: new Set(), sizes: new Map(), collected: 0 };
    veoWatch.timer = setInterval(pollVeoDownloads, VEO_POLL_MS);
    log(`Veo: watching ${veoWatch.dir} for new videos`);
  }
  return veoWatchState();
}

function stopVeoWatch() {
  if (!veoWatch) return veoWatchState();
  clearInterval(veoWatch.timer);
  log(`Veo: stopped watching Downloads (${veoWatch.collected} collected)`);
  veoWatch = null;
  const state = veoWatchState();
  sendToWindow("media:veoState", state);
  return state;
}

ipcMain.handle("media:openVeo", (_event, { site = "flow", prompt = "" } = {}) => {
  const url = VEO_SITES[site] || VEO_SITES.flow;
  if (String(prompt).trim()) clipboard.writeText(String(prompt).trim());
  shell.openExternal(url);
  return startVeoWatch();
});
ipcMain.handle("media:veoState", () => veoWatchState());
ipcMain.handle("media:stopVeo", () => stopVeoWatch());

ipcMain.handle("media:showFile", (_event, file) => {
  const resolved = path.resolve(String(file || ""));
  if (path.dirname(resolved) === MEDIA_DIR && fs.existsSync(resolved)) shell.showItemInFolder(resolved);
});

ipcMain.handle("paths:openAuth", () => {
  ensureDir(AUTH_DIR);
  shell.openPath(AUTH_DIR);
});
ipcMain.handle("paths:openFactory", () => {
  ensureDir(path.dirname(FACTORY_SETTINGS_PATH));
  shell.openPath(path.dirname(FACTORY_SETTINGS_PATH));
});
