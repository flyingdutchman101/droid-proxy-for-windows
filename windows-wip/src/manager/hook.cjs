'use strict';
// DroidProxy Manager hook for Factory Workstreams.
//
// Installed by VeryCuteDroidProxy as ~/.factory/hooks/droidproxy-manager.cjs and
// registered for the Stop and PreToolUse events. It only acts on sessions that
// belong to a Workstream (a ~/.factory/spaces/<id>) the user enabled in the app,
// and only while the manager is switched on:
// - Stop (orchestrator only): keeps the managed loop going by returning the
//   manager instruction, until the orchestrator reports "MANAGER: IDLE", stops
//   quickly several times in a row, or the daily cap is reached.
// - PreToolUse: merges must pass CI plus two independent reviews run by the
//   app; deploys must be an allowed command on a clean, green base branch;
//   direct pushes to the base branch, destructive commands and any edit to the
//   manager's own files or Factory's hook config are denied.
// The rules live in this file and in config.json, which managed sessions can
// never write, so a self-edited prompt can steer the loop but not loosen it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const DEFAULT_LIMITS = {
  continuationsPerDay: 300,
  mergesPerDay: 20,
  deploysPerDay: 6,
  idleAfterQuickStops: 3,
  quickStopSeconds: 90,
  fullPromptEvery: 10
};
const IDLE_MARKER = /MANAGER:\s*IDLE/;
const EDIT_TOOLS = new Set(['Edit', 'Create', 'ApplyPatch', 'MultiEdit', 'Write', 'NotebookEdit']);
const DEPLOY_RE = /\b(?:vercel\b[^\n]*--prod|netlify\s+deploy\b[^\n]*--prod|fly(?:ctl)?\s+deploy|firebase\s+deploy|wrangler\s+(?:deploy|publish)|supabase\s+db\s+push|gcloud\s+[^\n]*\bdeploy\b|az\s+(?:webapp|functionapp)\s+deploy|npm\s+publish|pnpm\s+publish|yarn\s+npm\s+publish|eas\s+(?:submit|update)|railway\s+up|kubectl\s+(?:apply|rollout)|terraform\s+apply|serverless\s+deploy|sls\s+deploy)\b/i;
const DESTRUCTIVE_RE = /(?:\brm\s+-[a-z]*r[a-z]*f?\s+(?:\/(?:\s|$)|~|\$HOME|[a-z]:\\(?:\s|$))|\bgh\s+repo\s+delete\b|\bgit\s+push\b[^\n]*(?:\s--force\b|\s-f\b|\s--force-with-lease\b)|\bdrop\s+(?:database|schema)\b|\bgit\s+filter-(?:branch|repo)\b)/i;
const API_MERGE_RE = /\bgh\s+api\b[^\n]*\/(?:merges?|pulls\/\d+\/merge)\b/i;
const CI_PATH_RE = /^\.github\/workflows\//i;
const TEST_PATH_RE = /(?:^|\/)(?:tests?|__tests__|spec|specs|e2e)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:go|py)$|(?:^|\/)test_[^/]+\.py$/i;

function paths(home = os.homedir()) {
  const root = path.join(home, '.factory', 'droidproxy-manager');
  return {
    home,
    root,
    config: path.join(root, 'config.json'),
    state: path.join(root, 'state.json'),
    log: path.join(root, 'log.jsonl'),
    lessons: path.join(root, 'lessons.json'),
    promptDir: path.join(root, 'prompt'),
    requests: path.join(root, 'reviews', 'requests'),
    verdicts: path.join(root, 'reviews', 'verdicts'),
    factory: path.join(home, '.factory'),
    spaces: path.join(home, '.factory', 'spaces'),
    sessions: path.join(home, '.factory', 'sessions')
  };
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

function loadConfig(p) {
  const raw = readJSON(p.config, {});
  return {
    enabled: raw.enabled === true,
    spaces: Array.isArray(raw.spaces) ? raw.spaces.filter((id) => typeof id === 'string') : [],
    limits: { ...DEFAULT_LIMITS, ...(raw.limits || {}) },
    deployCommands: Array.isArray(raw.deployCommands) ? raw.deployCommands.filter((item) => typeof item === 'string' && item.trim()) : []
  };
}

// Which Workstream a session belongs to, and whether it is the orchestrator.
function findSession(sessionId, p) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  let spaces = [];
  try {
    spaces = fs.readdirSync(p.spaces);
  } catch {
    return null;
  }
  for (const spaceId of spaces) {
    const list = readJSON(path.join(p.spaces, spaceId, 'sessions', 'index.json'), null);
    if (!Array.isArray(list)) continue;
    const hit = list.find((item) => item && item.sessionId === sessionId);
    if (hit) return { spaceId, orchestrator: !hit.parentSessionId };
  }
  return null;
}

