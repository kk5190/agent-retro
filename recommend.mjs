/**
 * recommend.mjs — deterministic recommendations from telemetry.
 *
 * Each rule reads the rollup (analysis), the session records and the user's Claude Code
 * config, and fires only when its evidence clears a threshold. A recommendation says what
 * was observed, what to change, and — where the change is mechanical — gives a fix to paste:
 *   { id, level: high|medium|low, title, evidence, action, fix?: { kind, target, content }, personal?, task? }
 * A rule returns one recommendation, several (playbooks: one per task), or null.
 * `personal` marks recommendations whose evidence or fix quotes prompts or project paths.
 * fix.kind: settings (JSON to merge into target), shell (commands), file (create target),
 * claude-md (a line for CLAUDE.md), manual (steps in an app).
 *
 * Rules never write anything; they only suggest.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mcpKey, toolBucket } from './sessions.mjs';

const HOME = () => process.env.AGENT_RETRO_HOME || os.homedir();
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const tilde = (p) => String(p).replace(HOME(), '~');

/** The parts of the user's Claude Code config the rules need to write correct fixes. */
export function readClaudeConfig() {
  const home = HOME();
  const settings = readJson(path.join(home, '.claude', 'settings.json')) || {};
  const global = readJson(path.join(home, '.claude.json')) || {};
  const projectMcp = {};
  for (const [dir, p] of Object.entries(global.projects || {})) for (const name of Object.keys((p && p.mcpServers) || {})) (projectMcp[mcpKey(name)] = projectMcp[mcpKey(name)] || []).push(dir);
  const skillDir = path.join(home, '.claude', 'skills');
  return {
    enabledPlugins: settings.enabledPlugins || {},
    permissions: settings.permissions || {},
    userMcp: Object.fromEntries(Object.keys(global.mcpServers || {}).map((n) => [mcpKey(n), n])),
    projectMcp,
    userSkills: new Set((() => { try { return fs.readdirSync(skillDir); } catch { return []; } })()),
  };
}

const LEVEL = { high: 0, medium: 1, low: 2 };

/** The trend metric (sessions.mjs TREND_METRICS) each recommendation is meant to move. */
export const REC_METRIC = { 'unused-plugins': 'listingTokensPerSession', 'unused-skills': 'listingTokensPerSession', 'unused-mcp': 'listingTokensPerSession', screenshots: 'browserOutputShare', 'context-pressure': 'highContextShare', 'check-ins': 'ackRate', secrets: 'sensitivePerSession', 'flaky-tools': 'toolErrorRate' };
const sum = (arr, f) => arr.reduce((x, v) => x + f(v), 0);
const pct = (x) => Math.round(100 * x);
const k = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n));
const MIN_SESSIONS = 3;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const ext = (analysis) => analysis.extensions || { plugins: [], skills: [], mcpServers: [], hooks: [], commands: [] };
/** Idle and still installed: never used, listed in enough sessions, and seen in the last two weeks. */
const idleNow = (x) => x.verdict === 'unused' && x.current && x.sessionsLoaded >= MIN_SESSIONS;

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------
function unusedPlugins({ analysis, config }) {
  const E = ext(analysis);
  const idle = E.plugins.filter(idleNow).sort((a, b) => b.listingTokens - a.listingTokens);
  if (!idle.length) return null;
  const tokens = sum(idle, (p) => p.listingTokens);
  const known = idle.map((p) => p.enabledKey).filter(Boolean);
  const elsewhere = idle.filter((p) => !p.enabledKey).map((p) => p.name);
  return {
    id: 'unused-plugins', level: tokens >= 1500 ? 'high' : 'medium',
    title: `Disable ${plural(idle.length, 'plugin')} you never use`,
    evidence: `${idle.map((p) => `${p.name} (${plural(p.skillsListed, 'skill')}${p.mcpServers.length ? `, ${plural(p.mcpServers.length, 'MCP server')}` : ''}, listed in ${p.sessionsLoaded} sessions)`).join('; ')}. None of it was used. Their skill listings add about ${k(tokens)} tokens to every session.`,
    action: 'Disable them; re-enable any time with /plugin.'
      + (elsewhere.length ? ` ${elsewhere.join(', ')} ${elsewhere.length === 1 ? 'is' : 'are'} not in ~/.claude/settings.json, so ${elsewhere.length === 1 ? 'it is' : 'they are'} enabled by a project or another settings file: disable ${elsewhere.length === 1 ? 'it' : 'them'} with /plugin.` : ''),
    fix: known.length
      ? { kind: 'settings', target: '~/.claude/settings.json', content: JSON.stringify({ enabledPlugins: Object.fromEntries(known.map((key) => [key, false])) }, null, 2) }
      : { kind: 'manual', target: 'Claude Code', content: `Run /plugin and disable: ${elsewhere.join(', ')}` },
  };
}

