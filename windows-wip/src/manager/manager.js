// DroidProxy Manager: drives Factory Workstreams unattended and improves itself.
//
// - install(): copies hook.cjs to ~/.factory/hooks/droidproxy-manager.cjs,
//   registers it for Stop and PreToolUse in ~/.factory/hooks.json, and bridges
//   the instruction-refresh guard so it leaves permission decisions in managed
//   Workstreams to the manager (backups are written first).
// - Review worker: merge attempts queue a review; two models from different
//   families review the PR diff read-only; both must approve.
// - Retrospective (nightly or on demand): reads metrics, gate denials, review
//   reasons and the Workstreams' RUNLOG/DECISIONS files, then adds or retires
//   lessons and may write a new prompt version. A prompt version that scores
//   worse than the one before it is rolled back automatically.
// Limits and gates live in config.json and hook.cjs, which managed sessions
// cannot edit, so self-improvement can steer the loop but not loosen it.

const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");
const hook = require("./hook.cjs");

const HOOK_FILE = "droidproxy-manager.cjs";
const BRIDGE_MARKER = "droidproxy-manager-bridge";
const DEFAULT_CONFIG = {
  enabled: false,
  spaces: [],
  limits: { ...hook.DEFAULT_LIMITS },
  deployCommands: [],
  reviewers: ["custom:droidproxy:claude-opus-5-5", "custom:droidproxy:gemini-4-argon-high"],
  retroModel: "custom:droidproxy:claude-opus-5-5",
  retroHour: 4
};
const MAX_DIFF_CHARS = 150000;
const MAX_LESSONS = 30;
const REVIEW_POLL_MS = 30 * 1000;
const RETRO_POLL_MS = 10 * 60 * 1000;

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
}

// The bridge wraps the guard's main(): an "ask" in a managed session is
// dropped (nobody is there to answer it) and the manager hook decides instead.
const BRIDGE_CODE = `
// ${BRIDGE_MARKER} (added by VeryCuteDroidProxy; remove this block and rename
// __dpMainOriginal back to main to undo). In Workstreams the DroidProxy Manager
// runs, nobody is there to answer "ask", so the manager hook decides instead.
import { createRequire as __dpCreateRequire } from 'node:module';
function __dpManaged(input, home) {
  try {
    const managerHook = __dpCreateRequire(import.meta.url)(path.join(home, '.factory', 'hooks', '${HOOK_FILE}'));
    return managerHook.isManagedSession(input?.session_id, home);
  } catch {
    return false;
  }
}
export function main(raw, options = {}) {
  const home = options.home ?? os.homedir();
  const result = __dpMainOriginal(raw, options);
  let input = null;
  try { input = JSON.parse(raw); } catch { input = null; }
  if (input?.hook_event_name === 'PreToolUse' && /"permissionDecision":"ask"/.test(result?.stdout || '') && __dpManaged(input, home)) {
    return { ...result, stdout: '' };
  }
  return result;
}
// end ${BRIDGE_MARKER}
`;

