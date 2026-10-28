const fs = require("fs");

// Token usage for pay-per-token API models, counted from the `usage` objects in
// responses that pass through the front proxy. Qwen Cloud has no usage API for
// API keys, so this is the only programmatic source; it covers DroidProxy
// traffic only.

const MAX_CAPTURE = 4 * 1024 * 1024;
const QUOTA_ERRORS = /AllocationQuota\.FreeTierOnly|insufficient_quota|token-plan quota has been exhausted|exceeded your current quota|Insufficient Balance/i;

function tokensFrom(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const output = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  return input || output ? { input, output } : null;
}

// Last usage in a JSON body or an SSE stream. Anthropic-style streams split it
// across message_start (input) and message_delta (output).
function extractUsage(text) {
  try {
    const whole = tokensFrom(JSON.parse(text).usage);
    if (whole) return whole;
  } catch {
    // not a single JSON document; try SSE lines
  }
  let found = null;
  let anthropicInput = 0;
  let anthropicOutput = 0;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:") || !line.includes("usage")) continue;
    try {
      const event = JSON.parse(line.slice(5).trim());
      if (event.type === "message_start") anthropicInput = Number(event.message?.usage?.input_tokens) || anthropicInput;
      else if (event.type === "message_delta") anthropicOutput = Number(event.usage?.output_tokens) || anthropicOutput;
      else found = tokensFrom(event.usage || event.response?.usage) || found;
    } catch {
      // partial or non-JSON line
    }
  }
  if (anthropicInput || anthropicOutput) return { input: anthropicInput, output: anthropicOutput };
  return found;
}

function createUsageTracker({ filePath, log, tracks }) {
  let data = { models: {} };
  try {
    data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!data.models) data.models = {};
  } catch {
    // first run
  }

  let saveTimer = null;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      } catch (error) {
        log(`Could not save API usage: ${error.message}`);
      }
    }, 1000);
  };

  function entry(model) {
    if (!data.models[model]) data.models[model] = { input: 0, output: 0, requests: 0, since: new Date().toISOString(), lastUsed: null, quotaError: null };
    return data.models[model];
  }

  function record(model, tokens) {
    const item = entry(model);
    item.input += tokens.input;
    item.output += tokens.output;
    item.requests += 1;
    item.lastUsed = new Date().toISOString();
    item.quotaError = null;
    save();
  }

  function recordQuotaError(model, message) {
    entry(model).quotaError = { at: new Date().toISOString(), message: message.slice(0, 200) };
    save();
  }

  // Watches one upstream response without changing what the client receives.
  function observe(model, upstreamRes) {
    if (!tracks(model)) return;
    const chunks = [];
    let size = 0;
    upstreamRes.on("data", (chunk) => {
      if (size > MAX_CAPTURE) return;
      chunks.push(chunk);
      size += chunk.length;
    });
    upstreamRes.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (upstreamRes.statusCode >= 400) {
        const match = text.match(QUOTA_ERRORS);
        if (match) recordQuotaError(model, match[0]);
        return;
      }
      const tokens = extractUsage(text);
      if (tokens) record(model, tokens);
    });
  }

  return { tracks, observe, summary: () => data.models };
}

module.exports = { createUsageTracker, extractUsage };
