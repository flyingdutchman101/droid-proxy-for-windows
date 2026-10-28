const crypto = require("crypto");
const http = require("http");

// Model selection for the front proxy:
// - Backup chains: when a model is out of quota, retry the same request on the
//   next model in its chain and skip the exhausted model until it cools down.
// - Auto: classify a session's task once, then pin the chosen model for the
//   whole session so prompt caching and tool history stay consistent.

const AUTO_MODEL_ID = "droidproxy-auto";

// Factory Missions run three roles; each gets its own Auto model so the role
// is known from the model ID alone.
const ROLES = ["orchestrator", "worker", "validator"];
const AUTO_ROLE_IDS = Object.fromEntries(ROLES.map((role) => [`${AUTO_MODEL_ID}-${role}`, role]));
const isAutoModel = (model) => model === AUTO_MODEL_ID || Boolean(AUTO_ROLE_IDS[model]);

// Errors that mean "this model can't serve right now" rather than "bad request".
const FALLBACK_STATUSES = new Set([429, 503, 529]);
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_COOLDOWN_MS = 6 * 60 * 60 * 1000;

const CATEGORIES = {
  coding: "Writing, debugging, reviewing, or refactoring code; software engineering; DevOps; running commands",
  legal: "Contracts, legal research, compliance, policies, terms, regulatory questions",
  business: "Business or financial analysis, strategy, spreadsheets, financial documents, sales, operations",
  writing: "Marketing copy, emails, articles, documentation prose, editing, creative writing",
  research: "Research, science, deep reasoning, literature review, technical explanations",
  math: "Math, statistics, data analysis, proofs",
  quick: "A short simple question, lookup, or small one-step task"
};

// Picks per category from independent leaderboards (Vals AI, Arena), Oct 2026.
// Writing goes to Argon (tied with Opus) to spread load across subscriptions.
const DEFAULT_CATEGORY_MODELS = {
  coding: "claude-opus-5-5",
  legal: "gemini-4-argon-high",
  business: "claude-opus-5-5",
  writing: "gemini-4-argon-high",
  research: "gpt-6-astra",
  math: "claude-sonnet-5-5",
  quick: "claude-haiku-5-5"
};

// Orchestrator: strongest planner for the task type. Worker: capable but faster
// and cheaper, since it does most of the tokens. Validator: a different model
// family from the worker, so reviews are independent. Each role has its own
// backup. Sources: Vals AI (Terminal-Bench 4.0, Vibe Code, Legal Index,
// LegalBench, Finance Agent, EMB, Science Index, ProofBench), Arena, Oct 2026.
const role = (model, backup) => ({ model, backup });
const DEFAULT_ROLE_MODELS = {
  coding: {
    orchestrator: role("claude-opus-5-5", "gpt-6-astra"),
    worker: role("gpt-6.1-sol", "claude-sonnet-5-5"),
    validator: role("claude-sonnet-5-5", "gemini-4-argon-high")
  },
  legal: {
    orchestrator: role("gemini-4-argon-high", "claude-opus-5-5"),
    worker: role("gemini-3.8-flash-high", "claude-haiku-5-5"),
    validator: role("claude-fable-5-1", "claude-opus-5-5")
  },
  business: {
    orchestrator: role("claude-opus-5-5", "gemini-4-argon-high"),
    worker: role("gemini-3.8-flash-high", "gpt-6.1-terra"),
    validator: role("claude-fable-5-1", "ag-c55o-high")
  },
  writing: {
    orchestrator: role("gemini-4-argon-high", "claude-opus-5-5"),
    worker: role("gemini-3.8-flash-high", "claude-sonnet-5-5"),
    validator: role("claude-opus-5-5", "ag-c55o-high")
  },
  research: {
    orchestrator: role("gpt-6-astra", "claude-opus-5-5"),
    worker: role("gpt-6.1-sol", "claude-sonnet-5-5"),
    validator: role("claude-opus-5-5", "gemini-4-argon-high")
  },
  math: {
    orchestrator: role("gemini-4-argon-high", "claude-fable-5-1"),
    worker: role("claude-sonnet-5-5", "gpt-6.1-sol"),
    validator: role("gpt-6.1-sol", "gpt-6-astra")
  },
  quick: {
    orchestrator: role("claude-haiku-5-5", "gemini-3.8-flash-high"),
    worker: role("claude-haiku-5-5", "gpt-6-luna"),
    validator: role("gemini-3.8-flash-high", "gpt-6-luna")
  }
};