// Used by the guard bridge: true when the manager owns permission decisions
// for this session (manager on, session inside an enabled Workstream).
function isManagedSession(sessionId, home = os.homedir()) {
  try {
    const p = paths(home);
    const config = loadConfig(p);
    if (!config.enabled || !config.spaces.length) return false;
    const session = findSession(sessionId, p);
    return Boolean(session && config.spaces.includes(session.spaceId));
  } catch {
    return false;
  }
}

function log(p, entry) {
  try {
    fs.mkdirSync(p.root, { recursive: true });
    fs.appendFileSync(p.log, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    // Logging must never break the hook.
  }
}

const today = () => new Date().toISOString().slice(0, 10);

function spaceState(state, spaceId) {
  state.spaces = state.spaces || {};
  const entry = state.spaces[spaceId] || (state.spaces[spaceId] = {});
  if (entry.day !== today()) Object.assign(entry, { day: today(), continuations: 0, merges: 0, deploys: 0 });
  return entry;
}

function currentPrompt(p) {
  const current = readJSON(path.join(p.promptDir, 'current.json'), null);
  const version = Number(current?.version) || 0;
  let text = '';
  try {
    text = fs.readFileSync(path.join(p.promptDir, `v${version}.md`), 'utf8');
  } catch {
    text = '';
  }
  return { version, text };
}

function activeLessons(p) {
  const lessons = readJSON(p.lessons, []);
  return (Array.isArray(lessons) ? lessons : []).filter((item) => item && !item.retired && typeof item.text === 'string').slice(-30);
}

// Last assistant text in a session transcript (tail only).
function lastAssistantText(input, p) {
  const candidates = [];
  if (typeof input.transcript_path === 'string') candidates.push(input.transcript_path);
  try {
    for (const dir of fs.readdirSync(p.sessions)) candidates.push(path.join(p.sessions, dir, `${input.session_id}.jsonl`));
  } catch {
    // no sessions folder
  }
  const file = candidates.find((item) => {
    try {
      return fs.statSync(item).isFile();
    } catch {
      return false;
    }
  });
  if (!file) return '';
  const size = fs.statSync(file).size;
  const length = Math.min(size, 256 * 1024);
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(length);
  fs.readSync(fd, buffer, 0, length, size - length);
  fs.closeSync(fd);
  const lines = buffer.toString('utf8').split('\n').reverse();
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = entry?.message;
    if (message?.role !== 'assistant') continue;
    const content = Array.isArray(message.content) ? message.content : [];
    const text = content.filter((block) => block?.type === 'text').map((block) => block.text || '').join('\n').trim();
    if (text) return text;
  }
  return '';
}

function instruction(p, config, spaceState, full) {
  const prompt = currentPrompt(p);
  const lessons = activeLessons(p);
  const limits = config.limits;
  const status = `Today: ${spaceState.continuations}/${limits.continuationsPerDay} continuations, ${spaceState.merges}/${limits.mergesPerDay} merges, ${spaceState.deploys}/${limits.deploysPerDay} deploys.`;
  if (!full) {
    return [
      `DroidProxy Manager (prompt v${prompt.version}): continue the managed loop. Follow the manager instructions you were given; nobody is available to answer questions.`,
      status,
      'When nothing useful is left, end with the exact line: MANAGER: IDLE'
    ].join('\n');
  }
  return [
    `DroidProxy Manager · prompt v${prompt.version}. You are running unattended; the user is not available.`,
    prompt.text.trim() || 'Continue working through the Workstream backlog. When nothing useful is left, end with the exact line: MANAGER: IDLE',
    lessons.length ? `\nLessons from earlier runs (apply them):\n${lessons.map((item) => `- ${item.text}`).join('\n')}` : '',
    `\n${status}`,
    'Gates enforced by the manager (not negotiable): merges need green CI plus two independent reviews (a denied merge tells you why; fix it or retry later while doing other work); deploys only with an allowed deploy command from a clean, up-to-date, green base branch; no direct pushes to the base branch, no force pushes, no edits to CI workflows, hooks or the manager files.'
  ].filter(Boolean).join('\n');
}

