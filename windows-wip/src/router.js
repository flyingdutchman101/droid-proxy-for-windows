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
    worker: role("gemini-3.8-flash-high", "claude-haiku-5-5", "ag-c55s-high"),
    validator: role("claude-fable-5-2", "claude-opus-5-5", "gemini-4-argon-high")
  },
  business: {
    orchestrator: role("claude-opus-5-5", "gemini-4-argon-high", "gpt-6-astra"),
    worker: role("gemini-3.8-flash-high", "gpt-6.1-terra", "claude-haiku-5-5"),
    validator: role("claude-fable-5-2", "ag-c55o-high", "gemini-4-argon-high")
  },
  writing: {
    orchestrator: role("gemini-4-argon-high", "claude-opus-5-5", "ag-c55o-high"),
    worker: role("gemini-3.8-flash-high", "claude-sonnet-5-5", "claude-haiku-5-5"),
    validator: role("claude-opus-5-5", "ag-c55o-high", "claude-fable-5-2")
  },
  research: {
    orchestrator: role("gpt-6-astra", "claude-opus-5-5", "gemini-4-argon-high"),
    worker: role("gpt-6.1-sol", "claude-sonnet-5-5", "gemini-4-argon-high"),
    validator: role("claude-opus-5-5", "gemini-4-argon-high", "ag-c55o-high")
  },
  math: {
    orchestrator: role("gemini-4-argon-high", "claude-fable-5-2", "gpt-6-astra"),
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
  "claude-fable-5-2": ["ag-c55o-high", "claude-opus-5-5", "gpt-6.1-sol", "gemini-4-argon-high"],
  "claude-fable-5-1": ["claude-fable-5-2", "ag-c55o-high", "gpt-6.1-sol", "gemini-4-argon-high"],
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
  "gemini-4-carbon-high": ["gemini-4-argon-high", "claude-opus-5-5", "gpt-6.1-sol"],
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

// Premium pick: Fable 5.2 (Nov 2026). Fable 5.1 led LegalBench (88.5%) and EMB
// financial modelling (76.7%) and was #2 on Arena Math; 5.2 improves on it.
// Fable still costs well over Opus on the same Claude quota, so normal Auto
// sessions in those categories use it only while Claude has plenty left.
const DEFAULT_PREMIUM = { enabled: true, model: "claude-fable-5-2", threshold: 60, categories: ["legal", "business", "math"] };

// Categories where some model families are too weak to use even as a backup.
// GPT 6 models score 58-69% on the Vals Legal Index (Argon 77%, GLM-5.3 75%,
// Opus 72%), so legal balances only across legal-capable models. Opus comes
// before Fable so equal Claude quota picks the cheaper model; Fable is chosen
// through the premium rule or as a backup.
const CATEGORY_POOLS = {
  legal: ["gemini-4-argon-high", "ag-c55o-high", "claude-opus-5-5", "claude-fable-5-2"]
};
const CATEGORY_EXCLUDES = {
  legal: ["gpt-"]
};
const isExcluded = (model, prefixes) => (prefixes || []).some((prefix) => model.startsWith(prefix));

// Pace boost ("use it or lose it"): a plan is ahead of pace when its weekly or
// monthly window has more % left than % of time left (36% left with 2h of 168h
// to go is +35). While a plan is ahead by the boost margin, sessions on it move
// up to its strongest model and run at maximum reasoning effort. Opus stays
// Opus for coding (Terminal-Bench 65% vs Fable 58%). Quick tasks move up at
// most one step.
const STRONGER = {
  "gpt-6-luna": "gpt-6.1-sol",
  "gpt-6.1-sol": "gpt-6-astra",
  "gpt-6.1-terra": "gpt-6-astra",
  "claude-haiku-5-5": "claude-sonnet-5-5",
  "claude-sonnet-5-5": "claude-opus-5-5",
  "claude-opus-5-5": { model: "claude-fable-5-2", except: ["coding"] },
  "gemini-3.8-flash-high": "gemini-4-argon-high",
  "gemini-4-argon-high": "gemini-4-carbon-high",
  "claude-fable-5-1": "claude-fable-5-2",
  "ag-c55s-high": "ag-c55o-high"
};
const DEFAULT_PACE = { enabled: true, surplus: 15, effortBoost: true };
// Pool order still matters: the usual pick gets a small head start.
const POSITION_BONUS = [10, 6, 3];
// A plan whose 5-hour window is nearly empty cannot take a new session now.
const SHORT_WINDOW_FLOOR = 10;
// Pinned sessions are re-scored on the next user message after this long, so
// a long session follows whichever plan most needs spending.
const REPICK_MS = 15 * 60 * 1000;

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

// User messages with real text (tool-result turns and pure context blocks do
// not count), used to spot a new user turn in a pinned session.
function userTurns(body) {
  return userTexts(body).filter((text) => stripTaggedBlocks(text)).length;
}

function sessionKey(headers, body) {
  const header = headers["x-claude-code-session-id"] || headers["x-session-id"] || headers["session_id"];
  if (header) return `h:${header}`;
  if (typeof body?.prompt_cache_key === "string") return `p:${body.prompt_cache_key}`;
  const first = userTexts(body)[0] || "";
  return `t:${crypto.createHash("sha256").update(first).digest("hex").slice(0, 24)}`;
}

function formatHours(hours) {
  return hours >= 48 ? `${Math.round(hours / 24)}d` : `${Math.round(hours)}h`;
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
  // `exclude`: model-ID prefixes never used as backups for this request (the
  // chosen model itself is always kept).
  function candidatesFor(model, roleBackups = [], exclude = []) {
    const config = getConfig();
    const chain = config.fallbackEnabled ? [...roleBackups, ...(config.fallbackChains[model] || [])] : [];
    const ordered = [model, ...chain.filter((item) => !isExcluded(item, exclude))].filter((item, index, all) => item && all.indexOf(item) === index);
    const empty = (item) => {
      const left = config.quotaFor ? config.quotaFor(item) : null;
      return left !== null && left < 1;
    };
    const available = ordered.filter((item) => !isCooling(item) && !empty(item));
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
  // pinned per session; the model comes from the role table and is re-scored
  // on a later user message, so long sessions keep following quota.
  async function resolveAuto(headers, body, autoModel = AUTO_MODEL_ID) {
    const roleName = AUTO_ROLE_IDS[autoModel] || null;
    const key = `${roleName || "main"}|${sessionKey(headers, body)}`;
    const turns = userTurns(body);
    const pinned = sessions.get(key);
    if (pinned) {
      const newTurn = turns > pinned.turns;
      // "ok"/"continue" openers get classified quick; re-classify once real work shows up.
      const reclassify = newTurn && pinned.category === "quick";
      if (!newTurn || (!reclassify && Date.now() - pinned.pickedAt < REPICK_MS)) return pinned;
      const category = reclassify ? await classify(taskText(body)) : pinned.category;
      const next = choose(category, roleName, turns);
      if (next.model !== pinned.model || category !== pinned.category) {
        log(`Auto${roleName ? ` ${roleName}` : ""}: session ${category !== pinned.category ? `re-classified as ${category}; ` : ""}moved ${pinned.model} → ${next.model}${next.boost ? " at max effort" : ""}${next.reason ? ` (${next.reason})` : ""}`);
      }
      Object.assign(pinned, next);
      return pinned;
    }

    const category = await classify(taskText(body));
    const choice = choose(category, roleName, turns);
    sessions.set(key, choice);
    if (sessions.size > 1000) sessions.delete(sessions.keys().next().value);
    log(`Auto${roleName ? ` ${roleName}` : ""}: new session classified as ${category}; using ${choice.model}${choice.boost ? " at max effort" : ""}${choice.reason ? ` (${choice.reason})` : ""}`);
    return choice;
  }

  function poolFor(category, roleName, config) {
    let pool;
    if (roleName) {
      const cell = config.roleModels?.[category]?.[roleName] || DEFAULT_ROLE_MODELS[category][roleName];
      pool = [cell.model, cell.backup, cell.backup2];
    } else {
      const model = config.categoryModels[category] || DEFAULT_CATEGORY_MODELS[category] || DEFAULT_CATEGORY_MODELS.coding;
      pool = [model, ...(CATEGORY_POOLS[category] || (config.fallbackChains[model] || []).slice(0, 3))];
    }
    const exclude = CATEGORY_EXCLUDES[category] || [];
    return { pool: pool.filter((item, index) => index === 0 || (item && !isExcluded(item, exclude))), exclude };
  }

  function choose(category, roleName, turns) {
    const config = getConfig();
    const { exclude } = poolFor(category, roleName, config);
    let { pool } = poolFor(category, roleName, config);
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
    let boost = false;
    if (config.balanced) {
      pick = upgradeIfAhead(pick, category, exclude, config);
      const pace = config.pace || DEFAULT_PACE;
      // Quick tasks keep their normal effort so short replies stay fast.
      boost = Boolean(pace.effortBoost && category !== "quick" && aheadOf(pick.model, config));
    }
    // The rest of the pool stays as ordered backups behind the chosen model.
    return { category, role: roleName, model: pick.model, reason: pick.reason, boost, backups: pool.filter((item) => item !== pick.model), exclude, turns, pickedAt: Date.now() };
  }

  // Pace info for a model's plan when that plan is far enough ahead of pace
  // (and its 5-hour window can take the work), else null.
  function aheadOf(model, config) {
    const pace = config.pace || DEFAULT_PACE;
    if (!pace.enabled || isCooling(model)) return null;
    const info = config.paceFor?.(model);
    if (!info || info.surplus < pace.surplus) return null;
    if (typeof info.shortLeft === "number" && info.shortLeft < SHORT_WINDOW_FLOOR) return null;
    return info;
  }

  // Walks the STRONGER chain while the model's plan is ahead of pace, so the
  // session spends that quota on the best model the plan offers.
  function upgradeIfAhead(pick, category, exclude, config) {
    const info = aheadOf(pick.model, config);
    if (!info) return pick;
    let model = pick.model;
    for (let step = 0; step < (category === "quick" ? 1 : 3); step += 1) {
      const rule = STRONGER[model];
      const next = typeof rule === "string" ? rule : rule && !rule.except.includes(category) ? rule.model : null;
      if (!next || isExcluded(next, exclude) || isCooling(next) || !config.isAvailable(next)) break;
      model = next;
    }
    if (model === pick.model) return pick;
    const reason = `${pick.reason ? `${pick.reason}; ` : ""}ahead of pace by ${Math.round(info.surplus)} pts (${Math.round(info.left)}% left, resets in ${formatHours(info.hoursLeft)}), upgraded ${pick.model} → ${model}`;
    return { model, reason };
  }

  // Balanced: rank the pool by how far each plan is ahead of its weekly pace,
  // so quota that would reset unused is spent first and plans that are behind
  // pace are saved. Without a weekly window, % left counts against a 50% mid.
  // When every plan in the pool is low and none is ahead, overflow takes over.
  function pickBalanced(pool, overflow, config) {
    const scored = pool.map((model, index) => {
      const bonus = POSITION_BONUS[index] || 0;
      if (isCooling(model)) return { model, left: 0, surplus: null, ahead: false, score: -1000 + bonus };
      const left = config.quotaFor(model);
      const info = config.paceFor?.(model) || null;
      const shortLeft = info && typeof info.shortLeft === "number" ? info.shortLeft : left;
      let score = info ? info.surplus : left === null ? 0 : left - UNKNOWN_QUOTA;
      if (left !== null && left < 1) score -= 1000;
      else if (shortLeft !== null && shortLeft < SHORT_WINDOW_FLOOR) score -= 100;
      return { model, left, surplus: info ? info.surplus : null, ahead: Boolean(aheadOf(model, config)), score: score + bonus };
    });
    const best = scored.reduce((top, item) => (item.score > top.score ? item : top), scored[0]);
    const summary = scored.map((item) => `${item.model} ${item.left === null ? "?" : `${Math.round(item.left)}%`}${item.surplus === null ? "" : ` ${item.surplus >= 0 ? "+" : ""}${Math.round(item.surplus)}`}`).join(", ");
    const known = scored.filter((item) => item.left !== null);
    // Quota ahead of pace is never "low": spend it before overflowing.
    const allLow = known.length > 0 && !scored.some((item) => item.ahead) && known.every((item) => item.left < config.overflowThreshold);
    const spare = (overflow || []).find((model) => config.isAvailable(model) && !isCooling(model));
    if (allLow && spare) return { model: spare, reason: `subscriptions low: ${summary}; overflow` };
    return { model: best.model, reason: `pace: ${summary}` };
  }

  // Sessions pinned to an exhausted model stay on the backup that served them
  // instead of hitting the limit again after every cool-down.
  function reportFallback(from, to, until) {
    let moved = 0;
    for (const session of sessions.values()) {
      if (session.model !== from) continue;
      session.backups = [from, ...session.backups.filter((item) => item !== to && item !== from)];
      session.model = to;
      session.pickedAt = Date.now();
      moved += 1;
    }
    log(`Backup: ${from} is out of quota${until ? ` until about ${until.toLocaleTimeString()}` : ""}; using ${to}${moved ? ` (${moved} session${moved === 1 ? "" : "s"} moved)` : ""}`);
    if (onFallback) onFallback(from, to, until);
  }

  return { candidatesFor, markExhausted, resolveAuto, reportFallback, isCooling, cooldowns };
}

module.exports = {
  DEFAULT_PACE,
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
  userTurns,
  parseCategory
};
