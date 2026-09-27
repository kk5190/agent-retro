/**
 * Fixture tests for the agent adapters (anti-rot layer 3).
 *
 * Each agent gets a tiny, real-shaped fixture. If a vendor format changes and an
 * adapter silently breaks, these fail in CI instead of the tool returning zeros.
 *
 * Run:  node --test tests.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFixtures } from './fixtures.mjs';

// Point the adapters at a throwaway HOME filled with real-shaped fixtures (fixtures.mjs).
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-retro-fixtures-'));
process.env.AGENT_RETRO_HOME = HOME;
writeFixtures(HOME);

const { collectFor, collectGeneric, harvestEvents, adapterHealth, collectClaude, loadEvents } = await import('./agents.mjs');
const { buildSessions, commandHead, TASK_IDS } = await import('./sessions.mjs');
const { redact, buildBundle, sessionView } = await import('./telemetry.mjs');
const { loadTelemetry } = await import('./agent-retro.mjs');

const promptsOf = (ev) => ev.filter((e) => e.role === 'user' || e.role === 'assistant');
const toolsOf = (ev) => ev.filter((e) => e.role === 'tool');

// --- tests ------------------------------------------------------------------
test('pi: messages, tools, and project attribution', () => {
  const ev = collectFor('pi', {});
  const p = promptsOf(ev);
  assert.equal(p.length, 2);
  assert.equal(toolsOf(ev).length, 1); // the toolResult is a result, not a second call
  assert.equal(p[0].text, 'hello world');
  assert.equal(p[0].project, 'demo');
  assert.equal(p[1].text, 'hi there');
});

test('codex: session_meta, messages, and function_call', () => {
  const ev = collectFor('codex', {});
  const p = promptsOf(ev);
  assert.equal(p.length, 2);
  assert.equal(p[0].text, 'add a button');
  assert.equal(p[0].project, 'codexdemo');
  assert.ok(toolsOf(ev).some((t) => t.toolName === 'shell'));
});

test('continue: history array', () => {
  const ev = collectFor('continue', {});
  const p = promptsOf(ev);
  assert.equal(p.length, 2);
  assert.equal(p[0].text, 'do the thing');
});

test('opencode: session/message/part join', () => {
  const ev = collectFor('opencode', {});
  const p = promptsOf(ev);
  assert.equal(p.length, 2);
  assert.ok(p.some((e) => e.text === 'hello opencode'));
  assert.ok(p.some((e) => e.text === 'hi from assistant' && e.project === 'ocdemo'));
});

test('harvestEvents: recovers events from renamed fields (anti-rot)', () => {
  const ev = harvestEvents({ when: '2026-03-01T00:00:00Z', author: 'human', body: 'does it still work?' }, { agent: 'x', project: 'p', sessionId: 's' });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].role, 'user');
  assert.equal(ev[0].text, 'does it still work?');
  assert.ok(ev[0].ts > 0);
});

test('collectGeneric: shape-based fallback finds novel records', () => {
  const ev = collectGeneric('codex');
  assert.ok(ev.some((e) => e.text === 'novel schema prompt'), 'fallback should harvest the novel-schema record');
});

test('adapterHealth: reports yield per adapter', () => {
  const rows = adapterHealth({});
  const pi = rows.find((r) => r.id === 'pi');
  assert.equal(pi.status, 'ok');
  assert.ok(pi.events >= 3);
});

test('pi: usage and recorded cost', () => {
  const u = collectFor('pi', {}).filter((e) => e.role === 'usage');
  assert.equal(u.length, 1);
  assert.equal(u[0].input, 100);
  assert.equal(u[0].cacheRead, 300);
  assert.ok(Math.abs(u[0].cost - 0.0012) < 1e-9);
});

test('codex: cumulative usage collapses to a session total', () => {
  const u = collectFor('codex', {}).filter((e) => e.role === 'usage');
  assert.equal(u.length, 1);
  assert.equal(u[0].cumulative, true);
  assert.equal(u[0].input, 1000); // 5000 total input - 4000 cached
  assert.equal(u[0].cacheRead, 4000);
  assert.equal(u[0].ctx, 1200); // last_token_usage drives per-turn context
});

test('per-adapter isolation: pi fixture does not leak into codex', () => {
  const codex = promptsOf(collectFor('codex', {}));
  assert.ok(!codex.some((e) => e.text === 'hello world'));
});

// --- Claude adapter + session telemetry -------------------------------------
const bySession = async () => {
  const { sessions } = await loadTelemetry({ dirs: [], top: 15, history: false });
  return Object.fromEntries(sessions.map((x) => [x.id, x]));
};

test('claude: every event carries its sessionId; subagent work joins the parent session', async () => {
  const { events, files } = await collectClaude({});
  assert.equal(files.length, 4);
  assert.ok(events.every((e) => e.sessionId));
  const side = events.filter((e) => e.sidechain);
  assert.ok(side.length >= 2 && side.every((e) => e.sessionId === 'rev-1'));
  assert.ok(events.some((e) => e.role === 'tool' && e.detail === 'gh pr diff 42'));
});

test('sessions: subagent prompts are never human turns', async () => {
  const s = (await bySession())['rev-1'];
  assert.equal(s.turns.human, 2);
  assert.equal(s.turns.pushback, 1);
  assert.equal(s.subagents.runs, 1);
  assert.equal(s.subagents.toolCalls, 1);
  assert.equal(s.subagents.types['code-reviewer'], 1);
});

test('sessions: tools, errors, shell heads, cost and title', async () => {
  const s = (await bySession())['rev-1'];
  assert.equal(s.tools.errors, 1);
  assert.equal(s.tools.shell['gh pr'], 1);
  assert.equal(s.tools.shell['git diff'], 1, 'cd prefix is skipped');
  assert.equal(s.skills['code-review'], 1);
  assert.equal(s.costUsd, 0.42);
  assert.equal(s.tokens.cacheRead, 4900); // 4 main-thread turns + the subagent's turn
  assert.equal(s.branch, 'main');
  assert.equal(s.durationMin, 9);
});

test('sessions: fix loops and file edits', async () => {
  const s = (await bySession())['dbg-1'];
  assert.equal(s.signals.testRuns, 2);
  assert.equal(s.signals.fixLoops, 1);
  assert.equal(s.files.edited, 1);
  const f = (await bySession())['feat-1'];
  assert.equal(f.turns.ack, 1);
  assert.equal(f.files.edited, 2);
});

test('context: estimated sources from the main thread only, compactions, api errors', async () => {
  const d = (await bySession())['dbg-1'];
  assert.equal(d.context.estimated, true);
  assert.equal(d.context.sources.memory, 200, 'CLAUDE.md: 800 chars ≈ 200 tokens');
  assert.equal(d.context.toolOutputByTool.Read, 1000);
  assert.equal(d.context.compactions, 1);
  assert.equal(d.context.compactPreTokens, 180000);
  assert.equal(d.context.apiErrors, 1);
  const r = (await bySession())['rev-1'];
  assert.equal(r.context.sources.reasoning, undefined, 'subagent thinking is in its own window');
});

test('subagents: per-type runs, tools and tokens from meta.json', async () => {
  const t = (await bySession())['rev-1'].subagents.byType['code-reviewer'];
  assert.deepEqual(t, { runs: 1, toolCalls: 1, errors: 0, tokens: 945, outputTokens: 40 });
});

test('risk: sensitive files, destructive commands, error bursts', async () => {
  const d = (await bySession())['dbg-1'];
  assert.equal(d.risk.sensitiveAccess, 1);
  assert.equal(d.risk.destructiveCommands, 1, 'rm -rf dist is routine; rm -rf src/legacy is not');
  assert.equal(d.risk.maxErrorsPerTurn, 3);
  const { isDestructive, isSensitive } = await import('./sessions.mjs');
  assert.equal(isDestructive('git push --force origin main'), true);
  assert.equal(isDestructive('rm -rf node_modules .next /tmp/x'), false);
  assert.equal(isSensitive("python3 - <<'EOF'\nx = '.env'\nEOF"), false, 'heredoc bodies are payload, not access');
});

test('task labels: review, debugging, feature', async () => {
  const s = await bySession();
  assert.equal(s['rev-1'].task.primary, 'code-review');
  assert.equal(s['dbg-1'].task.primary, 'debugging');
  assert.equal(s['feat-1'].task.primary, 'feature');
  for (const x of Object.values(s)) assert.ok(x.task.confidence > 0 && x.task.confidence <= 1);
});

test('commandHead normalizes shell commands', () => {
  assert.equal(commandHead('cd /repo && npm run build -- --prod'), 'npm run build');
  assert.equal(commandHead('bash -lc "pytest -q tests/"'), 'pytest');
  assert.equal(commandHead('FOO=1 npx vitest run'), 'vitest');
  assert.equal(commandHead('python3 -m http.server'), 'python -m http.server');
  assert.equal(commandHead('gh pr view 12 --json title'), 'gh pr');
});

test('rollup: per-task profile and subagent prompts excluded from human volume', async () => {
  const { analysis } = await loadTelemetry({ dirs: [], top: 15, history: false });
  assert.equal(analysis.volume.prompts, 6); // 2 per session; the subagent prompt is excluded
  assert.equal(analysis.tasks['code-review'].sessions, 1);
  assert.equal(analysis.tasks['code-review'].totalCost, 0.42);
  assert.deepEqual(analysis.tasks['debugging'].topShell[0], ['npm test', 2]);
});

test('loadEvents: days/project filters apply to every agent alike', async () => {
  const all = await loadEvents({ allAgents: true });
  assert.ok(all.events.some((e) => e.agent === 'pi') && all.events.some((e) => e.agent === 'claude'));
  const only = await loadEvents({ allAgents: true, project: 'codexdemo' });
  assert.ok(only.events.length && only.events.every((e) => e.project === 'codexdemo'));
});

// --- recommendations -------------------------------------------------------------
test('recommendations: unused plugin, personal skill and MCP server, with fixes for this config', async () => {
  const { analysis } = await loadTelemetry({ dirs: [], top: 15, history: false });
  const by = Object.fromEntries(analysis.recommendations.map((r) => [r.id, r]));
  assert.deepEqual(JSON.parse(by['unused-plugins'].fix.content), { enabledPlugins: { 'idle-plugin@market': false } }, 'used-plugin stays enabled');
  assert.match(by['unused-skills'].fix.content, /mv ~\/\.claude\/skills\/my-old-skill ~\/\.claude\/skills-parked\//);
  assert.ok(!by['unused-skills'].evidence.includes('code-review'), 'code-review was used (Skill tool)');
  assert.equal(by['unused-mcp'].fix.content, 'claude mcp remove dusty-server -s user');
  assert.deepEqual(JSON.parse(by.secrets.fix.content).permissions.deny[0], 'Read(./.env)');
  assert.deepEqual(analysis.recommendations.map((r) => r.level), [...analysis.recommendations.map((r) => r.level)].sort((a, b) => ['high', 'medium', 'low'].indexOf(a) - ['high', 'medium', 'low'].indexOf(b)));
});

test('extensions: plugins, skills, MCP servers and hooks from session logs', async () => {
  const { analysis } = await loadTelemetry({ dirs: [], top: 15, history: false });
  const E = analysis.extensions;
  const by = (list, key, v) => list.find((x) => x[key] === v);
  assert.equal(by(E.plugins, 'name', 'idle-plugin').verdict, 'unused');
  assert.equal(by(E.plugins, 'name', 'used-plugin').enabledKey, 'used-plugin@market');
  const gamma = by(E.skills, 'name', 'used-plugin:gamma');
  assert.equal(gamma.uses, 1, 'the Skill call and its load count once');
  assert.equal(gamma.tokensPerLoad, Math.round(('Base directory for this skill: /Users/x/.claude/plugins/cache/market/used-plugin/1.0.0/skills/gamma\n'.length + 3996) / 4));
  const busy = by(E.mcpServers, 'name', 'busy-srv');
  assert.deepEqual([busy.calls, busy.errors, busy.topError, busy.verdict], [2, 1, 'timeout', 'used']);
  assert.equal(by(E.mcpServers, 'name', 'dusty-server').source, 'user');
  const hook = E.hooks[0];
  assert.deepEqual([hook.name, hook.runs, hook.sessions, hook.p90Ms, hook.tokensPerSession], ['SessionStart', 3, 3, 1200, 2000]);
  const ids = analysis.recommendations.map((r) => r.id);
  assert.ok(ids.includes('heavy-hooks'));
});

test('playbooks: missing practices for a recurring task become a workflow command', async () => {
  const { buildSessions, summarizeTasks } = await import('./sessions.mjs');
  const { recommend } = await import('./recommend.mjs');
  const ev = [];
  for (let i = 0; i < 3; i++) {
    const sid = `cr${i}`, ts = Date.parse(`2026-04-0${i + 1}T10:00:00Z`);
    ev.push({ agent: 'x', sessionId: sid, ts, role: 'user', text: 'please do a code review of this PR, reviewer checklist' });
    ev.push({ agent: 'x', sessionId: sid, ts: ts + 1000, role: 'tool', toolName: 'Read', detail: 'src/a.ts' });
    if (i === 0) ev.push({ agent: 'x', sessionId: sid, ts: ts + 2000, role: 'tool', toolName: 'Bash', detail: 'npm test' });
  }
  const sessions = buildSessions(ev);
  const cfg = { enabledPlugins: {}, permissions: {}, userMcp: {}, projectMcp: {}, userSkills: new Set() };
  const r = recommend({ tasks: summarizeTasks(sessions), context: {}, contextBreakdown: {}, risk: {} }, sessions, cfg).find((x) => x.id === 'playbook-code-review');
  assert.ok(r, 'fires for 3 code-review sessions');
  assert.equal(r.task, 'code-review');
  assert.match(r.action, /fetch the change with a tool/);
  assert.match(r.evidence, /Run the tests as part of the review: 33% of sessions/);
  assert.equal(r.fix.target, '~/.claude/commands/code-review.md');
  assert.match(r.fix.content, /gh pr diff \$ARGUMENTS/);
});

test('analyzePrompt: shots, techniques, vagueness; acks are not task prompts', async () => {
  const { analyzePrompt } = await import('./prompts.mjs');
  assert.equal(analyzePrompt('continue'), null);
  assert.equal(analyzePrompt('yes do it'), null);
  const zero = analyzePrompt('add a dark mode toggle to src/settings/Page.tsx, keep the existing layout');
  assert.equal(zero.shots, 'zero-shot');
  assert.ok(zero.techniques.has('context') && zero.techniques.has('constraints'));
  assert.equal(analyzePrompt('rename the helpers, for example getUser → fetchUser').shots, 'one-shot');
  assert.equal(analyzePrompt('write tests. For example: empty input. Another example: unicode names. Input: [] Output: 0').shots, 'few-shot');
  const brief = analyzePrompt('You are a senior reviewer. Review the diff step by step.\n- check error handling\n- check naming\nReturn the findings as a table so that I can triage them, because we ship Friday. Done when every file is covered.');
  for (const t of ['role', 'step-by-step', 'structured', 'output-format', 'goal', 'why']) assert.ok(brief.techniques.has(t), t);
  assert.equal(analyzePrompt('fix it please, make it better').vague, true);
  assert.equal(analyzePrompt('fix the TypeError in src/cart.ts line 42').vague, false);
});

test('summarizePrompts: adoption and with/without outcomes on opening prompts', async () => {
  const { summarizePrompts } = await import('./prompts.mjs');
  const S = (first, human, pushback = 0) => ({ _prompts: [first, ...Array(human - 1).fill('and another change please')], turns: { human, pushback } });
  const sessions = [
    S('fix the crash in src/cart.ts line 42', 2), S('update api/users.ts to paginate', 1), S('see error: exit code 1 in build.sh', 2),
    S('make it better please', 6, 1), S('improve the page now', 5, 1), S('do the thing we discussed', 7),
  ];
  const P = summarizePrompts(sessions);
  const ctx = P.practices.find((p) => p.id === 'context');
  assert.equal(ctx.share, 0.5);
  assert.deepEqual([ctx.outcome.with.medianFollowUps, ctx.outcome.without.medianFollowUps], [1, 5]);
  assert.equal(ctx.outcome.helps, true);
  assert.equal(P.practices.find((p) => p.id === 'goal').outcome, null, 'no sessions with a goal: nothing to compare');
  assert.ok(P.vagueExamples.length >= 2);
  const { recommend } = await import('./recommend.mjs');
  const cfg = { enabledPlugins: {}, permissions: {}, userMcp: {}, projectMcp: {}, userSkills: new Set() };
  assert.equal(recommend({ prompting: P, context: {}, contextBreakdown: {}, risk: {} }, [], cfg).some((r) => r.id === 'prompt-practices'), false, 'context is used in 50%, so no nudge');
  const P2 = summarizePrompts([...sessions.slice(0, 3), ...Array(8).fill(0).map(() => S('please make the page nicer', 6, 1))]);
  const r = recommend({ prompting: P2, context: {}, contextBreakdown: {}, risk: {} }, [], cfg).find((x) => x.id === 'prompt-practices');
  assert.ok(r, 'fires when context is rare and helps');
  assert.match(r.evidence, /Give context: in 27% of your opening prompts/);
  assert.equal(r.fix.target, '~/.claude/commands/brief.md');
});

test('recommendations: nothing fires on an empty history', async () => {
  const { recommend } = await import('./recommend.mjs');
  const empty = { inventory: { sessionsMeasured: 0, skills: {}, mcpServers: {} }, extensions: { plugins: [], skills: [], mcpServers: [], hooks: [], commands: [] }, context: {}, contextBreakdown: {}, risk: {} };
  assert.deepEqual(recommend(empty, [], { enabledPlugins: {}, permissions: {}, userMcp: {}, projectMcp: {}, userSkills: new Set() }), []);
});

// --- errors, time, labels, trends, sequences ----------------------------------
test('errorClass: failures by cause; rejections and guard blocks are not failures', async () => {
  const { errorClass } = await import('./sessions.mjs');
  assert.equal(errorClass("The user doesn't want to proceed with this tool use."), 'rejected');
  assert.equal(errorClass('Adding a new package is blocked. Every dependency is code'), 'blocked');
  assert.equal(errorClass('Error capturing screenshot: Script injection timed out after 10s'), 'timeout');
  assert.equal(errorClass('MCP error -32602: Input validation error: Invalid arguments'), 'invalid-input');
  assert.equal(errorClass('Port 4321 is in use by "node" (PID 1)'), 'environment');
  assert.equal(errorClass('Exit code 1\nFAIL src/a.test.ts'), 'command-failed');
  assert.equal(errorClass(''), 'unknown');
});

test('time: agent working time, your reply time, and away gaps', async () => {
  const d = (await bySession())['dbg-1'];
  assert.deepEqual(d.time, { agentMinutes: 4, waitMinutes: 1, awayMinutes: 0, medianResponseSec: 60 });
  const { buildSessions } = await import('./sessions.mjs');
  const T = (m) => Date.parse('2026-03-01T10:00:00Z') + m * 60000;
  const [s] = buildSessions([
    { agent: 'x', sessionId: 'r', ts: T(0), role: 'user', text: 'fix the flaky build please' },
    { agent: 'x', sessionId: 'r', ts: T(2), role: 'assistant' },
    { agent: 'x', sessionId: 'r', ts: T(2 + 60 * 24), role: 'assistant' }, // resumed a day later
    { agent: 'x', sessionId: 'r', ts: T(3 + 60 * 24), role: 'tool', toolName: 'Bash', detail: 'npm test' },
    { agent: 'x', sessionId: 'r', ts: T(3 + 60 * 24), role: 'tool_error', toolName: 'Bash', text: "The user doesn't want to proceed" },
  ]);
  assert.equal(s.time.agentMinutes, 3, 'the day-long gap is away, not work');
  assert.equal(s.time.awayMinutes, 60 * 24);
  assert.equal(s.tools.errors, 0);
  assert.equal(s.tools.rejected, 1);
});

test('labels: a manual label overrides the rules and keeps what they said', async () => {
  const { buildSessions } = await import('./sessions.mjs');
  const { events } = await loadEvents({});
  const feat = buildSessions(events, { labels: { 'feat-1': 'ui-design' } }).find((x) => x.id === 'feat-1');
  assert.equal(feat.task.primary, 'ui-design');
  assert.equal(feat.task.source, 'manual');
  assert.equal(feat.task.rulePrimary, 'feature');
  const { writeLabel, readLabels } = await import('./agent-retro.mjs');
  writeLabel('feat-1', 'docs');
  assert.equal(readLabels()['feat-1'], 'docs');
  assert.throws(() => writeLabel('feat-1', 'not-a-task'));
  writeLabel('feat-1', null);
  assert.equal(readLabels()['feat-1'], undefined);
});

test('comparePeriods: before/after split shows which way each metric moved', async () => {
  const { buildSessions, comparePeriods } = await import('./sessions.mjs');
  const ev = [];
  for (let i = 0; i < 6; i++) {
    const ts = Date.parse(`2026-0${i < 3 ? 1 : 3}-0${i + 1}T10:00:00Z`);
    ev.push({ agent: 'x', sessionId: `p${i}`, ts, role: 'user', text: 'implement the settings page' });
    ev.push({ agent: 'x', sessionId: `p${i}`, ts: ts + 1000, role: 'assistant' });
    if (i < 3) ev.push({ agent: 'x', sessionId: `p${i}`, ts: ts + 2000, role: 'user', text: 'continue' });
  }
  const t = comparePeriods(buildSessions(ev), { split: Date.parse('2026-02-01') });
  assert.deepEqual(t.sessions, { before: 3, after: 3 });
  assert.equal(t.metrics.ackRate.before, 0.5);
  assert.equal(t.metrics.ackRate.after, 0);
  assert.equal(t.metrics.ackRate.verdict, 'better');
  assert.equal(comparePeriods(buildSessions(ev.slice(0, 4))), null, 'too few sessions to compare');
});

test('mineWorkflows: repeated command runs across sessions, exploration-only runs skipped', async () => {
  const { mineWorkflows } = await import('./sessions.mjs');
  const S = (heads) => ({ _shellHeads: heads });
  const w = mineWorkflows([
    S(['git status', 'npm test', 'npm test', 'git add', 'git commit']),
    S(['ls', 'git status', 'npm test', 'git add', 'git commit', 'git push']),
    S(['git status', 'npm test', 'git add', 'git commit']),
    S(['grep', 'cat', 'ls', 'grep']), S(['grep', 'cat', 'ls']), S(['grep', 'cat', 'ls']),
  ]);
  assert.deepEqual(w[0], { steps: ['git status', 'npm test', 'git add', 'git commit'], sessions: 3, runs: 3 });
  assert.ok(!w.some((x) => x.steps.includes('grep')));
});

// --- redaction + text levels --------------------------------------------------
test('redact: secrets, emails, home paths', () => {
  const r = redact('token=abc123secret key sk-ABCDEFGHIJKLMNOPQRSTUV mail a@b.co at /Users/x/proj and ghp_abcdefghijklmnopqrstuvwxyz0123');
  assert.ok(!/abc123secret|sk-ABC|a@b\.co|\/Users\/x|ghp_/.test(r), r);
  assert.match(r, /~\/proj/);
  assert.equal(redact('src/components/Button.tsx'), 'src/components/Button.tsx');
});

test('text levels: none drops text, excerpts clip, full keeps all', async () => {
  const s = (await bySession())['rev-1'];
  const none = sessionView(s, 'none');
  assert.equal(none.title, null);
  assert.deepEqual(none.text, { level: 'none' });
  assert.ok(!Object.keys(none).some((k) => k.startsWith('_')));
  const ex = sessionView(s, 'excerpts');
  assert.equal(ex.text.prompts.length, 2);
  assert.ok(!/abc123secret|a@b\.co/.test(ex.text.prompts[0]));
  assert.equal(ex.title, 'Review PR 42 at ~/secret-proj');
  assert.throws(() => sessionView(s, 'everything'));
});

// --- schema contract ------------------------------------------------------------
const SCHEMA = JSON.parse(fs.readFileSync(new URL('./schema/telemetry.schema.json', import.meta.url), 'utf8'));
/** Minimal JSON Schema subset validator (type, const, enum, required, properties, additionalProperties, items, prefixItems, propertyNames, minimum, maximum, $ref). */
function validate(v, schema, at = '$', errs = []) {
  if (schema.$ref) return validate(v, SCHEMA.$defs[schema.$ref.split('/').pop()], at, errs);
  const typeOf = (x) => (x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x);
  if (schema.type) { const ts = [].concat(schema.type); if (!ts.includes(typeOf(v))) { errs.push(`${at}: expected ${ts} got ${typeOf(v)}`); return errs; } }
  if ('const' in schema && v !== schema.const) errs.push(`${at}: expected ${schema.const}`);
  if (schema.enum && !schema.enum.includes(v)) errs.push(`${at}: ${v} not in enum`);
  if (schema.minimum != null && v < schema.minimum) errs.push(`${at}: < minimum`);
  if (schema.maximum != null && v > schema.maximum) errs.push(`${at}: > maximum`);
  if (typeOf(v) === 'object') {
    for (const r of schema.required || []) if (!(r in v)) errs.push(`${at}: missing ${r}`);
    for (const [k, x] of Object.entries(v)) {
      if (schema.propertyNames) validate(k, schema.propertyNames, `${at}{${k}}`, errs);
      if (schema.properties && schema.properties[k]) validate(x, schema.properties[k], `${at}.${k}`, errs);
      else if (schema.additionalProperties === false) errs.push(`${at}: unexpected ${k}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validate(x, schema.additionalProperties, `${at}.${k}`, errs);
    }
  }
  if (typeOf(v) === 'array') v.forEach((x, i) => {
    if (schema.prefixItems && i < schema.prefixItems.length) validate(x, schema.prefixItems[i], `${at}[${i}]`, errs);
    else if (schema.items) validate(x, schema.items, `${at}[${i}]`, errs);
  });
  return errs;
}

test('schema: task enum matches the TASKS table', () => {
  assert.deepEqual([...SCHEMA.$defs.taskId.enum].sort(), [...TASK_IDS].sort());
});

test('schema: export bundle validates at every text level', async () => {
  const t = await loadTelemetry({ dirs: [], top: 15, history: false });
  for (const text of ['none', 'excerpts', 'full']) {
    const b = buildBundle(t, { text });
    assert.deepEqual(validate(b.telemetry, SCHEMA.$defs.Telemetry), []);
    for (const s of b.sessions) assert.deepEqual(validate(s, SCHEMA.$defs.Session), [], s.id);
  }
});

// --- CLI + MCP, as real child processes ----------------------------------------
const { spawnSync, spawn } = await import('node:child_process');
const CLI = new URL('./agent-retro.mjs', import.meta.url).pathname;
const env = { ...process.env, AGENT_RETRO_HOME: HOME };

test('cli: --export writes a valid bundle and nothing sensitive at --text none', () => {
  const out = path.join(HOME, 'export');
  const r = spawnSync(process.execPath, [CLI, '--export', out, '--text', 'none'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const tel = JSON.parse(fs.readFileSync(path.join(out, 'telemetry.json'), 'utf8'));
  assert.deepEqual(validate(tel, SCHEMA.$defs.Telemetry), []);
  const raw = fs.readFileSync(path.join(out, 'sessions.jsonl'), 'utf8');
  const lines = raw.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  assert.ok(!/review this PR|dark mode|secret-proj|abc123secret|"rev"/.test(raw + JSON.stringify(tel)));
  assert.deepEqual(tel.rollup.prompting.vagueExamples, [], 'no prompt text at level none');
  assert.ok(lines.every((l) => /^project-[0-9a-f]{6}$/.test(l.project) && /^branch-[0-9a-f]{6}$/.test(l.branch)), 'project and branch are pseudonymized');
  assert.equal(new Set(lines.map((l) => l.project)).size, 1, 'pseudonyms are stable');
  assert.ok(lines.find((l) => l.id === 'rev-1').tools.shell['gh pr'], 'well-known commands survive');
  const bad = spawnSync(process.execPath, [CLI, '--sessions', '--text', 'bogus'], { env, encoding: 'utf8' });
  assert.equal(bad.status, 2);
});

test('mcp: initialize, tools/list, tools/call round-trip over stdio', async () => {
  const child = spawn(process.execPath, [CLI, '--mcp'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map(); let buf = '';
  child.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); pending.get(m.id)?.(m); }
  });
  let id = 0;
  const rpc = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'agent-retro');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await rpc('tools/list', {});
    assert.deepEqual(list.result.tools.map((t) => t.name), ['get_overview', 'list_sessions', 'get_recommendations', 'get_retro', 'get_extensions', 'get_session', 'get_task_profile']);
    const ex = await rpc('tools/call', { name: 'get_extensions', arguments: { kind: 'hooks' } });
    assert.equal(ex.result.structuredContent.hooks[0].name, 'SessionStart');
    const recs = await rpc('tools/call', { name: 'get_recommendations', arguments: {} });
    assert.ok(recs.result.structuredContent.recommendations.some((r) => r.id === 'unused-plugins'));
    const ls = await rpc('tools/call', { name: 'list_sessions', arguments: { task: 'code-review' } });
    assert.equal(ls.result.structuredContent.total, 1);
    assert.equal(ls.result.structuredContent.sessions[0].id, 'rev-1');
    const prof = await rpc('tools/call', { name: 'get_task_profile', arguments: { task: 'debugging' } });
    assert.equal(prof.result.structuredContent.fixLoops, 1);
    const ov = await rpc('tools/call', { name: 'get_overview', arguments: {} });
    assert.ok(ov.result.structuredContent.tasks['feature']);
    const miss = await rpc('tools/call', { name: 'get_session', arguments: { id: 'nope' } });
    assert.equal(miss.result.isError, true);
    const unknown = await rpc('bogus/method', {});
    assert.equal(unknown.error.code, -32601);
  } finally { child.kill(); }
});

test('cli: --label saves a correction and --label-accuracy reports agreement', () => {
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
  assert.equal(run('--label', 'rev-1=debugging').status, 0);
  const acc = run('--label-accuracy');
  assert.match(acc.stdout, /Rules agree with 0 of 1 corrected labels/);
  assert.match(acc.stdout, /rules said code-review → debugging: 1/);
  assert.equal(run('--label', 'rev-1=bogus').status, 2);
  assert.equal(run('--label', 'rev-1=').status, 0);
});

test('cli: --demo runs on synthetic data and never reads the real home', () => {
  const r = spawnSync(process.execPath, [CLI, '--demo', '--json'], { env: { ...process.env, AGENT_RETRO_HOME: '/nonexistent-home' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const a = JSON.parse(r.stdout);
  assert.equal(a.sessions.count, 36);
  assert.ok(a.recommendations.some((x) => x.id === 'playbook-code-review'));
  assert.ok(a.trend && a.extensions.hooks.length);
  assert.match(r.stderr, /demo mode: 36 synthetic sessions/);
});

test('retro: columns, caps, action metrics and the Kaizen review of a saved retro', async () => {
  const { buildRetro, retroSnapshot } = await import('./retro.mjs');
  const { buildSessions } = await import('./sessions.mjs');
  const T = Date.parse('2026-05-20T10:00:00Z');
  const sessions = buildSessions([0, 1, 2].flatMap((i) => [
    { agent: 'x', sessionId: `r${i}`, ts: T + i * 864e5, role: 'user', text: 'implement the export page' },
    { agent: 'x', sessionId: `r${i}`, ts: T + i * 864e5 + 1000, role: 'user', text: 'continue' },
    { agent: 'x', sessionId: `r${i}`, ts: T + i * 864e5 + 2000, role: 'assistant' },
  ]));
  const recs = [
    { id: 'screenshots', level: 'high', title: 'Read pages as text', action: 'Read text. Then more.', fix: { kind: 'claude-md', target: 'x', content: 'y' } },
    { id: 'check-ins', level: 'medium', title: 'Cut check-ins', action: 'Keep going.', fix: { kind: 'claude-md', target: 'x', content: 'y' } },
    { id: 'unused-mcp', level: 'medium', title: 'Remove servers', action: 'Remove them.' },
  ];
  const analysis = {
    recommendations: recs, tasks: {}, context: { cacheHitRate: 90 }, risk: { sensitiveAccess: 0, destructiveCommands: 0 },
    findings: [{ level: 'attention', title: 'Context is heavy.', detail: 'd', section: 'tokens' }, { level: 'info', title: 'fyi', detail: 'd', section: 'x' }],
    trend: { metrics: { toolErrorRate: { label: 'Failed tool calls', share: true, before: 0.1, after: 0.05, verdict: 'better' }, ackRate: { label: '“Continue” prompts', share: true, before: 0.1, after: 0.5, verdict: 'worse' } } },
    prompting: { practices: [] },
  };
  const r = buildRetro(analysis, sessions, null);
  assert.equal(r.card.sessions, 3);
  assert.equal(r.card.topTask.id, 'feature');
  assert.deepEqual(r.wentWell.map((x) => x.text), ['Failed tool calls: 10% → 5%', '90% of input served from cache', 'No secret access or destructive commands']);
  assert.deepEqual(r.didntGoWell.map((x) => x.text), ['Context is heavy.', '“Continue” prompts: 10% → 50%']);
  assert.deepEqual(r.start.map((x) => x.recId), ['screenshots']);
  assert.deepEqual(r.stop.map((x) => x.recId), ['check-ins', 'unused-mcp']);
  assert.equal(r.start[0].detail, 'Read text.');
  assert.deepEqual(r.actions.map((x) => x.id), ['screenshots', 'check-ins'], 'only recommendations with a fix');
  assert.equal(r.actions[1].metric.display, '50%', 'ackRate of the sprint: 3 of 6 prompts');
  assert.equal(r.kaizen.review, null);
  assert.equal(r.kaizen.experiment.metric.key, 'ackRate', 'first action item with a measurable metric');
  const snap = retroSnapshot(r);
  assert.deepEqual(snap.actions[1], { id: 'check-ins', title: 'Cut check-ins', metric: 'ackRate', baseline: 0.5 });
  const later = buildRetro(analysis, sessions, { ...snap, actions: [{ ...snap.actions[1], baseline: 0.8 }] });
  assert.deepEqual(later.kaizen.review.items[0], { title: 'Cut check-ins', metric: '“Continue” prompts', baseline: '80%', now: '50%', verdict: 'better', stillOpen: true });
  assert.equal(buildRetro({ recommendations: [], tasks: {}, prompting: { practices: [] } }, [], null).headline, 'No sessions in this period yet.');
});

test('cli: --retro --md is paste-ready, and --save-retro feeds the next retro', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-retro-save-'));
  const run = (...args) => spawnSync(process.execPath, [CLI, '--demo', ...args], { env: { ...process.env, AGENT_RETRO_HOME: home }, encoding: 'utf8' });
  const md = run('--retro', '--md');
  assert.equal(md.status, 0, md.stderr);
  for (const h of ['## Retro', '### Went well', "### Didn't go well", '### Start', '### Stop', '### Action items', '### Kaizen']) assert.ok(md.stdout.includes(h), h);
  assert.match(md.stdout, /Since the retro saved/, 'the demo ships a saved retro');
  const saved = run('--save-retro');
  assert.equal(saved.status, 0, saved.stderr);
  assert.match(saved.stderr, /retro saved to .*agent-retro-demo-.*\.agent-retro\/retros\//, 'writes inside the demo home only');
});

test('sprints: a Wednesday calendar gives aligned windows; the retro reviews the last completed one', async () => {
  const { buildSessions, sprintWindows, defaultSprint, comparePeriods, localDay } = await import('./sessions.mjs');
  const now = localDay('2026-09-27') + 12 * 3600e3; // a Sunday
  const cal = { start: '2026-09-02', days: 14 }; // a Wednesday
  const ev = [];
  const add = (day, n) => { for (let i = 0; i < n; i++) { const sid = `${day}-${i}`; const ts = localDay(day) + (10 + i) * 3600e3; ev.push({ agent: 'x', sessionId: sid, ts, role: 'user', text: 'implement the reports page' }, { agent: 'x', sessionId: sid, ts: ts + 1000, role: 'assistant' }); } };
  add('2026-08-25', 3); add('2026-09-08', 4); add('2026-09-20', 2);
  const sessions = buildSessions(ev);
  const w = sprintWindows(sessions, cal, { now, count: 3 });
  const { localDate: day } = await import('./sessions.mjs');
  assert.deepEqual(w.slice(0, 3).map((x) => [day(x.from), day(x.to - 1), x.current, x.sessions]), [
    ['2026-09-16', '2026-09-29', true, 2], ['2026-09-02', '2026-09-15', false, 4], ['2026-08-19', '2026-09-01', false, 3]]);
  assert.equal(new Date(w[1].from).getDay(), 3, 'sprints start on Wednesday');
  assert.equal(defaultSprint(w), w[1], 'last completed sprint');
  const t = comparePeriods(sessions, { window: w[1] });
  assert.deepEqual([t.mode, t.days, t.sessions.before, t.sessions.after], ['sprint', 14, 3, 4]);
  const rolling = sprintWindows(sessions, null);
  assert.equal(rolling.length, 1);
  assert.equal(rolling[0].rolling, true);
});

test('cli: --sprint-start/--save-sprint set the calendar; --sprint picks a window', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-retro-sprint-'));
  writeFixtures(home); // the Claude fixture sessions fall on 2026-03-01
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env, AGENT_RETRO_HOME: home }, encoding: 'utf8' });
  assert.equal(run('--sprint-start', 'wednesday').status, 2, 'dates only');
  const saved = run('--sprint-start', '2026-02-25', '--sprint-days', '14', '--save-sprint', '--retro');
  assert.equal(saved.status, 0, saved.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, '.agent-retro', 'config.json'), 'utf8')).sprint, { start: '2026-02-25', days: 14 });
  const picked = run('--retro', '--sprint', '2026-03-01');
  assert.equal(picked.status, 0, picked.stderr);
  assert.match(picked.stdout, /RETRO · sprint 2026-02-25 → 2026-03-10/);
});

// --- regressions from the code review ------------------------------------------
test('review: redaction covers JSON and quoted keys', async () => {
  const { redact } = await import('./telemetry.mjs');
  const r = redact('{"password": "hunter2", "api_key": "abc123", \'token\': \'t0k\'} db_pwd=x9');
  assert.ok(!/hunter2|abc123|t0k|x9/.test(r), r);
});

test('review: the allowlist never pre-approves commands that can delete', async () => {
  const { recommend } = await import('./recommend.mjs');
  const { buildSessions } = await import('./sessions.mjs');
  const ev = [{ agent: 'x', sessionId: 'a', ts: 1, role: 'user', text: 'look around the repo please' }];
  for (const c of ['git branch -a', 'find . -name x', 'grep -r foo', 'cat a.txt', 'git status']) for (let i = 0; i < 25; i++) ev.push({ agent: 'x', sessionId: 'a', ts: 2, role: 'tool', toolName: 'Bash', detail: c });
  const cfg = { enabledPlugins: {}, permissions: {}, userMcp: {}, projectMcp: {}, userSkills: new Set() };
  const r = recommend({ context: {}, contextBreakdown: {}, risk: {} }, buildSessions(ev), cfg).find((x) => x.id === 'allowlist');
  assert.ok(r);
  assert.ok(!/git branch|find/.test(r.fix.content), r.fix.content);
});

test('review: repeated-sequence advice quotes command names, so it is personal', async () => {
  const { recommend } = await import('./recommend.mjs');
  const cfg = { enabledPlugins: {}, permissions: {}, userMcp: {}, projectMcp: {}, userSkills: new Set() };
  const r = recommend({ workflows: [{ steps: ['acme-deploy', 'npm test', 'git push'], sessions: 3, runs: 3 }], context: {}, contextBreakdown: {}, risk: {} }, [], cfg).find((x) => x.id === 'workflow-command');
  assert.equal(r.personal, true);
  const { rollupView } = await import('./telemetry.mjs');
  const view = rollupView({ repeated: [], insights: [], tasks: {}, projects: {}, sessions: { longest: [] }, recommendations: [r] }, 'none');
  assert.ok(!JSON.stringify(view.recommendations).includes('acme-deploy'));
});

test('review: a plugin disabled in settings is never recommended for disabling again', async () => {
  const { summarizeExtensions } = await import('./sessions.mjs');
  const inv = { sessionsMeasured: 5, latestSession: new Date().toISOString(), skills: { 'off:a': { plugin: 'off', loadedSessions: 5, usedSessions: 0, tokens: 40, lastSeen: new Date().toISOString() } }, mcpServers: {} };
  const E = summarizeExtensions([], inv, { enabledPlugins: { 'off@m': false } });
  const p = E.plugins.find((x) => x.name === 'off');
  assert.deepEqual([p.verdict, p.enabledKey], ['disabled', null]);
});

test('review: sprint windows stay on local midnight across daylight saving', () => {
  const code = "import('./sessions.mjs').then((m) => { const w = m.sprintWindows([], { start: '2026-01-07', days: 14 }, { now: Date.parse('2026-11-20T12:00:00Z'), count: 24 }); console.log(w.filter((x) => new Date(x.from).getHours() || new Date(x.from).getDay() !== 3).length); })";
  for (const TZ of ['America/New_York', 'Europe/Berlin']) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TZ }, encoding: 'utf8', cwd: path.dirname(CLI) });
    assert.equal(r.stdout.trim(), '0', `${TZ}: ${r.stderr}`);
  }
});

test('review: Zed rows survive "|" and newlines in summaries, with epoch timestamps', { skip: spawnSync('sqlite3', ['-version']).status !== 0 && 'sqlite3 CLI not installed' }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-retro-zed-'));
  const dir = path.join(home, 'Library/Application Support/Zed/threads');
  fs.mkdirSync(dir, { recursive: true });
  const thread = JSON.stringify({ updated_at: '2026-03-02T10:00:00Z', folder_paths: ['/w/zedproj'], messages: [{ role: 'user', content: 'fix the a | b parser please' }] });
  const hex = Buffer.from(thread).toString('hex');
  const sql = `CREATE TABLE threads (id TEXT, summary TEXT, created_at TEXT, data_type TEXT, data BLOB); INSERT INTO threads VALUES ('z1', 'Fix a | b parser' || char(10) || 'second line', '2026-03-02 10:00:00', 'json', x'${hex}');`;
  assert.equal(spawnSync('sqlite3', [path.join(dir, 'threads.db'), sql]).status, 0);
  const code = "import('./agents.mjs').then((m) => console.log(JSON.stringify(m.collectFor('zed', {}))))";
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, AGENT_RETRO_HOME: home }, encoding: 'utf8', cwd: path.dirname(CLI) });
  const ev = JSON.parse(r.stdout || '[]');
  assert.ok(ev.some((e) => e.role === 'user' && e.text === 'fix the a | b parser please'), r.stderr);
  assert.ok(ev.every((e) => typeof e.ts === 'number' && e.ts === Date.parse('2026-03-02T10:00:00Z')));
  assert.ok(ev.some((e) => e.role === 'title' && e.text.includes('\n')));
});

test('review: the dashboard refuses foreign Host headers and never serves raw history lines', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-retro-ui-'));
  writeFixtures(home);
  fs.writeFileSync(path.join(home, '.claude/history.jsonl'), JSON.stringify({ display: 'my secret typed line', timestamp: Date.now() }) + '\n');
  const port = 4300 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, [CLI, '--ui', '--port', String(port), '--dir', path.join(home, '.claude/projects')], { env: { ...process.env, AGENT_RETRO_HOME: home }, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((res) => child.stdout.on('data', (d) => { if (/agent-retro UI/.test(d)) res(); }));
    const http = await import('node:http');
    const get = (pathname, host) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: pathname, headers: { Host: host } }, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => res([r.statusCode, b])); }).on('error', rej));
    assert.equal((await get('/api/data', `evil.example:${port}`))[0], 421);
    const [code, body] = await get('/api/data', `127.0.0.1:${port}`);
    assert.equal(code, 200);
    assert.ok(!body.includes('my secret typed line'));
    assert.equal(JSON.parse(body).sessions.count, 3, '--dir from the command line is honoured');
  } finally { child.kill(); }
});
