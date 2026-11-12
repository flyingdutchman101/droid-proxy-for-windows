const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const YAML = require("yaml");

const dsh = require("../src/dsh");

const ORIGIN = "http://127.0.0.1:8317";

const factoryModel = (model, extra = {}) => ({
  model,
  displayName: `DroidProxy: ${model}`,
  provider: /^claude-/.test(model) ? "anthropic" : "generic-chat-completion-api",
  maxOutputTokens: 128000,
  noImageSupport: false,
  supportedReasoningEfforts: ["high"],
  ...extra
});

const SUBSCRIPTION = [factoryModel("claude-fable-5-2"), factoryModel("gpt-6-astra"), factoryModel("gemini-4-carbon-high")];
const API_KEY = [factoryModel("deepseek/deepseek-v4-pro"), factoryModel("qwen/qwen3.8-max")];

function tempHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vcdp-dsh-"));
  fs.mkdirSync(path.join(home, "profiles", "desktop"), { recursive: true });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function readModels(home) {
  const doc = YAML.parse(fs.readFileSync(path.join(home, "profiles", "desktop", "cordis.patch.yml"), "utf8"));
  const providers = doc.find((item) => item.id === "llm-pi-ai").config.providers;
  return Object.fromEntries(Object.entries(providers).map(([key, route]) => [key, route.models]));
}

const ids = (models) => models.map((model) => model.id);

test("a sync declares image input on every model", (t) => {
  const home = tempHome(t);
  dsh.apply([...SUBSCRIPTION, ...API_KEY], ORIGIN, home);
  const routes = readModels(home);
  for (const model of Object.values(routes).flat()) {
    assert.deepEqual(model.input, ["text", "image"], `${model.id} should accept images`);
  }
});

test("a model marked as having no image support is declared text-only", (t) => {
  const home = tempHome(t);
  dsh.apply([factoryModel("gemini-4-carbon-high", { noImageSupport: true })], ORIGIN, home);
  assert.deepEqual(readModels(home)["droidproxy-compat"][0].input, ["text"]);
});

test("a sync keeps fields the user added to a model in DeepSeek Harness", (t) => {
  const home = tempHome(t);
  dsh.apply(SUBSCRIPTION, ORIGIN, home);
  const file = path.join(home, "profiles", "desktop", "cordis.patch.yml");
  const doc = YAML.parse(fs.readFileSync(file, "utf8"));
  const gemini = doc.find((item) => item.id === "llm-pi-ai").config.providers["droidproxy-compat"].models[0];
  gemini.input = ["text"];
  gemini.compat = { supportsDeveloperRole: false };
  fs.writeFileSync(file, YAML.stringify(doc));

  dsh.apply(SUBSCRIPTION, ORIGIN, home);

  const after = readModels(home)["droidproxy-compat"][0];
  assert.deepEqual(after.input, ["text"]);
  assert.deepEqual(after.compat, { supportsDeveloperRole: false });
});

test("a sync keeps API-key models whose saved key cannot be read", (t) => {
  const home = tempHome(t);
  dsh.apply([...SUBSCRIPTION, ...API_KEY], ORIGIN, home);
  assert.deepEqual(ids(readModels(home)["droidproxy-compat"]), ["gemini-4-carbon-high", "deepseek/deepseek-v4-pro", "qwen/qwen3.8-max"]);

  // The keys failed to decrypt, so the model list no longer contains them.
  const results = dsh.apply(SUBSCRIPTION, ORIGIN, home, { keepModelPrefixes: ["deepseek", "qwen"] });

  assert.deepEqual(ids(readModels(home)["droidproxy-compat"]), ["gemini-4-carbon-high", "deepseek/deepseek-v4-pro", "qwen/qwen3.8-max"]);
  assert.deepEqual(results[0].kept, ["deepseek/deepseek-v4-pro", "qwen/qwen3.8-max"]);
});

test("a sync keeps the route alive when only unreadable API-key models remain on it", (t) => {
  const home = tempHome(t);
  dsh.apply([factoryModel("claude-fable-5-2"), ...API_KEY], ORIGIN, home);
  dsh.apply([factoryModel("claude-fable-5-2")], ORIGIN, home, { keepModelPrefixes: ["deepseek", "qwen"] });
  const routes = readModels(home);
  assert.deepEqual(ids(routes["droidproxy-compat"]), ["deepseek/deepseek-v4-pro", "qwen/qwen3.8-max"]);
  assert.equal(dsh.state(ORIGIN, home).applied, true);
});

test("a sync still removes API-key models once the user removes the provider", (t) => {
  const home = tempHome(t);
  dsh.apply([...SUBSCRIPTION, ...API_KEY], ORIGIN, home);
  // Qwen was removed in the app; DeepSeek's key is unreadable.
  dsh.apply(SUBSCRIPTION, ORIGIN, home, { keepModelPrefixes: ["deepseek"] });
  assert.deepEqual(ids(readModels(home)["droidproxy-compat"]), ["gemini-4-carbon-high", "deepseek/deepseek-v4-pro"]);
});

test("a second identical sync changes nothing and writes no backup", (t) => {
  const home = tempHome(t);
  dsh.apply([...SUBSCRIPTION, ...API_KEY], ORIGIN, home);
  const results = dsh.apply([...SUBSCRIPTION, ...API_KEY], ORIGIN, home);
  assert.equal(results[0].changed, false);
  const backups = fs.readdirSync(path.join(home, "profiles", "desktop")).filter((name) => name.endsWith(".bak"));
  assert.equal(backups.length, 0);
});

test("a sync leaves other providers and patch entries alone", (t) => {
  const home = tempHome(t);
  const file = path.join(home, "profiles", "desktop", "cordis.patch.yml");
  fs.writeFileSync(file, [
    "- id: ui-chat",
    "  config:",
    "    transcriptView: standard",
    "- id: llm-pi-ai",
    "  name: \"@deepseek-ai/dsh-llm-pi-ai\"",
    "  config:",
    "    providers:",
    "      my-gateway:",
    "        api: openai-completions",
    "        baseURL: https://gateway.example/v1",
    "        models:",
    "          - id: my-model",
    ""
  ].join("\n"));
  dsh.apply(SUBSCRIPTION, ORIGIN, home);
  const doc = YAML.parse(fs.readFileSync(file, "utf8"));
  assert.equal(doc[0].config.transcriptView, "standard");
  assert.deepEqual(doc[1].config.providers["my-gateway"].models, [{ id: "my-model" }]);
});
