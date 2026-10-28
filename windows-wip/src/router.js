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
// family from the worker, so reviews are independent. Each role has two
// backups; the second is on a different subscription where possible, so one
// exhausted plan cannot take out all three. Sources: Vals AI (Terminal-Bench
// 4.0, Vibe Code, Legal Index, LegalBench, Finance Agent, EMB, Science Index,
// ProofBench), Arena, Oct 2026.
const role = (model, backup, backup2) => ({ model, backup, backup2 });
const DEFAULT_ROLE_MODELS = {
  coding: {
    orchestrator: role("claude-opus-5-5", "gpt-6-astra", "gemini-4-argon-high"),
    worker: role("gpt-6.1-sol", "claude-sonnet-5-5", "ag-c55s-high"),
    validator: role("claude-sonnet-5-5", "gemini-4-argon-high", "gpt-6-astra")
  },
  legal: {
    orchestrator: role("gemini-4-argon-high", "claude-opus-5-5", "ag-c55o-high"),
    worker: role("gemini-3.8-flash-high", "claude-haiku-5-5", "gpt-6.1-terra"),
    validator: role("claude-fable-5-1", "claude-opus-5-5", "gemini-4-argon-high")
  },
  business: {
    orchestrator: role("claude-opus-5-5", "gemini-4-argon-high", "gpt-6-astra"),
    worker: role("gemini-3.8-flash-high", "gpt-6.1-terra", "claude-haiku-5-5"),
    validator: role("claude-fable-5-1", "ag-c55o-high", "gemini-4-argon-high")
  },
  writing: {
    orchestrator: role("gemini-4-argon-high", "claude-opus-5-5", "ag-c55o-high"),
    worker: role("gemini-3.8-flash-high", "claude-sonnet-5-5", "claude-haiku-5-5"),
    validator: role("claude-opus-5-5", "ag-c55o-high", "claude-fable-5-1")
  },
  research: {
    orchestrator: role("gpt-6-astra", "claude-opus-5-5", "gemini-4-argon-high"),
    worker: role("gpt-6.1-sol", "claude-sonnet-5-5", "gemini-4-argon-high"),
    validator: role("claude-opus-5-5", "gemini-4-argon-high", "ag-c55o-high")
  },
  math: {
    orchestrator: role("gemini-4-argon-high", "claude-fable-5-1", "gpt-6-astra"),
    worker: role("claude-sonnet-5-5", "gpt-6.1-sol", "ag-c55s-high"),
    validator: role("gpt-6.1-sol", "gpt-6-astra", "claude-opus-5-5")
  },
  quick: {
    orchestrator: role("claude-haiku-5-5", "gemini-3.8-flash-high", "gpt-6-luna"),
    worker: role("claude-haiku-5-5", "gpt-6-luna", "gemini-3.8-flash-high"),
    validator: role("gemini-3.8-flash-high", "gpt-6-luna", "claude-haiku-5-5")
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

// Balanced routing. Models with unknown quota (Kimi, API keys) score as if
// half full; the usual pick only loses once another plan has clearly more left.
const UNKNOWN_QUOTA = 50;
const PRIMARY_EDGE = 10;
const DEFAULT_OVERFLOW_THRESHOLD = 35;
// Qwen's Token Plan terms forbid automation, so Missions only overflow to DeepSeek.
const DEFAULT_OVERFLOW_MODELS = ["qwen/qwen3.8-max", "qwen/glm-5.3", "deepseek/deepseek-v4-pro"];
const DEFAULT_MISSION_OVERFLOW_MODELS = ["deepseek/deepseek-v4-pro"];

// Premium pick: Fable 5.1 leads LegalBench (88.5%) and EMB financial
// modelling (76.7%) and is #2 on Arena Math, but costs 2.5x Opus on the same
// Claude quota. So normal Auto sessions in those categories use it only while
// Claude has plenty of quota left.
const DEFAULT_PREMIUM = { enabled: true, model: "claude-fable-5-1", threshold: 60, categories: ["legal", "business", "math"] };

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
    let pool;
    if (roleName) {
      const cell = config.roleModels?.[category]?.[roleName] || DEFAULT_ROLE_MODELS[category][roleName];
      pool = [cell.model, cell.backup, cell.backup2];
    } else {
      const model = config.categoryModels[category] || DEFAULT_CATEGORY_MODELS[category] || DEFAULT_CATEGORY_MODELS.coding;
      pool = [model, ...(config.fallbackChains[model] || []).slice(0, 3)];
    }
    const premium = config.premium || DEFAULT_PREMIUM;
    const premiumApplies = config.balanced && !roleName && premium.enabled && premium.categories.includes(category) && config.isAvailable(premium.model);
    // The premium model also joins the pool as a backup.
    if (premiumApplies) pool.push(premium.model);
    pool = pool.filter((item, index, all) => item && all.indexOf(item) === index);

    let pick;
    const premiumLeft = premiumApplies && !isCooling(premium.model) ? config.quotaFor(premium.model) : null;
    if (premiumLeft !== null && premiumLeft >= premium.threshold) {
      pick = { model: premium.model, reason: `premium: ${premium.model} quota ${Math.round(premiumLeft)}% ≥ ${premium.threshold}%` };
    } else if (config.balanced) {
      pick = pickBalanced(pool, roleName ? config.missionOverflowModels : config.overflowModels, config);
    } else {
      pick = { model: pool[0], reason: "" };
    }
    // The rest of the pool stays as ordered backups behind the chosen model.
    const choice = { category, role: roleName, model: pick.model, backups: pool.filter((item) => item !== pick.model) };
    sessions.set(key, choice);
    if (sessions.size > 1000) sessions.delete(sessions.keys().next().value);
    log(`Auto${roleName ? ` ${roleName}` : ""}: new session classified as ${category}; using ${choice.model}${pick.reason ? ` (${pick.reason})` : ""}`);
    return choice;
  }

  // Balanced: within a pool of comparable models, use the one whose
  // subscription has the most quota left, so coding-heavy days drain every plan
  // evenly instead of one. The usual pick keeps a small edge. When every
  // subscription in the pool is low, pay-per-token overflow models take over.
  function pickBalanced(pool, overflow, config) {
    const scored = pool.map((model, index) => {
      const left = isCooling(model) ? 0 : config.quotaFor(model);
      return { model, left, score: (left ?? UNKNOWN_QUOTA) + (index === 0 ? PRIMARY_EDGE : 0) };
    });
    const best = scored.reduce((top, item) => (item.score > top.score ? item : top), scored[0]);
    const summary = scored.map((item) => `${item.model} ${item.left === null ? "?" : `${Math.round(item.left)}%`}`).join(", ");
    const known = scored.filter((item) => item.left !== null);
    const allLow = known.length > 0 && known.every((item) => item.left < config.overflowThreshold);
    const spare = (overflow || []).find((model) => config.isAvailable(model) && !isCooling(model));
    if (allLow && spare) return { model: spare, reason: `subscriptions low: ${summary}; overflow` };
    return { model: best.model, reason: `balanced: ${summary}` };
  }

  function reportFallback(from, to, until) {
    log(`Backup: ${from} is out of quota${until ? ` until about ${until.toLocaleTimeString()}` : ""}; using ${to}`);
    if (onFallback) onFallback(from, to, until);
  }

  return { candidatesFor, markExhausted, resolveAuto, reportFallback, isCooling, cooldowns };
}

module.exports = {
  DEFAULT_PREMIUM,
  DEFAULT_OVERFLOW_THRESHOLD,
  DEFAULT_OVERFLOW_MODELS,
  DEFAULT_MISSION_OVERFLOW_MODELS,
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