const DEFAULT_CHAINS = {
  "claude-fable-5-1": ["ag-c55o-high", "gpt-6.1-sol", "gemini-4-argon-high"],
  "claude-opus-5-5": ["ag-c55o-high", "gpt-6.1-sol", "gemini-4-argon-high"],
  "claude-sonnet-5-5": ["ag-c55s-high", "gpt-6.1-sol", "gemini-4-argon-high"],
  "claude-haiku-5-5": ["gemini-3.8-flash-high", "gpt-6-luna"],
  "ag-c55o-high": ["claude-opus-5-5", "gpt-6.1-sol"],
  "ag-c55s-high": ["claude-sonnet-5-5", "gpt-6.1-sol"],
  "gpt-6-astra": ["gpt-6.1-sol", "claude-opus-5-5", "gemini-4-argon-high"],
  "gpt-6.1-sol": ["claude-opus-5-5", "gemini-4-argon-high"],
  "gpt-6.1-terra": ["gpt-6.1-sol", "claude-sonnet-5-5", "gemini-4-argon-high"],
  "gpt-6-luna": ["claude-haiku-5-5", "gemini-3.8-flash-high"],
  "gemini-4-argon-high": ["claude-opus-5-5", "gpt-6.1-sol"],
  "gemini-3.8-flash-high": ["claude-haiku-5-5", "gpt-6-luna"],
  "kimi-k3": ["claude-sonnet-5-5", "gpt-6.1-sol"],
  "kimi-k2.6": ["claude-sonnet-5-5", "gpt-6.1-sol"]
};

const DEFAULT_CLASSIFIER_MODELS = ["claude-haiku-5-5", "gemini-3.8-flash-high", "gpt-6-luna"];

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && (block.type === "text" || block.type === "input_text"))
    .map((block) => block.text || "")
    .join("\n");
}

// Works for Anthropic Messages, OpenAI Responses, and Chat Completions bodies.
function userTexts(body) {
  const items = Array.isArray(body?.messages) ? body.messages : Array.isArray(body?.input) ? body.input : [];
  if (typeof body?.input === "string") return [body.input];
  return items.filter((item) => item?.role === "user").map((item) => textOf(item.content)).filter((text) => text.trim());
}