function unusedSkills({ analysis, config }) {
  const idle = ext(analysis).skills.filter((x) => !x.plugin && idleNow(x) && config.userSkills.has(x.name));
  if (!idle.length) return null;
  const tokens = sum(idle, (x) => x.listingTokens);
  return {
    id: 'unused-skills', level: tokens >= 1500 ? 'high' : tokens >= 300 ? 'medium' : 'low',
    title: `Park ${plural(idle.length, 'personal skill')} you never use`,
    evidence: `${idle.map((x) => x.name).join(', ')}: listed in up to ${Math.max(...idle.map((x) => x.sessionsLoaded))} sessions, never used. Their descriptions add about ${k(tokens)} tokens to every session.`,
    action: 'Move them out of ~/.claude/skills. Moving (not deleting) keeps them one command away.',
    fix: { kind: 'shell', target: 'terminal', content: ['mkdir -p ~/.claude/skills-parked', ...idle.map((x) => `mv ~/.claude/skills/${JSON.stringify(x.name).slice(1, -1)} ~/.claude/skills-parked/`)].join('\n') },
  };
}

function unusedMcp({ analysis, config }) {
  const idle = ext(analysis).mcpServers.filter(idleNow);
  const steps = []; const names = [];
  for (const m of idle) {
    if (m.source === 'user') { steps.push(`claude mcp remove ${config.userMcp[m.key]} -s user`); names.push(m.name); }
    else if (m.source === 'project') { for (const dir of config.projectMcp[m.key]) steps.push(`(cd ${JSON.stringify(tilde(dir))} && claude mcp remove ${m.name} -s local)`); names.push(m.name); }
    else if (m.source === 'claude.ai') { steps.push(`# ${m.name}: a claude.ai connector — turn it off at claude.ai → Settings → Connectors`); names.push(m.name); }
  }
  if (!names.length) return null;
  return {
    id: 'unused-mcp', level: 'medium', personal: idle.some((m) => m.source === 'project'),
    title: `Remove ${plural(names.length, 'MCP server')} you never call`,
    evidence: `${names.join(', ')}: connected in ${MIN_SESSIONS}+ sessions each, never called. Each connected server starts with every session, can fail to connect, and adds its tools to the context once they are loaded.`,
    action: 'Remove the ones you do not need; add them back per project when you do.',
    fix: { kind: 'shell', target: 'terminal', content: steps.join('\n') },
  };
}

function heavySkills({ analysis }) {
  const heavy = ext(analysis).skills.filter((x) => x.tokensPerLoad >= 8000 && x.uses).sort((a, b) => b.tokensPerLoad - a.tokensPerLoad);
  if (!heavy.length) return null;
  return {
    id: 'heavy-skills', level: 'low',
    title: `Slim down ${plural(heavy.length, 'skill')} that load${heavy.length === 1 ? 's' : ''} a lot of context`,
    evidence: heavy.map((x) => `${x.name}: about ${k(x.tokensPerLoad)} tokens each time it loads (${plural(x.uses, 'use')})`).join('; ') + '. That text stays in the context for the rest of the session.',
    action: 'Move reference material out of SKILL.md into separate files the skill reads only when needed, so the always-loaded part stays short.',
  };
}

