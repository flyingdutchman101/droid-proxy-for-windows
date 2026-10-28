const http = require("http");
const { isAutoModel, FALLBACK_STATUSES } = require("./router");

// Front proxy that sits between Factory and cli-proxy-api, mirroring the Claude
// request fixes the macOS ThinkingProxy applies:
// - Anthropic-Beta: always strip `fast-mode-*`; on thinking requests drop
//   `redact-thinking-2026-02-12` and add the visible-thinking betas.
// - Strip stale assistant thinking blocks that Anthropic rejects on replay.
// Everything else is forwarded unchanged.

const REDACTED_THINKING_BETA = "redact-thinking-2026-02-12";
const VISIBLE_THINKING_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "structured-outputs-2025-12-15",
  "token-efficient-tools-2026-03-28"
];
const THINKING_TYPES = new Set(["thinking", "redacted_thinking"]);
const EMPTY_CONTENT_PLACEHOLDER = [{ type: "text", text: "..." }];
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer"]);

function isClaudeModel(model) {
  return typeof model === "string" && (model.startsWith("claude-") || model.startsWith("gemini-claude-"));
}

function isFastModeBeta(beta) {
  return beta.trim().toLowerCase().startsWith("fast-mode-");
}

function rewriteAnthropicBeta(headers, visibleThinking) {
  const raw = headers["anthropic-beta"];
  const current = (Array.isArray(raw) ? raw.join(",") : raw || "").split(",").map((beta) => beta.trim()).filter(Boolean);
  const candidates = visibleThinking ? [...current, ...VISIBLE_THINKING_BETAS] : current;
  const seen = new Set();
  const kept = candidates.filter((beta) => {
    const normalized = beta.toLowerCase();
    if (isFastModeBeta(beta) || seen.has(normalized)) return false;
    if (visibleThinking && normalized === REDACTED_THINKING_BETA) return false;
    seen.add(normalized);
    return true;
  });

  delete headers["anthropic-beta"];
  if (kept.length) headers["anthropic-beta"] = kept.join(",");
}

function blockTypes(content) {
  return Array.isArray(content) ? content.map((block) => block?.type) : [];
}

function isToolResultTurn(message) {
  return message?.role === "user" && blockTypes(message.content).includes("tool_result");
}

// Two or more thinking blocks all placed before the first tool_use: Droid squashed
// several steps into one turn, and Anthropic rejects the reordered signed thinking.
function isClusteredThinkingMerge(content) {
  const types = blockTypes(content);
  const thinkingIndexes = types.map((type, index) => (THINKING_TYPES.has(type) ? index : -1)).filter((index) => index >= 0);
  const firstToolUse = types.indexOf("tool_use");
  return thinkingIndexes.length >= 2 && firstToolUse !== -1 && thinkingIndexes[thinkingIndexes.length - 1] < firstToolUse;
}

// Keeps thinking only on the latest assistant turn that is followed solely by
// tool results (Anthropic requires it there); strips it from every older turn.
function sanitizeThinkingBlocks(body) {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return false;

  let index = messages.length - 1;
  while (index >= 0 && isToolResultTurn(messages[index])) index -= 1;
  let preserveIndex = index < messages.length - 1 && index >= 0 && messages[index]?.role === "assistant" ? index : -1;
  if (preserveIndex >= 0 && isClusteredThinkingMerge(messages[preserveIndex].content)) preserveIndex = -1;

  let changed = false;
  messages.forEach((message, messageIndex) => {
    if (message?.role !== "assistant" || messageIndex === preserveIndex || !Array.isArray(message.content)) return;
    const kept = message.content.filter((block) => !THINKING_TYPES.has(block?.type));
    if (kept.length === message.content.length) return;
    message.content = kept.length ? kept : EMPTY_CONTENT_PLACEHOLDER;
    changed = true;
  });
  return changed;
}

// Factory-facing aliases for Claude served through Antigravity (Google AI
// Pro/Ultra), kept distinct from the Claude-subscription model IDs.
const ANTIGRAVITY_MODEL_ALIASES = {
  "ag-c55o-high": "claude-opus-5-5-high",
  "ag-c55s-high": "claude-sonnet-5-5-high"
};