function onStop(input, p, config, session) {
  if (!session.orchestrator) return null;
  const state = readJSON(p.state, {});
  const entry = spaceState(state, session.spaceId);
  const text = lastAssistantText(input, p);
  const now = Date.now();
  const finish = (reason) => {
    entry.quickStops = 0;
    writeJSON(p.state, state);
    log(p, { space: session.spaceId, session: input.session_id, event: 'stop', decision: 'allow', reason });
    return null;
  };
  if (IDLE_MARKER.test(text)) return finish('orchestrator reported idle');
  if (entry.continuations >= config.limits.continuationsPerDay) return finish('daily continuation cap reached');
  entry.quickStops = now - (entry.lastContinueAt || 0) < config.limits.quickStopSeconds * 1000 ? (entry.quickStops || 0) + 1 : 0;
  if (entry.quickStops >= config.limits.idleAfterQuickStops) return finish(`${entry.quickStops} quick stops in a row; waiting for the heartbeat`);

  const prompt = currentPrompt(p);
  const full = (entry.sent || 0) % config.limits.fullPromptEvery === 0 || entry.promptVersion !== prompt.version;
  entry.sent = (entry.sent || 0) + 1;
  entry.promptVersion = prompt.version;
  entry.continuations += 1;
  entry.lastContinueAt = now;
  writeJSON(p.state, state);
  log(p, { space: session.spaceId, session: input.session_id, event: 'stop', decision: 'continue', promptVersion: prompt.version, full });
  return { decision: 'block', reason: instruction(p, config, entry, full) };
}

function decision(kind, reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: kind, permissionDecisionReason: reason } };
}

function normalize(value) {
  return String(value || '').replace(/\\/g, '/').toLowerCase();
}

function protectedRoots(p) {
  return [p.root, path.join(p.factory, 'hooks'), path.join(p.factory, 'hooks.json'), path.join(p.factory, 'settings.json'), path.join(p.factory, 'instruction-refresh', 'config.json')].map(normalize);
}