function heavyHooks({ analysis }) {
  const hooks = ext(analysis).hooks;
  const heavy = hooks.filter((h) => h.tokensPerSession >= 1000 || (h.p90Ms != null && h.p90Ms >= 1000));
  if (!heavy.length) return null;
  const tokens = sum(hooks, (h) => h.tokensPerSession);
  return {
    id: 'heavy-hooks', level: tokens >= 3000 ? 'medium' : 'low',
    title: 'Check what your hooks add to every session',
    evidence: heavy.map((h) => `${h.name}: ${h.tokensPerSession >= 1000 ? `about ${k(h.tokensPerSession)} tokens per session` : ''}${h.tokensPerSession >= 1000 && h.p90Ms >= 1000 ? ', ' : ''}${h.p90Ms >= 1000 ? `p90 ${(h.p90Ms / 1000).toFixed(1)} s per run` : ''}`).join('; ') + `. All hooks together inject about ${k(tokens)} tokens per session.`,
    action: 'Keep hook output short, scope tool hooks with a matcher, and disable plugins whose hooks you do not need. Everything a hook prints goes into the context.',
  };
}

function screenshots({ analysis }) {
  const out = Object.entries((analysis.contextBreakdown || {}).toolOutputByTool || {});
  const total = sum(out, ([, v]) => v);
  const browser = sum(out.filter(([name]) => toolBucket(name) === 'browser'), ([, v]) => v);
  if (!total || browser / total < 0.3 || browser < 20000) return null;
  return {
    id: 'screenshots', level: browser / total >= 0.5 ? 'high' : 'medium',
    title: 'Read pages as text instead of screenshots',
    evidence: `Browser tools (screenshots and page captures) returned ${pct(browser / total)}% of all tool output, about ${k(browser)} tokens. A single screenshot costs around 1.5k tokens of context.`,
    action: 'When the agent only needs page content or structure, have it read the page text or accessibility tree, and keep screenshots for visual checks.',
    fix: { kind: 'claude-md', target: '~/.claude/CLAUDE.md', content: '- In the browser, read page text or the accessibility tree to inspect content. Take a screenshot only to check visual layout, and at reduced scale when available.' },
  };
}

function contextPressure({ analysis }) {
  const cx = analysis.context || {};
  if (!cx.turns || cx.highTurns / cx.turns < 0.3) return null;
  const cb = analysis.contextBreakdown || {};
  return {
    id: 'context-pressure', level: 'high',
    title: 'Start fresh or compact between tasks',
    evidence: `${pct(cx.highTurns / cx.turns)}% of turns carried more than 150k tokens of context (median ${k(cx.median)}, peak ${k(cx.max)}); ${cb.compactions || 0} compactions. Every turn re-sends the whole context.`,
    action: 'Use /clear when switching to an unrelated task and /compact at natural breakpoints. Hand broad searches to a subagent so only its summary enters your conversation.',
    fix: { kind: 'claude-md', target: '~/.claude/CLAUDE.md', content: '- For broad codebase searches or research, delegate to a subagent and bring back only a summary.' },
  };
}

function checkIns({ sessions }) {
  const human = sum(sessions, (s) => s.turns.human);
  const acks = sum(sessions, (s) => s.turns.ack);
  if (human < 30 || acks / human < 0.12) return null;
  return {
    id: 'check-ins', level: 'medium',
    title: 'Cut the “continue?” check-ins',
    evidence: `${acks} of ${human} prompts (${pct(acks / human)}%) were just “yes”, “continue”, “ok” or similar — the agent stopped and waited for a go-ahead it did not need.`,
    action: 'Tell the agent to keep going through an approved plan and only stop for decisions.',
    fix: { kind: 'claude-md', target: '~/.claude/CLAUDE.md', content: '- Once I approve a plan, carry it out to the end without pausing for confirmation between steps. Stop only for a decision you cannot make from the plan, or before anything destructive.' },
  };
}

