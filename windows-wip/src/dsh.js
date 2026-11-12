// DeepSeek Harness (dsh) integration: writes DroidProxy's models into the
// harness's pi-ai provider routes (~/.dsh/profiles/<profile>/cordis.patch.yml),
// the same way "Apply" writes Factory's custom models.
//
// Routes go through DroidProxy's front proxy (not the raw backend port) so dsh
// gets Auto routing, cross-provider fallback, pace routing, reasoning-level
// fixes and usage tracking. Each model family uses its native protocol:
// Claude and the Auto models speak Anthropic Messages, GPT speaks OpenAI
// Responses, everything else Chat Completions.

const fs = require("fs");
const os = require("os");
const path = require("path");
const YAML = require("yaml");

const PLUGIN_NAME = "@deepseek-ai/dsh-llm-pi-ai";
const ENTRY_ID = "llm-pi-ai";
const LEGACY_PROVIDER = "droidproxy";
const DEFAULT_KEY_REF = "DROIDPROXY_API_KEY";
const ROUTES = {
  "droidproxy-claude": { api: "anthropic-messages", suffix: "", label: "VeryCuteDroidProxy · Claude & Auto" },
  "droidproxy-openai": { api: "openai-responses", suffix: "/v1", label: "VeryCuteDroidProxy · GPT" },
  "droidproxy-compat": { api: "openai-completions", suffix: "/v1", label: "VeryCuteDroidProxy · Gemini, Kimi & API keys" }
};
const MARKER = " VeryCuteDroidProxy: written by the app (Apply to DeepSeek Harness). Edit models in DroidProxy, not here.";
// Auto can land on GPT (272k context), so dsh compacts Auto sessions early.
const AUTO_CONTEXT = 272000;
const DEFAULT_CONTEXT = { claude: 1000000, gemini: 900000, other: 1000000 };

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

function routeFor(model) {
  if (model.provider === "anthropic") return "droidproxy-claude";
  if (/^gpt-/.test(model.model)) return "droidproxy-openai";
  return "droidproxy-compat";
}

function contextFor(model) {
  if (/^droidproxy-auto/.test(model.model)) return AUTO_CONTEXT;
  if (model.maxContextLimit) return model.maxContextLimit;
  if (/^(claude-|ag-)/.test(model.model)) return DEFAULT_CONTEXT.claude;
  if (/^gemini-/.test(model.model)) return DEFAULT_CONTEXT.gemini;
  return DEFAULT_CONTEXT.other;
}

function modelEntry(model) {
  const efforts = Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [];
  const entry = {
    id: model.model,
    name: String(model.displayName || model.model).replace(/^DroidProxy:\s*/, ""),
    contextWindow: contextFor(model),
    maxTokens: model.maxOutputTokens || 64000
  };
  entry.reasoningEfforts = efforts.length ? Object.fromEntries(efforts.map((level) => [level, level])) : false;
  return entry;
}

// `models` are Factory model entries (factoryModels()); `origin` is the
// DroidProxy front proxy, e.g. http://127.0.0.1:8317.
function buildProviders(models, origin, keyRef = DEFAULT_KEY_REF) {
  const providers = {};
  for (const [key, route] of Object.entries(ROUTES)) {
    const list = models.filter((model) => routeFor(model) === key).map(modelEntry);
    if (!list.length) continue;
    providers[key] = { displayName: route.label, apiKeyEnv: keyRef, api: route.api, baseURL: `${origin}${route.suffix}`, models: list };
  }
  return providers;
}