function touchesProtected(text, p) {
  const haystack = normalize(text);
  const home = normalize(p.home);
  const variants = protectedRoots(p).flatMap((root) => [root, root.replace(home, '~'), root.replace(home, '$home'), root.replace(home, '%userprofile%')]);
  return variants.some((root) => haystack.includes(root)) || /(?:^|[\s"'/])\.factory\/(?:droidproxy-manager|hooks)\b/.test(haystack);
}

function defaultRun(command, args, cwd, timeout = 20000) {
  const result = cp.spawnSync(command, args, { cwd, encoding: 'utf8', timeout, windowsHide: true, shell: false });
  return { ok: result.status === 0 && !result.error, stdout: result.stdout || '', stderr: result.stderr || '', error: result.error };
}

// Swappable for tests.
let runner = defaultRun;
const run = (...args) => runner(...args);

function gitInfo(cwd) {
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd).stdout.trim();
  let base = run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd).stdout.trim().replace(/^origin\//, '');
  if (!base) base = ['main', 'master'].find((name) => run('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`], cwd).ok) || 'main';
  return { branch, base };
}

// Splits a shell command into rough words (quotes respected).
function words(command) {
  return (String(command).match(/"[^"]*"|'[^']*'|\S+/g) || []).map((item) => item.replace(/^["']|["']$/g, ''));
}

function pushesToBase(command, cwd) {
  if (!/\bgit\s+push\b/i.test(command)) return false;
  const { branch, base } = gitInfo(cwd);
  const args = words(command.slice(command.search(/\bgit\s+push\b/i))).slice(2).filter((item) => !item.startsWith('-'));
  const refspecs = args.slice(1);
  if (!refspecs.length) return branch === base;
  return refspecs.some((spec) => {
    const target = spec.includes(':') ? spec.split(':').pop() : spec;
    return target.replace(/^refs\/heads\//, '') === base;
  });
}

function mergeTarget(command) {
  const match = command.match(/\bgh\s+pr\s+merge\b([^\n;&|]*)/i);
  if (!match) return null;
  const args = words(match[1]);
  const repoIndex = args.findIndex((item) => item === '--repo' || item === '-R');
  const repo = repoIndex >= 0 ? args[repoIndex + 1] : null;
  const valueFlags = new Set(['--repo', '-R', '--subject', '-t', '--body', '-b', '--body-file', '-F', '--author-email', '-A', '--match-head-commit']);
  const positional = args.filter((item, index) => !item.startsWith('-') && !valueFlags.has(args[index - 1]));
  return { ref: positional[0] || '', repo };
}

function reviewKey(url, headOid) {
  return crypto.createHash('sha256').update(`${url}\0${headOid}`).digest('hex').slice(0, 32);
}

function gateMerge(input, p, config, session, target) {
  const cwd = input.cwd || process.cwd();
  const state = readJSON(p.state, {});
  const entry = spaceState(state, session.spaceId);
  if (entry.merges >= config.limits.mergesPerDay) return decision('deny', `DroidProxy Manager: daily merge cap (${config.limits.mergesPerDay}) reached. Keep PRs open; they can be merged tomorrow.`);
  const args = ['pr', 'view'];
  if (target.ref) args.push(target.ref);
  if (target.repo) args.push('--repo', target.repo);
  args.push('--json', 'number,url,headRefOid,baseRefName,isDraft,mergeable,statusCheckRollup,files,title');
  const view = run('gh', args, cwd, 30000);
  if (!view.ok) return decision('deny', `DroidProxy Manager: could not read the PR (${(view.stderr || String(view.error || '')).trim().slice(0, 200)}). Merge with an explicit PR number from the repository folder.`);
  let pr;
  try {
    pr = JSON.parse(view.stdout);
  } catch {
    return decision('deny', 'DroidProxy Manager: unreadable PR details; try again.');
  }
  if (pr.isDraft) return decision('deny', `DroidProxy Manager: PR #${pr.number} is a draft. Mark it ready first.`);
  if (pr.mergeable === 'CONFLICTING') return decision('deny', `DroidProxy Manager: PR #${pr.number} has merge conflicts. Rebase or merge the base branch, push, then retry.`);
  const files = Array.isArray(pr.files) ? pr.files : [];
  const ciEdits = files.filter((file) => CI_PATH_RE.test(file.path || ''));
  if (ciEdits.length) return decision('deny', `DroidProxy Manager: PR #${pr.number} changes CI workflows (${ciEdits.map((file) => file.path).join(', ')}). CI changes are never merged unattended; leave this PR for the user and continue with other work.`);
  const checks = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
  const pending = checks.filter((check) => (check.status && check.status !== 'COMPLETED') || ['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS'].includes(check.state));
  const failing = checks.filter((check) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(check.conclusion || check.state));
  if (pending.length) return decision('deny', `DroidProxy Manager: CI is still running on PR #${pr.number} (${pending.length} check(s)). Do other work and retry the merge later.`);
  if (failing.length) return decision('deny', `DroidProxy Manager: CI is failing on PR #${pr.number}: ${failing.map((check) => check.name || check.context).join(', ')}. Fix it and push.`);

  fs.mkdirSync(p.verdicts, { recursive: true });
  const key = reviewKey(pr.url, pr.headRefOid);
  const verdict = readJSON(path.join(p.verdicts, `${key}.json`), null);
  if (!verdict) {
    const requestFile = path.join(p.requests, `${key}.json`);
    if (!fs.existsSync(requestFile)) {
      writeJSON(requestFile, {
        key,
        space: session.spaceId,
        cwd,
        repo: target.repo,
        number: pr.number,
        url: pr.url,
        title: pr.title,
        headOid: pr.headRefOid,
        base: pr.baseRefName,
        testEdits: files.filter((file) => TEST_PATH_RE.test(file.path || '') && Number(file.deletions) > 0).map((file) => file.path),
        checks: checks.length,
        requestedAt: new Date().toISOString()
      });
      log(p, { space: session.spaceId, session: input.session_id, event: 'merge', decision: 'review-queued', pr: pr.url, head: pr.headRefOid });
    }
    return decision('deny', `DroidProxy Manager: two independent reviews of PR #${pr.number} (head ${String(pr.headRefOid).slice(0, 7)}) are queued. Continue with other work and retry this merge in about 10 minutes. Pushing new commits restarts the review.`);
  }
  if (!verdict.approve) {
    log(p, { space: session.spaceId, session: input.session_id, event: 'merge', decision: 'deny', reason: 'review rejected', pr: pr.url });
    return decision('deny', `DroidProxy Manager: the reviews rejected PR #${pr.number}:\n${(verdict.reasons || []).map((reason) => `- ${reason}`).join('\n')}\nAddress these, push (that triggers a new review), then retry.`);
  }
  entry.merges += 1;
  writeJSON(p.state, state);
  log(p, { space: session.spaceId, session: input.session_id, event: 'merge', decision: 'allow', pr: pr.url, head: pr.headRefOid, checks: checks.length });
  return decision('allow', `DroidProxy Manager: PR #${pr.number} passed CI${checks.length ? '' : ' (no checks configured)'} and both reviews.`);
}

function matchesAllowedDeploy(command, config) {
  return config.deployCommands.some((pattern) => {
    try {
      return new RegExp(pattern, 'i').test(command);
    } catch {
      return command.toLowerCase().includes(pattern.toLowerCase());
    }
  });
}

function gateDeploy(input, p, config, session, command) {
  const cwd = input.cwd || process.cwd();
  if (!matchesAllowedDeploy(command, config)) {
    return decision('deny', 'DroidProxy Manager: this deploy command is not on the allowed list in DroidProxy → Manager. Skip the deploy and note it in RUNLOG.md for the user.');
  }
  const state = readJSON(p.state, {});
  const entry = spaceState(state, session.spaceId);
  if (entry.deploys >= config.limits.deploysPerDay) return decision('deny', `DroidProxy Manager: daily deploy cap (${config.limits.deploysPerDay}) reached.`);
  const { branch, base } = gitInfo(cwd);
  if (branch !== base) return decision('deny', `DroidProxy Manager: deploy only from the base branch (${base}); this folder is on ${branch}.`);
  if (run('git', ['status', '--porcelain'], cwd).stdout.trim()) return decision('deny', 'DroidProxy Manager: the working tree has uncommitted changes; deploy only a clean checkout of the base branch.');
  run('git', ['fetch', '--quiet', 'origin', base], cwd, 30000);
  const head = run('git', ['rev-parse', 'HEAD'], cwd).stdout.trim();
  const remote = run('git', ['rev-parse', `origin/${base}`], cwd).stdout.trim();
  if (!head || head !== remote) return decision('deny', `DroidProxy Manager: local ${base} is not the same commit as origin/${base}; pull first.`);
  const runs = run('gh', ['run', 'list', '--commit', head, '--json', 'status,conclusion,name', '--limit', '30'], cwd, 30000);
  let list = [];
  try {
    list = JSON.parse(runs.stdout || '[]');
  } catch {
    list = [];
  }
  if (!runs.ok) return decision('deny', 'DroidProxy Manager: could not read CI status for the base branch; retry later.');
  if (!list.length) return decision('deny', `DroidProxy Manager: no CI runs found for ${head.slice(0, 7)} on ${base}; deploys need a green CI run on that commit.`);
  if (list.some((item) => item.status !== 'completed')) return decision('deny', 'DroidProxy Manager: CI is still running on the base branch; retry the deploy later.');
  const bad = list.filter((item) => !['success', 'skipped', 'neutral'].includes(item.conclusion));
  if (bad.length) return decision('deny', `DroidProxy Manager: CI on ${base} is not green (${bad.map((item) => item.name).join(', ')}). Fix or revert before deploying.`);
  entry.deploys += 1;
  writeJSON(p.state, state);
  log(p, { space: session.spaceId, session: input.session_id, event: 'deploy', decision: 'allow', head, command: command.slice(0, 200) });
  return decision('allow', `DroidProxy Manager: deploying ${head.slice(0, 7)} from a green ${base}.`);
}

function nativeTool(name) {
  return String(name || '').replace(/^.*__/, '');
}

function onPreToolUse(input, p, config, session) {
  const tool = nativeTool(input.tool_name);
  const toolInput = input.tool_input || {};
  const deny = (reason, detail) => {
    log(p, { space: session.spaceId, session: input.session_id, event: 'tool', decision: 'deny', tool, reason: detail || reason.slice(0, 160) });
    return decision('deny', reason);
  };
  if (EDIT_TOOLS.has(tool)) {
    const target = toolInput.file_path ?? toolInput.path ?? toolInput.notebook_path ?? '';
    const text = `${target}\n${toolInput.patch ?? toolInput.input ?? ''}`;
    if (touchesProtected(text, p)) return deny('DroidProxy Manager: the manager files, Factory hooks and Factory settings cannot be edited from a managed Workstream.', 'protected file edit');
    return null;
  }
  if (['CreateAutomation', 'EditAutomation', 'RunAutomation'].includes(tool)) {
    return decision('allow', 'DroidProxy Manager: automations are allowed in managed Workstreams (used for the heartbeat).');
  }
  if (tool !== 'Execute') return null;
  const command = String(toolInput.command || '');
  if (touchesProtected(command, p)) return deny('DroidProxy Manager: commands that touch the manager files, Factory hooks or Factory settings are not allowed from a managed Workstream.', 'protected path command');
  if (DESTRUCTIVE_RE.test(command)) return deny('DroidProxy Manager: destructive command blocked (force push, recursive delete of a root, repo deletion, history rewrite or dropping a database).', 'destructive command');
  if (API_MERGE_RE.test(command)) return deny('DroidProxy Manager: merge through `gh pr merge <number>` so the merge gate can check it.', 'api merge');
  const cwd = input.cwd || process.cwd();
  if (pushesToBase(command, cwd)) return deny('DroidProxy Manager: no direct pushes to the base branch. Push a feature branch and open a PR.', 'push to base');
  const target = mergeTarget(command);
  if (target) return gateMerge(input, p, config, session, target);
  if (DEPLOY_RE.test(command) || matchesAllowedDeploy(command, config)) return gateDeploy(input, p, config, session, command);
  // Everything else follows the Workstream's own autonomy level.
  return null;
}

function handle(input, home = os.homedir()) {
  const p = paths(home);
  const config = loadConfig(p);
  if (!config.enabled || !config.spaces.length) return null;
  const session = findSession(input.session_id, p);
  if (!session || !config.spaces.includes(session.spaceId)) return null;
  if (input.hook_event_name === 'Stop') return onStop(input, p, config, session);
  if (input.hook_event_name === 'PreToolUse') return onPreToolUse(input, p, config, session);
  return null;
}

function main(raw, home = os.homedir()) {
  let input = null;
  try {
    input = JSON.parse(raw);
    const result = handle(input, home);
    return result ? JSON.stringify(result) + '\n' : '';
  } catch (error) {
    const p = paths(home);
    log(p, { event: 'error', session: input?.session_id, message: String(error?.message || error).slice(0, 300) });
    // Fail closed for merges and deploys in managed sessions; everything else proceeds.
    const command = String(input?.tool_input?.command || '');
    if (input?.hook_event_name === 'PreToolUse' && isManagedSession(input.session_id, home) && (/\bgh\s+pr\s+merge\b/i.test(command) || DEPLOY_RE.test(command))) {
      return JSON.stringify(decision('deny', `DroidProxy Manager could not check this action (${String(error?.message || error).slice(0, 120)}); retry later.`)) + '\n';
    }
    return '';
  }
}

module.exports = { setRunner: (fn) => { runner = fn || defaultRun; }, main, handle, isManagedSession, findSession, paths, loadConfig, mergeTarget, pushesToBase, reviewKey, touchesProtected, lastAssistantText, DEFAULT_LIMITS, DEPLOY_RE, DESTRUCTIVE_RE, TEST_PATH_RE };

if (require.main === module) {
  const out = main(fs.readFileSync(0, 'utf8'));
  if (out) process.stdout.write(out);
}