const ACK_START = /^(yes|yep|yeah|ok|okay|continue|go|sure|no|nope|y|n|\d+)\b/i;
function repeatedPrompts({ sessions }) {
  const counts = new Map();
  for (const s of sessions) for (const p of s._prompts || []) {
    const t = p.trim().replace(/\s+/g, ' ');
    if (t.length < 15 || t.length > 600 || ACK_START.test(t) || t.startsWith('/')) continue;
    const key = t.toLowerCase();
    const c = counts.get(key) || { text: t, n: 0 };
    c.n++; counts.set(key, c);
  }
  const top = [...counts.values()].filter((c) => c.n >= 3).sort((a, b) => b.n - a.n).slice(0, 3);
  if (!top.length) return null;
  const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 4).join('-') || 'prompt';
  return {
    id: 'repeated-prompts', level: 'low', personal: true,
    title: `Save ${top.length === 1 ? 'a prompt you repeat' : `${top.length} prompts you repeat`} as slash commands`,
    evidence: top.map((c) => `“${c.text.length > 80 ? c.text.slice(0, 79) + '…' : c.text}” ×${c.n}`).join('; '),
    action: 'A custom command turns each into a short /name you can also refine once and reuse.',
    fix: { kind: 'file', target: top.map((c) => `~/.claude/commands/${slug(c.text)}.md`).join(', '), content: top.map((c) => `# ~/.claude/commands/${slug(c.text)}.md\n${c.text}`).join('\n\n') },
  };
}

function secrets({ analysis, config }) {
  const r = analysis.risk || {};
  if (!r.sensitiveAccess) return null;
  const deny = new Set(config.permissions.deny || []);
  const rules = ['Read(./.env)', 'Read(./.env.*)', 'Read(~/.ssh/**)', 'Read(~/.aws/**)'].filter((x) => !deny.has(x));
  if (!rules.length) return null;
  return {
    id: 'secrets', level: 'high',
    title: 'Block the agent from reading secrets',
    evidence: `${plural(r.sensitiveAccess, 'tool call')} touched .env files, keys or ~/.ssh. Anything the agent reads is sent to the model and kept in your logs.`,
    action: 'Add deny rules for secret files. They stop the Read tool; shell commands like cat need a PreToolUse hook as well.',
    fix: { kind: 'settings', target: '~/.claude/settings.json', content: JSON.stringify({ permissions: { deny: rules } }, null, 2) },
  };
}

/** What to do about a tool that keeps failing, by the most common reason. */
const ERROR_ADVICE = {
  'invalid-input': ['The agent keeps calling it with wrong arguments or in the wrong order.', (t) => `- ${t}: check the tool's required order before calling it (for example, read the page before clicking by reference), and validate arguments against its schema.`],
  timeout: ['Calls to it keep timing out.', (t) => `- ${t} tends to time out: wait for pages to finish loading, keep each call small, and retry once before switching approach.`],
  'not-found': ['It keeps acting on things that are no longer there (closed tabs, missing files, moved pages).', (t) => `- Before using ${t}, re-check the current state (open tabs, file paths) instead of reusing old references.`],
  environment: ['The environment keeps getting in the way: ports in use, missing binaries, servers that fail to start.', (t) => `- Before starting a dev server or preview with ${t}, check whether one is already running and reuse it.`],
  'command-failed': ['Commands exit with errors: often a failing build or test that then needs another round.', () => '- When a command fails, read its full output and fix the cause before re-running it.'],
};
function flakyTools({ sessions }) {
  const calls = {}, errs = {}, classes = {};
  const group = (name) => { const m = /^mcp__(.+?)__/.exec(name); return m ? m[1] : name; };
  for (const s of sessions) {
    for (const [name, n] of Object.entries(s.tools.byName)) calls[group(name)] = (calls[group(name)] || 0) + n;
    for (const [name, n] of Object.entries(s.tools.errorsByTool)) errs[group(name)] = (errs[group(name)] || 0) + n;
    for (const [name, cls] of Object.entries(s._toolErrClass || {})) for (const [c, n] of Object.entries(cls)) ((classes[group(name)] = classes[group(name)] || {})[c] = (classes[group(name)][c] || 0) + n);
  }
  const bad = Object.entries(errs).map(([g, e]) => [g, e, calls[g] || 0]).filter(([, e, c]) => e >= 10 && c && e / c >= 0.08).sort((a, b) => b[1] - a[1]);
  if (!bad.length) return null;
  const [tool, e, c] = bad[0];
  const topClass = Object.entries(classes[tool] || {}).filter(([cls]) => ERROR_ADVICE[cls]).sort((a, b) => b[1] - a[1])[0];
  const [why, line] = topClass ? ERROR_ADVICE[topClass[0]] : ['', null];
  return {
    id: 'flaky-tools', level: e / c >= 0.15 ? 'medium' : 'low',
    title: `Make ${tool} fail less`,
    evidence: `${tool} failed ${e} of ${c} calls (${pct(e / c)}%).${bad.length > 1 ? ` Also failing often: ${bad.slice(1, 3).map(([g, x, y]) => `${g} ${pct(x / y)}%`).join(', ')}.` : ''} ${why}`.trim(),
    action: 'Each failed call is a wasted turn and more context. Give the agent a rule for the pattern that keeps failing.',
    ...(line && { fix: { kind: 'claude-md', target: '~/.claude/CLAUDE.md', content: line(tool) } }),
  };
}

