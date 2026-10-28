// API-key providers served through CLIProxyAPI's openai-compatibility upstreams.
// Endpoints and model IDs are from each provider's docs as of Oct 2026. Every
// provider gets a prefix so its models ("deepseek/deepseek-v4-pro") can never
// collide with the OAuth subscription models.

const REASONING = ["low", "high", "max"];

const API_PROVIDERS = {
  deepseek: {
    label: "DeepSeek",
    regions: { international: { label: "Default", baseUrl: "https://api.deepseek.com", residency: "China" } },
    models: [
      { name: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro", maxContextLimit: 1000000, maxOutputTokens: 128000, efforts: REASONING },
      { name: "deepseek-flash", displayName: "DeepSeek V4.1 Flash", maxContextLimit: 1000000, maxOutputTokens: 128000, efforts: REASONING }
    ]
  },
  moonshot: {
    label: "Kimi API (Moonshot)",
    regions: {
      international: { label: "International", baseUrl: "https://api.moonshot.ai/v1", residency: "Singapore" },
      china: { label: "China", baseUrl: "https://api.moonshot.cn/v1", residency: "China" }
    },
    models: [
      { name: "kimi-k3.1-pro", displayName: "Kimi K3.1 Pro", maxContextLimit: 1048576, maxOutputTokens: 65536, efforts: REASONING },
      { name: "kimi-k3", displayName: "Kimi K3 (API)", maxContextLimit: 1048576, maxOutputTokens: 65536, efforts: REASONING }
    ]
  },
  zai: {
    label: "GLM (Z.ai)",
    regions: {
      international: { label: "International", baseUrl: "https://api.z.ai/api/paas/v4", residency: "Singapore" },
      codingplan: { label: "GLM Coding Plan", baseUrl: "https://api.z.ai/api/coding/paas/v4", residency: "Singapore" },
      china: { label: "China", baseUrl: "https://open.bigmodel.cn/api/paas/v4", residency: "China" }
    },
    models: [
      { name: "glm-5.3", displayName: "GLM-5.3", maxContextLimit: 1000000, maxOutputTokens: 128000, efforts: REASONING }
    ]
  },
  qwen: {
    label: "Qwen Cloud",
    // Token Plan keys (sk-sp-) only work on the Token Plan host; pay-as-you-go
    // keys (sk-ws-/sk-) use the region hosts. A region may list its own models.
    regions: {
      tokenplan: {
        label: "Token Plan (sk-sp- keys)",
        baseUrl: "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1",
        residency: "Singapore",
        models: [
          { name: "qwen3.8-max", displayName: "Qwen3.8 Max", maxContextLimit: 991808, maxOutputTokens: 131072, efforts: ["high"] },
          { name: "qwen3.8-flash", displayName: "Qwen3.8 Flash", maxContextLimit: 1000000, maxOutputTokens: 65536, efforts: ["high"] },
          { name: "glm-5.3", displayName: "GLM-5.3 (Qwen Token Plan)", maxContextLimit: 1000000, maxOutputTokens: 128000, efforts: REASONING },
          { name: "deepseek-v4-pro", displayName: "DeepSeek V4 Pro (Qwen Token Plan)", maxContextLimit: 1000000, maxOutputTokens: 128000, efforts: REASONING }
        ]
      },
      singapore: { label: "Pay-as-you-go · Singapore", baseUrl: "https://ap-southeast-1.maas.qwencloudapi.com/compatible-mode/v1", residency: "Singapore" },
      china: { label: "Pay-as-you-go · China (Beijing)", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", residency: "China" }
    },
    models: [
      { name: "qwen3.8-max", displayName: "Qwen3.8 Max", maxContextLimit: 991808, maxOutputTokens: 131072, efforts: ["high"] },
      { name: "qwen3.8-flash", displayName: "Qwen3.8 Flash", maxContextLimit: 1000000, maxOutputTokens: 65536, efforts: ["high"] }
    ]
  },
  minimax: {
    label: "MiniMax",
    regions: {
      international: { label: "International", baseUrl: "https://api.minimax.io/v1", residency: "Not confirmed" },
      china: { label: "China", baseUrl: "https://api.minimax.cn/v1", residency: "China" }
    },
    models: [
      { name: "MiniMax-M3.1-Flash", displayName: "MiniMax M3.1 Flash", maxContextLimit: 1000000, maxOutputTokens: 65536, efforts: ["low", "medium", "high", "xhigh", "max"] },
      { name: "MiniMax-M3", displayName: "MiniMax M3", maxContextLimit: 1000000, maxOutputTokens: 65536, efforts: ["high"] }
    ]
  },
  mistral: {
    label: "Mistral (EU)",
    regions: {
      eu: { label: "EU", baseUrl: "https://api.eu.mistral.ai/v1", residency: "EU" },
      global: { label: "Global", baseUrl: "https://api.mistral.ai/v1", residency: "Not region-bound" }
    },
    models: [
      { name: "mistral-medium-3-5", displayName: "Mistral Medium 3.5", maxContextLimit: 256000, maxOutputTokens: 32768, efforts: [] },
      { name: "codestral-2508", displayName: "Codestral", maxContextLimit: 128000, maxOutputTokens: 32768, efforts: [] }
    ]
  },
  openrouter: {
    label: "OpenRouter",
    regions: { global: { label: "Default", baseUrl: "https://openrouter.ai/api/v1", residency: "Depends on the model's host" } },
    models: [
      { name: "deepseek/deepseek-v4-pro", displayName: "DeepSeek V4 Pro (OpenRouter)", maxContextLimit: 1048576, maxOutputTokens: 128000, efforts: REASONING },
      { name: "moonshotai/kimi-k3.1-pro", displayName: "Kimi K3.1 Pro (OpenRouter)", maxContextLimit: 1048576, maxOutputTokens: 65536, efforts: REASONING },
      { name: "z-ai/glm-5.3", displayName: "GLM-5.3 (OpenRouter)", maxContextLimit: 1048576, maxOutputTokens: 128000, efforts: REASONING },
      { name: "qwen/qwen3.8-max-0902", displayName: "Qwen3.8 Max (OpenRouter)", maxContextLimit: 1000000, maxOutputTokens: 131072, efforts: ["high"] },
      { name: "minimax/minimax-m3.1-flash", displayName: "MiniMax M3.1 Flash (OpenRouter)", maxContextLimit: 1048576, maxOutputTokens: 65536, efforts: ["low", "medium", "high", "xhigh", "max"] },
      { name: "mistralai/mistral-medium-3-5", displayName: "Mistral Medium 3.5 (OpenRouter)", maxContextLimit: 262144, maxOutputTokens: 32768, efforts: [] }
    ]
  }
};

// Client-facing model ID routed by CLIProxyAPI's provider prefix.
function apiModelId(providerKey, modelName) {
  return `${providerKey}/${modelName}`;
}

function providerRegion(providerKey, regionKey) {
  const provider = API_PROVIDERS[providerKey];
  if (!provider) return null;
  return provider.regions[regionKey] || Object.values(provider.regions)[0];
}

function providerModels(providerKey, regionKey) {
  return providerRegion(providerKey, regionKey)?.models || API_PROVIDERS[providerKey].models;
}

// Picks the region a key belongs to when its prefix makes that unambiguous.
function regionForKey(providerKey, apiKey, regionKey) {
  if (providerKey === "qwen" && /^sk-sp-/.test(apiKey)) return "tokenplan";
  if (providerKey === "qwen" && regionKey === "tokenplan" && /^sk-/.test(apiKey)) return "singapore";
  return regionKey;
}

// YAML for the v8 `api-keys:` section. JSON strings are valid YAML scalars,
// so every value is emitted with JSON.stringify to keep keys safely quoted.
function apiKeysYaml(configured) {
  const groups = Object.entries(configured)
    .filter(([key, value]) => API_PROVIDERS[key] && value.apiKey)
    .map(([key, value]) => {
      const region = providerRegion(key, value.region);
      const models = providerModels(key, value.region).map((model) => {
        const lines = [
          `        - name: ${JSON.stringify(model.name)}`,
          `          alias: ${JSON.stringify(model.name)}`,
          `          display-name: ${JSON.stringify(model.displayName)}`
        ];
        if (model.efforts.length) {
          lines.push(`          thinking:`, `            levels: ${JSON.stringify(model.efforts)}`);
        }
        return lines.join("\n");
      }).join("\n");
      return [
        `    - name: ${JSON.stringify(key)}`,
        `      prefix: ${JSON.stringify(key)}`,
        `      base-url: ${JSON.stringify(region.baseUrl)}`,
        `      keys:`,
        `        - api-key: ${JSON.stringify(value.apiKey)}`,
        `      models:`,
        models
      ].join("\n");
    });
  if (!groups.length) return "";
  return `\n# API-key providers configured in DroidProxy\napi-keys:\n  openai-compatibility:\n${groups.join("\n")}\n`;
}

module.exports = { API_PROVIDERS, apiModelId, providerRegion, providerModels, regionForKey, apiKeysYaml };