function createManager({ log = () => {}, home = os.homedir(), runDroid, runGh } = {}) {
  const p = hook.paths(home);
  const hooksDir = path.join(p.factory, "hooks");
  const hooksJson = path.join(p.factory, "hooks.json");
  const guardFile = path.join(hooksDir, "instruction-refresh.mjs");
  const installedHook = path.join(hooksDir, HOOK_FILE);
  const hookCommand = `node "${installedHook.replace(/\\/g, "/")}"`;
  const retroDir = path.join(p.root, "retro");
  let reviewBusy = false;
  let retroBusy = false;
  let timers = [];

  const exec = (command, args, options) => new Promise((resolve) => {
    cp.execFile(command, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code ?? 0, stdout: stdout || "", stderr: stderr || "", error });
    });
  });
  const droid = runDroid || ((args, options) => exec("droid", args, options));
  const gh = runGh || ((args, options) => exec("gh", args, options));

  // ---------- config ----------
  function config() {
    const raw = readJSON(p.config, {});
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      limits: { ...DEFAULT_CONFIG.limits, ...(raw.limits || {}) },
      spaces: Array.isArray(raw.spaces) ? raw.spaces : [],
      deployCommands: Array.isArray(raw.deployCommands) ? raw.deployCommands : [],
      reviewers: Array.isArray(raw.reviewers) && raw.reviewers.length === 2 ? raw.reviewers : DEFAULT_CONFIG.reviewers
    };
  }

  function saveConfig(next) {
    const current = config();
    const limits = { ...current.limits };
    for (const [key, value] of Object.entries(next.limits || {})) {
      const number = Number(value);
      if (key in hook.DEFAULT_LIMITS && Number.isFinite(number) && number >= 0) limits[key] = Math.round(number);
    }
    const merged = {
      ...current,
      ...(typeof next.enabled === "boolean" ? { enabled: next.enabled } : {}),
      ...(Array.isArray(next.spaces) ? { spaces: [...new Set(next.spaces.filter((id) => typeof id === "string" && /^[\w-]+$/.test(id)))] } : {}),
      ...(Array.isArray(next.deployCommands) ? { deployCommands: next.deployCommands.map((item) => String(item).trim()).filter(Boolean).slice(0, 20) } : {}),
      ...(Array.isArray(next.reviewers) && next.reviewers.length === 2 ? { reviewers: next.reviewers.map(String) } : {}),
      ...(typeof next.retroModel === "string" && next.retroModel ? { retroModel: next.retroModel } : {}),
      ...(Number.isInteger(Number(next.retroHour)) && Number(next.retroHour) >= 0 && Number(next.retroHour) <= 23 ? { retroHour: Number(next.retroHour) } : {}),
      limits
    };
    writeJSON(p.config, merged);
    ensurePrompt();
    return merged;
  }

  // ---------- prompt versions and lessons ----------
  function promptInfo() {
    return readJSON(path.join(p.promptDir, "current.json"), null);
  }

  function promptText(version) {
    try {
      return fs.readFileSync(path.join(p.promptDir, `v${version}.md`), "utf8");
    } catch {
      return "";
    }
  }

  function ensurePrompt() {
    if (promptInfo()) return;
    const text = fs.readFileSync(path.join(__dirname, "default-prompt.md"), "utf8");
    fs.mkdirSync(p.promptDir, { recursive: true });
    fs.writeFileSync(path.join(p.promptDir, "v1.md"), text);
    writeJSON(path.join(p.promptDir, "current.json"), { version: 1, since: new Date().toISOString(), history: [{ version: 1, since: new Date().toISOString(), origin: "default" }] });
  }

  function setPromptVersion(version, origin, extra = {}) {
    const info = promptInfo() || { history: [] };
    const now = new Date().toISOString();
    const history = (info.history || []).map((item) => (item.version === info.version && !item.until ? { ...item, until: now } : item));
    history.push({ version, since: now, origin, ...extra });
    writeJSON(path.join(p.promptDir, "current.json"), { version, since: now, history });
  }

  function lessons() {
    const list = readJSON(p.lessons, []);
    return Array.isArray(list) ? list : [];
  }

  function addLessons(adds, retireIds, origin) {
    const list = lessons();
    for (const id of retireIds || []) {
      const item = list.find((lesson) => lesson.id === id && !lesson.retired);
      if (item) Object.assign(item, { retired: true, retiredAt: new Date().toISOString() });
    }
    const known = new Set(list.filter((lesson) => !lesson.retired).map((lesson) => lesson.text.toLowerCase()));
    let added = 0;
    for (const lesson of (adds || []).slice(0, 5)) {
      const text = String(lesson?.text || "").trim().replace(/\s+/g, " ").slice(0, 240);
      if (text.length < 12 || known.has(text.toLowerCase())) continue;
      known.add(text.toLowerCase());
      list.push({ id: `l${Date.now().toString(36)}${added}`, text, evidence: String(lesson?.evidence || "").slice(0, 300), origin, at: new Date().toISOString() });
      added += 1;
    }
    // Keep the active set small: retire the oldest beyond the cap.
    const active = list.filter((lesson) => !lesson.retired);
    for (const lesson of active.slice(0, Math.max(0, active.length - MAX_LESSONS))) Object.assign(lesson, { retired: true, retiredAt: new Date().toISOString(), retiredReason: "cap" });
    writeJSON(p.lessons, list);
    return added;
  }

  // ---------- install ----------
  function hooksConfig() {
    return readJSON(hooksJson, {});
  }

  function hasEntry(cfg, event) {
    return (cfg[event] || []).some((group) => (group.hooks || []).some((item) => String(item.command || "").includes(HOOK_FILE)));
  }

  function status() {
    const cfg = hooksConfig();
    let guard = "absent";
    try {
      guard = fs.readFileSync(guardFile, "utf8").includes(BRIDGE_MARKER) ? "bridged" : "not bridged";
    } catch {
      guard = "absent";
    }
    let hookCurrent = false;
    try {
      hookCurrent = fs.readFileSync(installedHook, "utf8") === fs.readFileSync(path.join(__dirname, "hook.cjs"), "utf8");
    } catch {
      hookCurrent = false;
    }
    const installed = hookCurrent && hasEntry(cfg, "Stop") && hasEntry(cfg, "PreToolUse") && guard !== "not bridged";
    return { installed, hookCurrent, stopHook: hasEntry(cfg, "Stop"), toolHook: hasEntry(cfg, "PreToolUse"), guard };
  }

  function bridgeGuard() {
    let text;
    try {
      text = fs.readFileSync(guardFile, "utf8");
    } catch {
      return "absent";
    }
    if (text.includes(BRIDGE_MARKER)) return "bridged";
    if (!/\nexport function main\(raw, \{ home = os\.homedir\(\), env = process\.env \} = \{\}\) \{/.test(text)) {
      throw new Error("The instruction-refresh guard has an unexpected layout; it was left unchanged. Managed merges would wait for approval.");
    }
    fs.copyFileSync(guardFile, `${guardFile}.droidproxy-manager-${stamp()}.bak`);
    const patched = text.replace(
      /\nexport function main\(raw, \{ home = os\.homedir\(\), env = process\.env \} = \{\}\) \{/,
      "\nfunction __dpMainOriginal(raw, { home = os.homedir(), env = process.env } = {}) {"
    ).replace(/\nif \(process\.argv\[1\]/, `${BRIDGE_CODE}\nif (process.argv[1]`);
    if (!patched.includes(BRIDGE_MARKER) || !patched.includes("__dpMainOriginal")) throw new Error("Could not bridge the guard; left unchanged.");
    fs.writeFileSync(guardFile, patched);
    return "bridged";
  }

  function unbridgeGuard() {
    let text;
    try {
      text = fs.readFileSync(guardFile, "utf8");
    } catch {
      return;
    }
    if (!text.includes(BRIDGE_MARKER)) return;
    const start = text.indexOf(`\n// ${BRIDGE_MARKER}`);
    const endMarker = `// end ${BRIDGE_MARKER}\n`;
    const end = text.indexOf(endMarker);
    if (start < 0 || end < 0) throw new Error("Could not find the bridge block; restore the guard from its .bak file.");
    const restored = (text.slice(0, start) + text.slice(end + endMarker.length)).replace("\nfunction __dpMainOriginal(raw,", "\nexport function main(raw,");
    fs.copyFileSync(guardFile, `${guardFile}.droidproxy-manager-${stamp()}.bak`);
    fs.writeFileSync(guardFile, restored);
  }

  function install() {
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(installedHook, fs.readFileSync(path.join(__dirname, "hook.cjs")));
    const cfg = hooksConfig();
    if (!hasEntry(cfg, "Stop") || !hasEntry(cfg, "PreToolUse")) {
      if (fs.existsSync(hooksJson)) fs.copyFileSync(hooksJson, `${hooksJson}.droidproxy-manager-${stamp()}.bak`);
      for (const [event, timeout] of [["Stop", 30], ["PreToolUse", 90]]) {
        if (hasEntry(cfg, event)) continue;
        cfg[event] = [...(cfg[event] || []), { matcher: "*", hooks: [{ type: "command", command: hookCommand, timeout }] }];
      }
      writeJSON(hooksJson, cfg);
    }
    const guard = bridgeGuard();
    ensurePrompt();
    if (!fs.existsSync(p.config)) writeJSON(p.config, DEFAULT_CONFIG);
    log(`Manager: hooks installed (guard ${guard})`);
    return status();
  }

  function uninstall() {
    const cfg = hooksConfig();
    if (hasEntry(cfg, "Stop") || hasEntry(cfg, "PreToolUse")) {
      fs.copyFileSync(hooksJson, `${hooksJson}.droidproxy-manager-${stamp()}.bak`);
      for (const event of ["Stop", "PreToolUse"]) {
        cfg[event] = (cfg[event] || []).map((group) => ({ ...group, hooks: (group.hooks || []).filter((item) => !String(item.command || "").includes(HOOK_FILE)) })).filter((group) => group.hooks.length);
        if (!cfg[event].length) delete cfg[event];
      }
      writeJSON(hooksJson, cfg);
    }
    unbridgeGuard();
    try {
      fs.rmSync(installedHook, { force: true });
    } catch {
      // ignore
    }
    log("Manager: hooks removed");
    return status();
  }

  // Keeps the installed hook in sync with the app version.
  function refreshInstalledHook() {
    try {
      const s = status();
      if (s.stopHook && !s.hookCurrent) {
        fs.writeFileSync(installedHook, fs.readFileSync(path.join(__dirname, "hook.cjs")));
        log("Manager: updated the installed hook");
      }
    } catch (error) {
      log(`Manager: could not update the hook (${error.message})`);
    }
  }

  // ---------- Workstreams ----------
  function sessionFile(id, ext) {
    try {
      for (const dir of fs.readdirSync(p.sessions)) {
        const file = path.join(p.sessions, dir, `${id}${ext}`);
        if (fs.existsSync(file)) return file;
      }
    } catch {
      // none
    }
    return null;
  }

  function firstLine(file) {
    try {
      const fd = fs.openSync(file, "r");
      const buffer = Buffer.alloc(4096);
      const read = fs.readSync(fd, buffer, 0, 4096, 0);
      fs.closeSync(fd);
      return JSON.parse(buffer.slice(0, read).toString("utf8").split("\n")[0]);
    } catch {
      return null;
    }
  }

  function workstreams() {
    const cfg = config();
    let ids = [];
    try {
      ids = fs.readdirSync(p.spaces);
    } catch {
      ids = [];
    }
    return ids.map((id) => {
      const list = readJSON(path.join(p.spaces, id, "sessions", "index.json"), null);
      if (!Array.isArray(list)) return null;
      const orchestrator = list.find((item) => !item.parentSessionId);
      if (!orchestrator) return null;
      const start = firstLine(sessionFile(orchestrator.sessionId, ".jsonl"));
      return {
        id,
        title: start?.title || "Untitled Workstream",
        orchestrator: orchestrator.sessionId,
        sessions: list.length,
        updatedAt: list.map((item) => item.updatedAt).filter(Boolean).sort().pop() || orchestrator.updatedAt || null,
        managed: cfg.spaces.includes(id)
      };
    }).filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  // ---------- log and metrics ----------
  function readLog(limit = 5000) {
    try {
      const lines = fs.readFileSync(p.log, "utf8").trim().split("\n").slice(-limit);
      return lines.map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  function logEvent(entry) {
    fs.mkdirSync(p.root, { recursive: true });
    fs.appendFileSync(p.log, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
  }

  // Outcome score for a time window: shipped work per active day, minus
  // rejected reviews and denied actions per active day.
  function metricsFor(entries) {
    const m = { continuations: 0, idles: 0, merges: 0, deploys: 0, reviewsApproved: 0, reviewsRejected: 0, denials: 0, days: new Set() };
    for (const entry of entries) {
      if (entry.event === "stop" && entry.decision === "continue") {
        m.continuations += 1;
        m.days.add(entry.t.slice(0, 10));
      }
      if (entry.event === "stop" && entry.decision === "allow") m.idles += 1;
      if (entry.event === "merge" && entry.decision === "allow") m.merges += 1;
      if (entry.event === "deploy" && entry.decision === "allow") m.deploys += 1;
      if (entry.event === "review") entry.approve ? (m.reviewsApproved += 1) : (m.reviewsRejected += 1);
      if (entry.event === "tool" && entry.decision === "deny") m.denials += 1;
    }
    const activeDays = Math.max(1, m.days.size);
    const score = (m.merges * 3 + m.deploys * 2 + m.reviewsApproved - m.reviewsRejected - m.denials * 0.5) / activeDays;
    return { ...m, days: m.days.size, score: Math.round(score * 100) / 100 };
  }

  function versionMetrics() {
    const entries = readLog();
    const info = promptInfo();
    return (info?.history || []).map((item) => {
      const until = item.until || "9999";
      return { ...item, metrics: metricsFor(entries.filter((entry) => entry.t >= item.since && entry.t < until)) };
    });
  }

  function dailyMetrics(days = 7) {
    const entries = readLog();
    const out = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      out.push({ day, ...metricsFor(entries.filter((entry) => entry.t.startsWith(day))) });
    }
    return out;
  }

  // ---------- reviews ----------
  function parseVerdict(text) {
    const matches = String(text || "").match(/\{[^{}]*"verdict"[^{}]*\}/g);
    if (!matches) return null;
    try {
      const json = JSON.parse(matches[matches.length - 1]);
      if (!["approve", "reject"].includes(json.verdict)) return null;
      return { approve: json.verdict === "approve", reasons: (Array.isArray(json.reasons) ? json.reasons : []).map(String).slice(0, 8), testChangesOk: json.test_changes_ok === true };
    } catch {
      return null;
    }
  }

  function reviewPrompt(request, meta, diff) {
    return [
      "You are an independent code reviewer for an autonomous coding agent that merges and deploys without a human. Review this pull request strictly.",
      `Repository folder (read-only): ${request.cwd}`,
      `PR #${request.number}: ${meta.title || request.title || ""}`,
      meta.body ? `Description:\n${String(meta.body).slice(0, 4000)}` : "",
      "Approve only if all hold: the change does what the title/description says; no likely bugs or regressions; changed behaviour is covered by tests; no secrets or credentials; no weakening, skipping or deleting of tests, checks or lint rules to make things pass; no unrelated changes or scope creep; nothing destructive (data loss, irreversible migrations without a rollback path).",
      request.testEdits?.length
        ? `This PR modifies or deletes existing test code in: ${request.testEdits.join(", ")}. Set "test_changes_ok" to true only if those changes are legitimate (behaviour intentionally changed) and do not weaken coverage.`
        : 'There are no edits to existing tests; set "test_changes_ok" to true.',
      'You may read files in the repository for context. Do not modify anything. End your reply with exactly one line of JSON: {"verdict":"approve"|"reject","reasons":["short reason", ...],"test_changes_ok":true|false}',
      "Diff:",
      diff
    ].filter(Boolean).join("\n\n");
  }

  async function processReview(request) {
    const cfg = config();
    const repoArgs = request.repo ? ["--repo", request.repo] : [];
    const finish = (verdict) => {
      writeJSON(path.join(p.verdicts, `${request.key}.json`), { ...verdict, number: request.number, url: request.url, headOid: request.headOid, at: new Date().toISOString() });
      try {
        fs.rmSync(path.join(p.requests, `${request.key}.json`), { force: true });
      } catch {
        // ignore
      }
      logEvent({ space: request.space, event: "review", approve: verdict.approve, pr: request.url, head: request.headOid, reasons: verdict.reasons.slice(0, 4) });
      log(`Manager: review of ${request.url} → ${verdict.approve ? "approved" : "rejected"}`);
    };
    const diffResult = await gh(["pr", "diff", String(request.number), ...repoArgs], { cwd: request.cwd, timeout: 60000 });
    if (!diffResult.ok) return retryLater(request, `could not read the diff (${diffResult.stderr.trim().slice(0, 120)})`, finish);
    if (diffResult.stdout.length > MAX_DIFF_CHARS) return finish({ approve: false, reasons: [`The PR is too large to review safely (${Math.round(diffResult.stdout.length / 1000)}k characters of diff). Split it into smaller PRs.`], reviewers: [] });
    const metaResult = await gh(["pr", "view", String(request.number), ...repoArgs, "--json", "title,body,headRefOid"], { cwd: request.cwd, timeout: 60000 });
    const meta = readJSONText(metaResult.stdout) || {};
    if (meta.headRefOid && meta.headRefOid !== request.headOid) {
      // New commits since the request: the hook will queue a fresh review.
      fs.rmSync(path.join(p.requests, `${request.key}.json`), { force: true });
      return;
    }
    const promptFile = path.join(p.root, "reviews", `${request.key}.prompt.md`);
    fs.writeFileSync(promptFile, reviewPrompt(request, meta, diffResult.stdout));
    const reviewers = [];
    for (const model of cfg.reviewers) {
      const result = await droid(["exec", "-m", model, "-o", "json", "--cwd", request.cwd, "-f", promptFile], { cwd: request.cwd, timeout: 15 * 60 * 1000 });
      const json = readJSONText(result.stdout);
      const verdict = json && json.is_error === false ? parseVerdict(json.result) : null;
      if (!verdict) {
        fs.rmSync(promptFile, { force: true });
        return retryLater(request, `${model} returned no verdict${result.stderr ? ` (${result.stderr.trim().slice(0, 120)})` : ""}`, finish);
      }
      reviewers.push({ model, ...verdict });
    }
    fs.rmSync(promptFile, { force: true });
    const testsOk = !request.testEdits?.length || reviewers.every((item) => item.testChangesOk);
    const approve = reviewers.every((item) => item.approve) && testsOk;
    const reasons = reviewers.flatMap((item) => (item.approve ? [] : item.reasons.map((reason) => `${item.model.replace("custom:droidproxy:", "")}: ${reason}`)));
    if (!testsOk) reasons.push("Existing tests were changed or deleted without both reviewers confirming it is legitimate.");
    finish({ approve, reasons: approve ? [] : reasons.length ? reasons : ["Rejected by review."], reviewers });
  }

  function retryLater(request, why, finish) {
    const attempts = (request.attempts || 0) + 1;
    log(`Manager: review of ${request.url} failed (${why}); attempt ${attempts}/3`);
    if (attempts >= 3) return finish({ approve: false, reasons: [`The automatic review could not run (${why}). Retry later or simplify the PR.`], reviewers: [] });
    writeJSON(path.join(p.requests, `${request.key}.json`), { ...request, attempts, lastError: why, retryAfter: Date.now() + attempts * 5 * 60 * 1000 });
  }

  async function reviewTick() {
    if (reviewBusy) return;
    let files = [];
    try {
      files = fs.readdirSync(p.requests).filter((name) => name.endsWith(".json"));
    } catch {
      return;
    }
    const requests = files.map((name) => readJSON(path.join(p.requests, name), null)).filter((item) => item && item.key && (!item.retryAfter || item.retryAfter <= Date.now()));
    const next = requests.sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt)))[0];
    if (!next) return;
    if (fs.existsSync(path.join(p.verdicts, `${next.key}.json`))) {
      fs.rmSync(path.join(p.requests, `${next.key}.json`), { force: true });
      return;
    }
    reviewBusy = true;
    try {
      await processReview(next);
    } catch (error) {
      log(`Manager: review error (${error.message})`);
    } finally {
      reviewBusy = false;
    }
  }

  // ---------- retrospective (self-improvement) ----------
  function sharedFileTail(spaceId, name, chars = 6000) {
    for (const dir of [path.join(p.spaces, spaceId, "docs"), path.join(p.spaces, spaceId, "files")]) {
      try {
        const files = fs.readdirSync(dir);
        const match = files.find((file) => file.toLowerCase() === name.toLowerCase());
        if (match) return fs.readFileSync(path.join(dir, match), "utf8").slice(-chars);
      } catch {
        // missing
      }
    }
    return "";
  }

  // Rolls back the current prompt when it scores clearly worse than the one
  // before it, once it has enough activity to judge. Returns a note or null.
  function evaluatePrompt() {
    const info = promptInfo();
    const versions = versionMetrics();
    if (!info || versions.length < 2) return null;
    const current = versions[versions.length - 1];
    const previous = [...versions.slice(0, -1)].reverse().find((item) => !item.rolledBack);
    if (!previous || current.rolledBack) return null;
    const m = current.metrics;
    const enough = m.days >= 2 || m.reviewsApproved + m.reviewsRejected >= 6;
    if (!enough || previous.metrics.score <= 0) return null;
    if (m.score >= previous.metrics.score * 0.8) return null;
    const note = `Prompt v${current.version} scored ${m.score} vs ${previous.metrics.score} for v${previous.version}; rolled back to v${previous.version}.`;
    const history = (info.history || []).map((item) => (item.version === current.version && !item.until ? { ...item, rolledBack: true } : item));
    writeJSON(path.join(p.promptDir, "current.json"), { ...info, history });
    setPromptVersion(previous.version, "rollback", { rollbackOf: current.version });
    addLessons([{ text: `Changes introduced in prompt v${current.version} made results worse and were rolled back; prefer the v${previous.version} approach.`, evidence: note }], [], "rollback");
    logEvent({ event: "prompt", action: "rollback", from: current.version, to: previous.version, note });
    log(`Manager: ${note}`);
    return note;
  }

  function retroPrompt(cfg) {
    const info = promptInfo();
    const entries = readLog();
    const denials = entries.filter((entry) => entry.decision === "deny").slice(-40).map((entry) => `- ${entry.t.slice(0, 16)} ${entry.event}: ${entry.reason || ""}`).join("\n");
    const rejections = entries.filter((entry) => entry.event === "review" && !entry.approve).slice(-30).map((entry) => `- ${entry.pr}: ${(entry.reasons || []).join(" | ")}`).join("\n");
    const spaces = workstreams().filter((item) => item.managed);
    const shared = spaces.map((space) => [
      `## Workstream: ${space.title}`,
      `RUNLOG.md (tail):\n${sharedFileTail(space.id, "RUNLOG.md") || "(none)"}`,
      `DECISIONS.md (tail):\n${sharedFileTail(space.id, "DECISIONS.md", 3000) || "(none)"}`
    ].join("\n")).join("\n\n");
    const active = lessons().filter((lesson) => !lesson.retired);
    return [
      "You improve the operating instructions of an autonomous manager that runs Factory Workstreams unattended (it plans, delegates, merges through a gate that requires CI + two reviews, and deploys). Your goal: more merged and deployed useful work, fewer rejected reviews, fewer denied actions, no reverts.",
      "Hard limits, gates and budgets are enforced by code elsewhere. Do not mention, weaken or try to change them.",
      `Current prompt (v${info?.version}):\n<<<\n${promptText(info?.version)}\n>>>`,
      `Active lessons (id: text):\n${active.map((lesson) => `${lesson.id}: ${lesson.text}`).join("\n") || "(none)"}`,
      `Daily metrics (last 7 days):\n${JSON.stringify(dailyMetrics(7))}`,
      `Metrics per prompt version:\n${JSON.stringify(versionMetrics().map((item) => ({ version: item.version, since: item.since, until: item.until, rolledBack: item.rolledBack, metrics: item.metrics })))}`,
      `Recent denied actions:\n${denials || "(none)"}`,
      `Recent rejected reviews:\n${rejections || "(none)"}`,
      shared,
      [
        "Respond with reasoning, then end with exactly one JSON object on its own line:",
        '{"lessons_add":[{"text":"specific, actionable, under 200 characters","evidence":"what in the data shows this"}],"lessons_retire":["lesson id"],"prompt":null,"rationale":"one paragraph"}',
        "Rules: at most 5 new lessons, each backed by evidence above; retire lessons that are obsolete or contradicted. Set \"prompt\" to a complete new prompt only when the evidence shows a change in the operating loop would help; keep it under 6000 characters, keep the numbered-loop structure, and keep the final line protocol exactly (a reply ending with the line `MANAGER: IDLE`). Otherwise leave \"prompt\" null. Small, targeted edits beat rewrites."
      ].join("\n")
    ].join("\n\n");
  }

  function parseRetro(text) {
    const source = String(text || "");
    const start = source.lastIndexOf('{"lessons_add"');
    const candidates = start >= 0 ? [source.slice(start)] : (source.match(/\{[\s\S]*\}/g) || []).reverse();
    for (const candidate of candidates) {
      for (let end = candidate.length; end > 0; end = candidate.lastIndexOf("}", end - 1)) {
        try {
          const json = JSON.parse(candidate.slice(0, end + 1));
          if (json && Array.isArray(json.lessons_add)) return json;
        } catch {
          // keep shrinking
        }
        if (end <= 0) break;
      }
    }
    return null;
  }

  async function retrospective(reason = "scheduled") {
    if (retroBusy) return { ok: false, message: "A retrospective is already running." };
    retroBusy = true;
    try {
      ensurePrompt();
      const cfg = config();
      const rollback = evaluatePrompt();
      fs.mkdirSync(retroDir, { recursive: true });
      const promptFile = path.join(retroDir, `${stamp()}.prompt.md`);
      fs.writeFileSync(promptFile, retroPrompt(cfg));
      const result = await droid(["exec", "-m", cfg.retroModel, "-o", "json", "--cwd", p.root, "-f", promptFile], { cwd: p.root, timeout: 20 * 60 * 1000 });
      const json = readJSONText(result.stdout);
      const output = json && json.is_error === false ? parseRetro(json.result) : null;
      const record = { at: new Date().toISOString(), reason, model: cfg.retroModel, rollback, ok: Boolean(output) };
      if (!output) {
        record.error = (result.stderr || json?.result || "no JSON in the reply").slice(0, 400);
        writeJSON(path.join(retroDir, `${stamp()}.json`), record);
        logEvent({ event: "retro", ok: false, error: record.error });
        return { ok: false, message: `Retrospective failed: ${record.error}` };
      }
      const added = addLessons(output.lessons_add, output.lessons_retire, `retro ${record.at.slice(0, 10)}`);
      let newVersion = null;
      const text = typeof output.prompt === "string" ? output.prompt.trim() : "";
      if (text && text.length >= 200 && text.length <= 8000 && /MANAGER:\s*IDLE/.test(text)) {
        newVersion = (promptInfo()?.history || []).reduce((max, item) => Math.max(max, item.version), 0) + 1;
        fs.writeFileSync(path.join(p.promptDir, `v${newVersion}.md`), text + "\n");
        setPromptVersion(newVersion, "retrospective", { rationale: String(output.rationale || "").slice(0, 600) });
      }
      Object.assign(record, { added, retired: (output.lessons_retire || []).length, newVersion, rationale: String(output.rationale || "").slice(0, 1000) });
      writeJSON(path.join(retroDir, `${stamp()}.json`), record);
      fs.rmSync(promptFile, { force: true });
      logEvent({ event: "retro", ok: true, added, retired: record.retired, newVersion, rollback: Boolean(rollback) });
      const message = `Retrospective: ${added} lesson(s) added, ${record.retired} retired${newVersion ? `, prompt v${newVersion} activated` : ", prompt unchanged"}${rollback ? `; ${rollback}` : ""}.`;
      log(`Manager: ${message}`);
      return { ok: true, message };
    } finally {
      retroBusy = false;
    }
  }

  function lastRetro() {
    try {
      const files = fs.readdirSync(retroDir).filter((name) => name.endsWith(".json")).sort();
      return files.length ? readJSON(path.join(retroDir, files[files.length - 1]), null) : null;
    } catch {
      return null;
    }
  }

  async function retroTick() {
    const cfg = config();
    if (!cfg.enabled || !cfg.spaces.length) return;
    const now = new Date();
    if (now.getHours() < cfg.retroHour) return;
    const last = lastRetro();
    const lastDay = last ? new Date(last.at).toDateString() : "";
    if (lastDay === now.toDateString()) return;
    await retrospective("scheduled");
  }

  // ---------- state for the UI ----------
  function describe(entry) {
    const when = new Date(entry.t).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const what = {
      stop: entry.decision === "continue" ? `continued the loop${entry.full ? " (full prompt)" : ""}` : `let it rest: ${entry.reason || ""}`,
      merge: `merge ${entry.decision}${entry.pr ? ` ${entry.pr}` : ""}${entry.reason ? `: ${entry.reason}` : ""}`,
      deploy: `deploy ${entry.decision} ${entry.head ? entry.head.slice(0, 7) : ""}`,
      tool: `blocked: ${entry.reason || entry.tool || ""}`,
      review: `review ${entry.approve ? "approved" : "rejected"} ${entry.pr || ""}`,
      retro: entry.ok ? `retrospective: +${entry.added || 0} lessons${entry.newVersion ? `, prompt v${entry.newVersion}` : ""}` : `retrospective failed`,
      prompt: `prompt ${entry.action || ""} v${entry.from} → v${entry.to}`,
      error: `hook error: ${entry.message || ""}`
    }[entry.event] || entry.event;
    return `${when} · ${what}`;
  }

  function state() {
    ensurePrompt();
    const info = promptInfo();
    const titles = Object.fromEntries(workstreams().map((item) => [item.id, item.title]));
    let pending = 0;
    try {
      pending = fs.readdirSync(p.requests).filter((name) => name.endsWith(".json")).length;
    } catch {
      pending = 0;
    }
    return {
      status: status(),
      config: config(),
      workstreams: workstreams(),
      prompt: { version: info?.version, since: info?.since, text: promptText(info?.version), versions: versionMetrics().map((item) => ({ version: item.version, since: item.since, until: item.until, origin: item.origin, rolledBack: Boolean(item.rolledBack), score: item.metrics.score })) },
      lessons: lessons().filter((lesson) => !lesson.retired).map(({ id, text, origin, at }) => ({ id, text, origin, at })),
      today: dailyMetrics(1)[0],
      week: metricsFor(readLog().filter((entry) => entry.t >= new Date(Date.now() - 7 * 86400000).toISOString())),
      pendingReviews: pending,
      lastRetro: lastRetro(),
      activity: readLog(200).slice(-25).reverse().map((entry) => ({ text: describe(entry), space: titles[entry.space] || "" })),
      folder: p.root
    };
  }

  function start() {
    ensurePrompt();
    refreshInstalledHook();
    stop();
    timers = [setInterval(() => reviewTick().catch(() => {}), REVIEW_POLL_MS), setInterval(() => retroTick().catch((error) => log(`Manager: retrospective error (${error.message})`)), RETRO_POLL_MS)];
  }

  function stop() {
    for (const timer of timers) clearInterval(timer);
    timers = [];
  }

  return { config, saveConfig, install, uninstall, status, workstreams, state, start, stop, retrospective, reviewTick, evaluatePrompt, metricsFor, parseVerdict, parseRetro, addLessons, setPromptVersion, folder: p.root, paths: p };
}

function readJSONText(text) {
  try {
    return JSON.parse(String(text || "").trim());
  } catch {
    return null;
  }
}

module.exports = { createManager, BRIDGE_MARKER, DEFAULT_CONFIG };