function profiles(home = dshHome()) {
  try {
    return fs.readdirSync(path.join(home, "profiles"), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function patchFile(profile, home = dshHome()) {
  return path.join(home, "profiles", profile, "cordis.patch.yml");
}

function findEntry(doc) {
  const items = doc.contents && YAML.isSeq(doc.contents) ? doc.contents.items : [];
  return items.find((item) => YAML.isMap(item) && (item.get("id") === ENTRY_ID || item.get("name") === PLUGIN_NAME)) || null;
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
}

// Rewrites only DroidProxy's routes inside the pi-ai entry; every other patch
// entry, provider and comment in the file is kept.
function applyToProfile(profile, models, origin, home = dshHome()) {
  const file = patchFile(profile, home);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const doc = existing.trim() ? YAML.parseDocument(existing) : new YAML.Document([]);
  if (doc.errors.length) throw new Error(`${profile}/cordis.patch.yml has YAML errors (${doc.errors[0].message}); left unchanged.`);
  if (!doc.contents || !YAML.isSeq(doc.contents)) {
    if (doc.contents && !(YAML.isScalar(doc.contents) && doc.contents.value == null)) throw new Error(`${profile}/cordis.patch.yml is not a list of patch entries; left unchanged.`);
    doc.contents = doc.createNode([]);
  }
  let entry = findEntry(doc);
  if (!entry) {
    entry = doc.createNode({ id: ENTRY_ID, name: PLUGIN_NAME, config: { providers: {} } });
    doc.contents.add(entry);
  }
  let providersNode = entry.getIn(["config", "providers"], true);
  if (!YAML.isMap(providersNode)) {
    entry.setIn(["config", "providers"], doc.createNode({}));
    providersNode = entry.getIn(["config", "providers"], true);
  }
  const legacy = providersNode.get(LEGACY_PROVIDER, true);
  const keyRef = (YAML.isMap(legacy) && legacy.get("apiKeyEnv")) || (YAML.isMap(providersNode.get("droidproxy-claude", true)) && providersNode.getIn(["droidproxy-claude", "apiKeyEnv"])) || DEFAULT_KEY_REF;
  // The old single route pointed at the raw backend port; replace it.
  if (YAML.isMap(legacy) && /127\.0\.0\.1|localhost/.test(String(legacy.get("baseURL") || ""))) providersNode.delete(LEGACY_PROVIDER);
  for (const key of Object.keys(ROUTES)) providersNode.delete(key);
  const providers = buildProviders(models, origin, keyRef);
  for (const [key, value] of Object.entries(providers)) providersNode.set(key, doc.createNode(value));
  entry.commentBefore = MARKER;
  const text = doc.toString({ lineWidth: 0 });
  if (text === existing) return { profile, changed: false, models: models.length };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (existing) fs.copyFileSync(file, `${file}.droidproxy-${stamp()}.bak`);
  fs.writeFileSync(file, text);
  return { profile, changed: true, models: Object.values(providers).reduce((sum, provider) => sum + provider.models.length, 0) };
}

function apply(models, origin, home = dshHome()) {
  const names = profiles(home);
  if (!names.length) throw new Error("DeepSeek Harness profiles were not found. Open DeepSeek Harness once, then try again.");
  return names.map((profile) => applyToProfile(profile, models, origin, home));
}

function state(origin, home = dshHome()) {
  const names = profiles(home);
  const result = { installed: names.length > 0, home, profiles: [] };
  for (const profile of names) {
    let routes = [];
    let legacy = null;
    try {
      const doc = YAML.parseDocument(fs.readFileSync(patchFile(profile, home), "utf8"));
      const entry = findEntry(doc);
      const providers = entry && entry.getIn(["config", "providers"], true);
      if (YAML.isMap(providers)) {
        routes = Object.keys(ROUTES).filter((key) => YAML.isMap(providers.get(key, true))).map((key) => ({ key, baseURL: providers.getIn([key, "baseURL"]), models: (providers.getIn([key, "models"], true)?.items || []).length }));
        const old = providers.get(LEGACY_PROVIDER, true);
        if (YAML.isMap(old)) legacy = String(old.get("baseURL") || "");
      }
    } catch {
      // missing or unreadable patch file
    }
    const current = routes.length > 0 && routes.every((route) => String(route.baseURL || "").startsWith(origin));
    result.profiles.push({ profile, routes, legacy, current });
  }
  result.applied = result.profiles.length > 0 && result.profiles.every((item) => item.current);
  return result;
}

module.exports = { apply, applyToProfile, state, buildProviders, routeFor, modelEntry, dshHome, ROUTES };