function workflowCommand({ analysis }) {
  const w = (analysis.workflows || []).find((x) => x.sessions >= 3);
  if (!w) return null;
  const slug = w.steps.slice(0, 3).join('-').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return {
    id: 'workflow-command', level: 'low', personal: true,
    title: 'Turn a sequence you repeat into one command',
    evidence: `${w.steps.join(' → ')} ran in ${w.sessions} sessions (${w.runs} times). Each time, the agent works out the same steps again.`,
    action: 'Save the sequence as a slash command so it runs the same way every time. Fill in the exact flags you use.',
    fix: { kind: 'file', target: `~/.claude/commands/${slug}.md`, content: `Run these steps in order and stop at the first failure, reporting its output:\n${w.steps.map((x, i) => `${i + 1}. \`${x}\``).join('\n')}` },
  };
}

// ---------------------------------------------------------------------------
// Per-task playbooks — how the recurring kinds of work are done well
// ---------------------------------------------------------------------------
const shellRan = (s, re) => (s._shellCmds || []).some((c) => re.test(c));
const usedSkill = (s, re) => [...Object.keys(s.skills), ...Object.keys(s.commands), ...Object.keys(s.subagents.types)].some((k) => re.test(k));
const usedTool = (s, re) => Object.keys(s.tools.byName).some((k) => re.test(k));

/**
 * One row per task. A practice is a check on one session; the rule reports practices that fewer
 * than half of that task's sessions followed. Rows are data: add a task by adding a row.
 */
export const PLAYBOOKS = {
  'code-review': {
    practices: [
      ['Fetch the change with a tool (gh pr diff, git diff), not by pasting it', (s) => shellRan(s, /\bgh pr (diff|view)\b|\bgit (diff|show)\b|\bdifft\b/)],
      ['Use a review skill or subagent for a structured second pass', (s) => usedSkill(s, /review/i)],
      ['Run the tests as part of the review', (s) => s.signals.testRuns > 0],
    ],
    tools: ['gh pr diff <number> pulls the exact change', 'difft shows structural diffs and ignores formatting noise', 'a code-review skill or reviewer subagent for a checklist pass'],
    steps: ['Fetch the change: `gh pr diff $ARGUMENTS` (or `git diff main...HEAD`).', 'Read the diff and the files it touches before judging it.', 'Run the tests that cover the changed code.', 'Report findings ranked by severity: correctness, security, then readability. Cite file:line for each.'],
  },
  debugging: {
    practices: [
      ['Reproduce the failure (run the failing command or test) before the first edit', (s) => s._firstRun != null && (s._firstEdit == null || s._firstRun < s._firstEdit)],
      ['Converge within two fix attempts', (s) => s.signals.fixLoops <= 2],
      ['Use a systematic debugging skill', (s) => usedSkill(s, /debug|diagnos/i)],
    ],
    tools: ['your test runner in watch mode for fast feedback', 'git bisect when something that used to work broke', 'a systematic-debugging skill that forces a hypothesis before a fix'],
    steps: ['Reproduce: run the failing command or test and capture the exact error.', 'Form one hypothesis about the root cause and check it before editing.', 'Make the smallest fix, then re-run the same reproduction.', 'Add a test that fails without the fix.'],
  },
  testing: {
    practices: [
      ['Actually run the tests in the session', (s) => s.signals.testRuns > 0],
      ['Write or update test files, not just code', (s) => s.files.testEdits > 0],
    ],
    tools: ['a TDD skill (red → green → refactor)', 'your test runner in watch mode'],
    steps: ['Write a failing test for the behaviour: `$ARGUMENTS`.', 'Run it and confirm it fails for the right reason.', 'Write the minimum code to pass, then run the whole suite.'],
  },
  feature: {
    practices: [
      ['Plan before building (plan mode or a planning skill)', (s) => usedTool(s, /^(EnterPlanMode|ExitPlanMode)$/) || usedSkill(s, /plan|brainstorm|spec/i)],
      ['Run tests before calling it done', (s) => s.signals.testRuns > 0],
      ['Commit working steps as you go', (s) => shellRan(s, /\bgit commit\b/)],
    ],
    tools: ['plan mode to agree on the approach first', 'a TDD skill to keep each step verified', 'small commits so a bad step is easy to undo'],
    steps: ['Restate the feature `$ARGUMENTS` and list open questions; ask them before coding.', 'Propose a short plan and wait for approval.', 'Implement step by step, running the tests after each step.', 'Commit each working step with a clear message.'],
  },
  'ui-design': {
    practices: [
      ['Check the result in a real browser', (s) => (s.tools.buckets.browser || 0) > 0],
      ['Use a design skill for direction and polish', (s) => usedSkill(s, /design|frontend/i)],
      ['Read page text rather than screenshotting to inspect content', (s) => usedTool(s, /get_page_text|read_page|find/)],
    ],
    tools: ['a browser preview to verify layout at desktop and mobile widths', 'a frontend-design skill for a consistent visual direction', 'page-text or accessibility-tree reads for checking content cheaply'],
    steps: ['State the goal and audience of `$ARGUMENTS` in one sentence.', 'Make the change, then open it in the browser at desktop and mobile widths.', 'Check content with page text; screenshot only to judge the visuals.', 'List what changed and anything that still looks off.'],
  },
  'git-ops': {
    practices: [
      ['Check the state first (git status / git diff)', (s) => shellRan(s, /\bgit (status|diff)\b/)],
      ['Use the gh CLI for pull requests', (s) => shellRan(s, /\bgh pr\b/)],
    ],
    tools: ['gh pr create --fill to open a PR from your commits', 'a commit skill for consistent messages'],
    steps: ['Run `git status` and `git diff` and summarize what is about to be committed.', 'Commit with a message that says why, not just what.', 'Push and open the PR with `gh pr create --fill`.'],
  },
  research: {
    practices: [
      ['Delegate broad searches to a subagent so only the summary enters the context', (s) => s.subagents.runs > 0],
      ['Check primary sources on the web', (s) => usedTool(s, /^(WebSearch|WebFetch)$/)],
    ],
    tools: ['an Explore subagent for codebase-wide questions', 'web search plus fetch for primary sources'],
    steps: ['Restate the question `$ARGUMENTS` and what a good answer looks like.', 'Send broad searches to an Explore subagent; ask for a summary with file paths.', 'Verify key claims against the source, then answer with references.'],
  },
};

function playbooks({ analysis, sessions }) {
  const out = [];
  for (const [task, book] of Object.entries(PLAYBOOKS)) {
    const list = sessions.filter((s) => s.task.primary === task);
    const t = (analysis.tasks || {})[task];
    if (list.length < MIN_SESSIONS || !t) continue;
    const scored = book.practices.map(([label, test]) => [label, list.filter(test).length / list.length]);
    const missing = scored.filter(([, share]) => share < 0.5);
    if (!missing.length) continue;
    out.push({
      id: `playbook-${task}`, task, level: t.share >= 0.2 ? 'medium' : 'low',
      title: `Workflow: ${t.label}`,
      evidence: `${plural(list.length, 'session')} (${pct(t.share)}% of all), a typical one ${t.medianTurns} prompts and ${t.medianToolCalls} tool calls. ${scored.map(([label, share]) => `${label.split(' (')[0]}: ${pct(share)}% of sessions`).join('; ')}.`,
      action: `Do more of: ${missing.map(([label]) => label.charAt(0).toLowerCase() + label.slice(1)).join('; ')}. Useful: ${book.tools.join('; ')}.`,
      fix: { kind: 'file', target: `~/.claude/commands/${task}.md`, content: `${book.steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}` },
    });
  }
  return out;
}

function promptPractices({ analysis }) {
  const P = analysis.prompting;
  if (!P || P.openings < 6) return null;
  const weak = P.practices.filter((p) => p.share < 0.3 && p.outcome && p.outcome.helps);
  if (!weak.length) return null;
  const f = (o) => `${o.medianFollowUps} follow-up prompt${o.medianFollowUps === 1 ? '' : 's'}, ${pct(o.correctionRate)}% corrected`;
  return {
    id: 'prompt-practices', level: 'medium',
    title: 'Put more into your opening prompts',
    evidence: weak.map((p) => `${p.label}: in ${pct(p.share)}% of your opening prompts. Sessions that opened with it needed ${f(p.outcome.with)}; without it ${f(p.outcome.without)}`).join('. ') + '.',
    action: `In your first message: ${weak.map((p) => p.label.toLowerCase()).join('; ')}. The command below gives every opening that structure, or copy its headings.`,
    fix: { kind: 'file', target: '~/.claude/commands/brief.md', content: 'Task: $ARGUMENTS\n\nBefore starting, make sure the request covers these; ask me for anything missing:\n- Goal, and how we will know it is done\n- Context: the files, errors, links or screenshots involved\n- Constraints: what must not change, what to use or avoid\n- What to hand back (a diff, a summary, a table)' },
  };
}

const READ_ONLY = /^(git (status|diff|log|show)|ls|cat|grep|rg|head|tail|wc|tree|pwd|which)$/;
function allowlist({ sessions, config }) {
  const mode = config.permissions.defaultMode;
  if (mode === 'bypassPermissions' || mode === 'dontAsk') return null;
  const allowed = new Set(config.permissions.allow || []);
  const heads = {};
  for (const s of sessions) for (const [h, n] of Object.entries(s.tools.shell)) if (READ_ONLY.test(h)) heads[h] = (heads[h] || 0) + n;
  const rules = Object.entries(heads).filter(([, n]) => n >= 20).sort((a, b) => b[1] - a[1]).map(([h, n]) => [`Bash(${h}:*)`, n]).filter(([r]) => !allowed.has(r));
  if (rules.length < 3) return null;
  return {
    id: 'allowlist', level: 'low',
    title: 'Pre-approve the read-only commands you run constantly',
    evidence: rules.map(([r, n]) => `${r.slice(5, -3)} ×${n}`).join(', ') + '. None of these change anything.',
    action: 'Allow them so the agent never waits on a permission prompt for them. Skip this if you already run in auto mode.',
    fix: { kind: 'settings', target: '~/.claude/settings.json', content: JSON.stringify({ permissions: { allow: rules.map(([r]) => r) } }, null, 2) },
  };
}

export const RULES = [unusedPlugins, unusedSkills, unusedMcp, screenshots, contextPressure, secrets, flakyTools, heavyHooks, checkIns, promptPractices, playbooks, heavySkills, workflowCommand, repeatedPrompts, allowlist];

/** Run every rule; highest-impact first. `config` defaults to the user's Claude Code config. */
export function recommend(analysis, sessions, config = readClaudeConfig()) {
  return RULES.flatMap((rule) => rule({ analysis, sessions, config }) || []).sort((a, b) => LEVEL[a.level] - LEVEL[b.level]);
}
