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

// Point the adapters at a throwaway HOME (must be set before importing agents.mjs).
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-habits-fixtures-'));
process.env.CC_HABITS_HOME = HOME;

function write(rel, lines) {
  const p = path.join(HOME, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Array.isArray(lines) ? lines.join('\n') + '\n' : lines);
}

// --- fixtures ---------------------------------------------------------------
write('.pi/agent/sessions/demo/s1.jsonl', [
  JSON.stringify({ type: 'session', version: 1, id: 'pi-1', timestamp: '2026-01-01T10:00:00Z', cwd: '/Users/x/workspace/demo' }),
  JSON.stringify({ type: 'message', id: 'm1', timestamp: '2026-01-01T10:00:05Z', message: { role: 'user', content: [{ type: 'text', text: 'hello world' }] } }),
  JSON.stringify({ type: 'message', id: 'm2', timestamp: '2026-01-01T10:00:09Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }, { type: 'toolCall', name: 'read_file', id: 't1' }], usage: { input: 100, output: 20, cacheRead: 300, cacheWrite: 0, reasoning: 5, cost: { total: 0.0012 } } } }),
  JSON.stringify({ type: 'message', id: 'm3', timestamp: '2026-01-01T10:00:10Z', message: { role: 'toolResult', toolName: 'read_file', content: 'file body' } }),
]);

write('.codex/sessions/2026/01/01/rollout-x.jsonl', [
  JSON.stringify({ timestamp: '2026-01-02T10:00:00Z', type: 'session_meta', payload: { session_id: 'cx-1', cwd: '/Users/x/workspace/codexdemo' } }),
  JSON.stringify({ timestamp: '2026-01-02T10:00:05Z', type: 'event_msg', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'add a button' }] } }),
  JSON.stringify({ timestamp: '2026-01-02T10:00:09Z', type: 'event_msg', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } }),
  JSON.stringify({ timestamp: '2026-01-02T10:00:10Z', type: 'event_msg', payload: { type: 'function_call', name: 'shell', arguments: '{}' } }),
  JSON.stringify({ timestamp: '2026-01-02T10:00:11Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 100, reasoning_output_tokens: 40 }, last_token_usage: { input_tokens: 1200 } } } }),
]);

write('.continue/sessions/sess-1.json', JSON.stringify({
  sessionId: 'sess-1', title: 't', workspaceDirectory: '/Users/x/workspace/continuedemo',
  history: [
    { message: { role: 'user', content: 'do the thing' } },
    { message: { role: 'assistant', content: [{ type: 'text', text: 'ok done' }] } },
  ],
}));

write('.local/share/opencode/storage/session/g1/ses_x.json', JSON.stringify({ id: 'ses_x', directory: '/Users/x/workspace/ocdemo', title: 't' }));
write('.local/share/opencode/storage/message/ses_x/m1.json', JSON.stringify({ id: 'm1', sessionID: 'ses_x', role: 'user', time: { created: 1767225600000 } }));
write('.local/share/opencode/storage/message/ses_x/m2.json', JSON.stringify({ id: 'm2', sessionID: 'ses_x', role: 'assistant', time: { created: 1767225601000 } }));
write('.local/share/opencode/storage/part/m1/p1.json', JSON.stringify({ id: 'p1', messageID: 'm1', sessionID: 'ses_x', type: 'text', text: 'hello opencode' }));
write('.local/share/opencode/storage/part/m2/p2.json', JSON.stringify({ id: 'p2', messageID: 'm2', sessionID: 'ses_x', type: 'text', text: 'hi from assistant' }));

// A deliberately novel/renamed schema (simulates an upstream format change).
write('.codex/sessions/2026/02/02/rollout-novel.jsonl', [
  JSON.stringify({ when: '2026-02-02T00:00:00Z', author: 'human', body: 'novel schema prompt' }),
]);

const { collectFor, collectGeneric, harvestEvents, adapterHealth } = await import('./agents.mjs');

const promptsOf = (ev) => ev.filter((e) => e.role === 'user' || e.role === 'assistant');
const toolsOf = (ev) => ev.filter((e) => e.role === 'tool');

// --- tests ------------------------------------------------------------------
test('pi: messages, tools, and project attribution', () => {
  const ev = collectFor('pi', {});
  const p = promptsOf(ev);
  assert.equal(p.length, 2);
  assert.equal(toolsOf(ev).length, 2);
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
