const test = require("node:test");
const assert = require("node:assert/strict");

const { mergeCustomModels, isInstalled } = require("../src/factory-sync");

const OWNED = ["custom:droidproxy:", "custom:CC:"];
const entry = (model) => ({ id: `custom:droidproxy:${model.replaceAll("/", "-")}`, model, displayName: model });
const ids = (models) => models.map((model) => model.id);

const USER_MODEL = { id: "custom:mine", model: "my-own-model" };
const SUBSCRIPTION = [entry("claude-fable-5-2"), entry("gpt-6-astra")];
const DEEPSEEK = entry("deepseek/deepseek-v4-pro");
const QWEN = entry("qwen/qwen3.8-max");

test("a sync replaces DroidProxy's models and keeps the user's own", () => {
  const merged = mergeCustomModels([USER_MODEL, entry("gpt-5-old")], SUBSCRIPTION, { ownedPrefixes: OWNED });
  assert.deepEqual(ids(merged), ["custom:mine", "custom:droidproxy:claude-fable-5-2", "custom:droidproxy:gpt-6-astra"]);
  assert.deepEqual(merged.map((model) => model.index), [undefined, 1, 2]);
});

test("a sync keeps API-key models whose saved key cannot be read", () => {
  const merged = mergeCustomModels([USER_MODEL, ...SUBSCRIPTION, DEEPSEEK, QWEN], SUBSCRIPTION, { ownedPrefixes: OWNED, unreadableProviders: ["deepseek", "qwen"] });
  assert.deepEqual(ids(merged), ["custom:mine", "custom:droidproxy:claude-fable-5-2", "custom:droidproxy:gpt-6-astra", DEEPSEEK.id, QWEN.id]);
  assert.deepEqual(merged.slice(1).map((model) => model.index), [1, 2, 3, 4]);
});

test("a sync removes API-key models once the user removes the provider", () => {
  const merged = mergeCustomModels([...SUBSCRIPTION, DEEPSEEK, QWEN], SUBSCRIPTION, { ownedPrefixes: OWNED, unreadableProviders: ["deepseek"] });
  assert.deepEqual(ids(merged), ["custom:droidproxy:claude-fable-5-2", "custom:droidproxy:gpt-6-astra", DEEPSEEK.id]);
});

test("a kept model is not duplicated when its key is readable again", () => {
  const merged = mergeCustomModels([...SUBSCRIPTION, DEEPSEEK], [...SUBSCRIPTION, DEEPSEEK], { ownedPrefixes: OWNED, unreadableProviders: ["deepseek"] });
  assert.deepEqual(ids(merged), ["custom:droidproxy:claude-fable-5-2", "custom:droidproxy:gpt-6-astra", DEEPSEEK.id]);
});

test("Factory counts as applied while kept models wait for their key", () => {
  const installed = [USER_MODEL, ...SUBSCRIPTION, DEEPSEEK];
  assert.equal(isInstalled(installed, ids(SUBSCRIPTION), { ownedPrefixes: OWNED, unreadableProviders: ["deepseek"] }), true);
  assert.equal(isInstalled(installed, ids(SUBSCRIPTION), { ownedPrefixes: OWNED }), false);
  assert.equal(isInstalled([USER_MODEL, SUBSCRIPTION[0]], ids(SUBSCRIPTION), { ownedPrefixes: OWNED }), false);
  assert.equal(isInstalled([USER_MODEL], [], { ownedPrefixes: OWNED }), false);
});