// Factory wraps context in tagged blocks such as <system-reminder>; the task is what's left.
function stripTaggedBlocks(text) {
  return text.replace(/<([a-z][\w-]*)[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/\s+/g, " ").trim();
}

function taskText(body) {
  const texts = userTexts(body);
  const latest = stripTaggedBlocks(texts[texts.length - 1] || "");
  return latest.slice(-3000);
}

function sessionKey(headers, body) {
  const header = headers["x-claude-code-session-id"] || headers["x-session-id"] || headers["session_id"];
  if (header) return `h:${header}`;
  if (typeof body?.prompt_cache_key === "string") return `p:${body.prompt_cache_key}`;
  const first = userTexts(body)[0] || "";
  return `t:${crypto.createHash("sha256").update(first).digest("hex").slice(0, 24)}`;
}

function parseCategory(reply) {
  const word = String(reply || "").toLowerCase().match(/[a-z]+/g) || [];
  return word.find((item) => CATEGORIES[item]) || null;
}

function createRouter({ targetHost, targetPort, log, getConfig, onFallback }) {
  const cooldowns = new Map();
  const sessions = new Map();

  function isCooling(model) {
    const until = cooldowns.get(model);
    if (!until) return false;
    if (until <= Date.now()) {
      cooldowns.delete(model);
      return false;
    }
    return true;
  }

  function markExhausted(model, retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    const ms = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_COOLDOWN_MS) : DEFAULT_COOLDOWN_MS;
    cooldowns.set(model, Date.now() + ms);
    return new Date(Date.now() + ms);
  }

  // Primary first, then any role backup, then the primary's chain; models still
  // cooling down are skipped unless nothing else is left, so a request is never
  // refused without trying.
  function candidatesFor(model, roleBackups = []) {
    const config = getConfig();
    const chain = config.fallbackEnabled ? [...roleBackups, ...(config.fallbackChains[model] || [])] : [];
    const ordered = [model, ...chain].filter((item, index, all) => item && all.indexOf(item) === index);
    const available = ordered.filter((item) => !isCooling(item));
    return available.length ? available : ordered;
  }

  function classifyRequest(text, model) {
    const categories = Object.entries(CATEGORIES).map(([name, description]) => `${name}: ${description}`).join("\n");
    const payload = JSON.stringify({
      model,
      max_tokens: 16,
      system: `Classify the user's task into exactly one category. Reply with only the category name.\n\n${categories}`,
      messages: [{ role: "user", content: `Task:\n${text || "(empty)"}` }]
    });
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: targetHost,
        port: targetPort,
        method: "POST",
        path: "/v1/messages",
        headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", "content-length": Buffer.byteLength(payload) },
        timeout: 15000
      }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          try {
            resolve(parseCategory(textOf(JSON.parse(Buffer.concat(chunks).toString("utf8")).content)));
          } catch (error) {
            reject(error);
          }
        });
      });
      req.on("timeout", () => req.destroy(new Error("classifier timed out")));
      req.on("error", reject);
      req.end(payload);
    });
  }

  async function classify(text) {
    for (const model of getConfig().classifierModels) {
      if (isCooling(model)) continue;
      try {
        const category = await classifyRequest(text, model);
        if (category) return category;
      } catch (error) {
        log(`Auto: classifier ${model} failed (${error.message})`);
      }
    }
    return "coding";
  }

  // `autoModel` is droidproxy-auto or one of its role variants. The category is
  // pinned per session; the model then comes from the role table.
  async function resolveAuto(headers, body, autoModel = AUTO_MODEL_ID) {
    const roleName = AUTO_ROLE_IDS[autoModel] || null;
    const key = `${roleName || "main"}|${sessionKey(headers, body)}`;
    const pinned = sessions.get(key);
    if (pinned) return pinned;

    const config = getConfig();
    const category = await classify(taskText(body));
    let choice;
    if (roleName) {
      const cell = config.roleModels?.[category]?.[roleName] || DEFAULT_ROLE_MODELS[category][roleName];
      choice = { category, role: roleName, model: cell.model, backups: cell.backup ? [cell.backup] : [] };
    } else {
      const model = config.categoryModels[category] || DEFAULT_CATEGORY_MODELS[category] || DEFAULT_CATEGORY_MODELS.coding;
      choice = { category, role: null, model, backups: [] };
    }
    sessions.set(key, choice);
    if (sessions.size > 1000) sessions.delete(sessions.keys().next().value);
    log(`Auto${roleName ? ` ${roleName}` : ""}: new session classified as ${category}; using ${choice.model}`);
    return choice;
  }

  function reportFallback(from, to, until) {
    log(`Backup: ${from} is out of quota${until ? ` until about ${until.toLocaleTimeString()}` : ""}; using ${to}`);
    if (onFallback) onFallback(from, to, until);
  }

  return { candidatesFor, markExhausted, resolveAuto, reportFallback, isCooling, cooldowns };
}

module.exports = {
  AUTO_MODEL_ID,
  AUTO_ROLE_IDS,
  ROLES,
  DEFAULT_ROLE_MODELS,
  isAutoModel,
  FALLBACK_STATUSES,
  CATEGORIES,
  DEFAULT_CATEGORY_MODELS,
  DEFAULT_CHAINS,
  DEFAULT_CLASSIFIER_MODELS,
  createRouter,
  taskText,
  sessionKey,
  parseCategory
};