// Builds the upstream body for one attempt. `raw` is reused untouched when
// nothing changes so Anthropic prompt-cache key ordering is preserved.
function prepareBody(headers, raw, model, { includeUsage = false } = {}) {
  const body = JSON.parse(raw.toString("utf8"));
  let changed = body.model !== model;
  body.model = ANTIGRAVITY_MODEL_ALIASES[model] || model;
  changed = changed || body.model !== model;

  // Streamed Chat Completions only report token usage when asked.
  if (includeUsage && body.stream === true && Array.isArray(body.messages) && !body.stream_options?.include_usage) {
    body.stream_options = { ...(body.stream_options || {}), include_usage: true };
    changed = true;
  }

  if (isClaudeModel(body.model)) {
    const visibleThinking = ["enabled", "adaptive", "auto"].includes(body.thinking?.type);
    rewriteAnthropicBeta(headers, visibleThinking);
    changed = sanitizeThinkingBlocks(body) || changed;
  }
  return changed ? Buffer.from(JSON.stringify(body), "utf8") : raw;
}

function sendUpstream({ targetHost, targetPort }, req, headers, body) {
  return new Promise((resolve, reject) => {
    const upstream = http.request({
      host: targetHost,
      port: targetPort,
      method: req.method,
      path: req.url,
      headers: { ...headers, "content-length": String(body.length), host: `${targetHost}:${targetPort}` }
    }, resolve);
    upstream.on("error", reject);
    upstream.end(body);
  });
}

function createFrontProxy({ targetHost, targetPort, log, router = null, usageTracker = null }) {
  const target = { targetHost, targetPort };
  const failUpstream = (res, error) => {
    log(`Proxy upstream error: ${error.message}`);
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `DroidProxy could not reach cli-proxy-api: ${error.message}` } }));
  };

  return http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks);
      const baseHeaders = { ...req.headers };
      for (const name of HOP_BY_HOP) delete baseHeaders[name];

      let parsed = null;
      if (req.method === "POST" && raw.length) {
        try {
          parsed = JSON.parse(raw.toString("utf8"));
        } catch {
          parsed = null;
        }
      }

      // Not a model request (or not JSON): forward as-is.
      if (typeof parsed?.model !== "string") {
        try {
          const upstreamRes = await sendUpstream(target, req, baseHeaders, raw);
          res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
          upstreamRes.pipe(res);
          res.on("close", () => upstreamRes.destroy());
        } catch (error) {
          failUpstream(res, error);
        }
        return;
      }

      let primary = parsed.model;
      let roleBackups = [];
      let exclude = [];
      if (router && isAutoModel(primary)) {
        const choice = await router.resolveAuto(baseHeaders, parsed, primary);
        primary = choice.model;
        roleBackups = choice.backups;
        exclude = choice.exclude || [];
      }
      const candidates = router ? router.candidatesFor(primary, roleBackups, exclude) : [primary];

      for (let index = 0; index < candidates.length; index += 1) {
        const model = candidates[index];
        const headers = { ...baseHeaders };
        const tracked = Boolean(usageTracker?.tracks(model));
        // Uncompressed responses so usage can be read from them.
        if (tracked) delete headers["accept-encoding"];
        let upstreamRes;
        try {
          upstreamRes = await sendUpstream(target, req, headers, prepareBody(headers, raw, model, { includeUsage: tracked && req.url.includes("/chat/completions") }));
        } catch (error) {
          failUpstream(res, error);
          return;
        }
        if (tracked) usageTracker.observe(model, upstreamRes);

        const exhausted = router && FALLBACK_STATUSES.has(upstreamRes.statusCode);
        if (exhausted) {
          const until = router.markExhausted(model, upstreamRes.headers["retry-after"]);
          const next = candidates[index + 1];
          if (next && !res.destroyed) {
            upstreamRes.resume();
            router.reportFallback(model, next, until);
            continue;
          }
        }

        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res);
        res.on("close", () => upstreamRes.destroy());
        return;
      }
    });
  });
}

module.exports = { createFrontProxy, sanitizeThinkingBlocks, rewriteAnthropicBeta, prepareBody };
