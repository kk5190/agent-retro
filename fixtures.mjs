/**
 * fixtures.mjs — small, real-shaped agent logs for the test suite.
 *
 * writeFixtures(home) writes every agent store the tests read into `home` (a throwaway
 * directory; point AGENT_RETRO_HOME at it). Numbers in tests.mjs depend on these exact records.
 */
import fs from 'node:fs';
import path from 'node:path';

export function writeFixtures(HOME) {

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

  // Claude Code: three archetypal sessions + a subagent transcript for the review one.
  const J = (o) => JSON.stringify(o);
  const cl = (sid, t, extra) => ({ sessionId: sid, timestamp: `2026-03-01T10:${String(t).padStart(2, '0')}:00Z`, cwd: '/Users/x/workspace/rev', gitBranch: 'main', ...extra });
  const user = (sid, t, text) => cl(sid, t, { type: 'user', promptSource: 'typed', message: { role: 'user', content: text } });
  const tool = (sid, t, name, input, usage) => cl(sid, t, { type: 'assistant', message: { model: 'claude-opus-5-5', role: 'assistant', usage, content: [{ type: 'tool_use', id: `tu${t}`, name, input }] } });
  const errResult = (sid, t) => cl(sid, t, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', is_error: true, content: 'boom' }] } });
  const U = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 };

  write('.claude/projects/-Users-x-workspace-rev/rev-1.jsonl', [
    J(user('rev-1', 0, 'review this PR #42 before I merge, token=abc123secret and mail me at a@b.co')),
    J(tool('rev-1', 1, 'Bash', { command: 'gh pr diff 42' }, U)),
    J(tool('rev-1', 2, 'Bash', { command: 'cd /Users/x/workspace/rev && git diff main...HEAD' }, U)),
    J(tool('rev-1', 3, 'Skill', { skill: 'code-review' }, U)),
    J(errResult('rev-1', 4)),
    J(tool('rev-1', 5, 'Agent', { subagent_type: 'code-reviewer', description: 'review auth' }, U)),
    J(user('rev-1', 9, 'no, focus on the auth module')),
    J({ type: 'cost-state', sessionId: 'rev-1', totalCostUSD: 0.42, modelUsage: {} }),
    J({ type: 'ai-title', sessionId: 'rev-1', aiTitle: 'Review PR 42 at /Users/x/secret-proj' }),
  ]);
  write('.claude/projects/-Users-x-workspace-rev/rev-1/subagents/agent-a1.jsonl', [
    J(cl('rev-1', 6, { type: 'user', isSidechain: true, agentId: 'a1', message: { role: 'user', content: 'You are a code reviewer. Review the auth diff.' } })),
    J(cl('rev-1', 7, { type: 'assistant', isSidechain: true, agentId: 'a1', message: { role: 'assistant', usage: { input_tokens: 5, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 }, content: [{ type: 'thinking', thinking: 'x'.repeat(4000) }, { type: 'tool_use', name: 'Read', input: { file_path: '/Users/x/workspace/rev/src/auth.ts' } }] } })),
  ]);
  write('.claude/projects/-Users-x-workspace-rev/rev-1/subagents/agent-a1.meta.json', J({ agentType: 'code-reviewer', description: 'review auth' }));
  const toolOut = (sid, t, id, text) => cl(sid, t, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
  write('.claude/projects/-Users-x-workspace-rev/dbg-1.jsonl', [
    J(cl('dbg-1', 0, { type: 'attachment', attachment: { type: 'instructions', files: [{ path: '/Users/x/.claude/CLAUDE.md', content: 'm'.repeat(800) }] } })),
    J(user('dbg-1', 0, 'the app crashes with TypeError on login, fix it')),
    J(cl('dbg-1', 0, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/Users/x/workspace/rev/.env' } }] } })),
    J(toolOut('dbg-1', 0, 'r1', 'o'.repeat(4000))),
    J(errResult('dbg-1', 0)),
    J(tool('dbg-1', 0, 'Bash', { command: 'rm -rf dist && rm -rf src/legacy' })),
    J(errResult('dbg-1', 0)),
    J({ type: 'system', subtype: 'compact_boundary', sessionId: 'dbg-1', timestamp: '2026-03-01T10:00:30Z', compactMetadata: { trigger: 'auto', preTokens: 180000 } }),
    J({ type: 'system', subtype: 'api_error', sessionId: 'dbg-1', timestamp: '2026-03-01T10:00:31Z' }),
    J(tool('dbg-1', 1, 'Bash', { command: 'npm test' })),
    J(errResult('dbg-1', 2)),
    J(tool('dbg-1', 3, 'Edit', { file_path: '/Users/x/workspace/rev/src/login.ts' })),
    J(tool('dbg-1', 4, 'Bash', { command: 'npm test' })),
    J(user('dbg-1', 5, 'still broken, why does it throw?')),
  ]);
  write('.claude/projects/-Users-x-workspace-rev/feat-1.jsonl', [
    J(user('feat-1', 0, 'implement a dark mode toggle in the settings screen')),
    J(tool('feat-1', 1, 'Write', { file_path: '/Users/x/workspace/rev/src/Toggle.tsx' })),
    J(tool('feat-1', 2, 'Edit', { file_path: '/Users/x/workspace/rev/src/Settings.tsx' })),
    J(user('feat-1', 3, 'yes')),
  ]);

  // Installed setup: every session lists the same skills and MCP servers.
  const listing = (sid) => [
    J(cl(sid, 0, { type: 'attachment', attachment: { type: 'skill_listing', isInitial: true, content: ['- code-review: Review a diff for bugs.', '- idle-plugin:alpha: Does alpha things nobody asks for.', '- idle-plugin:beta: Does beta things.', '- used-plugin:gamma: Gamma helper.', '- my-old-skill: A personal skill I forgot about.'].join('\n') } })),
    J(cl(sid, 0, { type: 'attachment', attachment: { type: 'mcp_instructions_delta', addedNames: ['dusty-server'], addedBlocks: ['Instructions for a server nobody calls.'] } })),
  ];
  for (const sid of ['rev-1', 'dbg-1', 'feat-1']) {
    const f = path.join(HOME, '.claude/projects/-Users-x-workspace-rev', `${sid}.jsonl`);
    fs.writeFileSync(f, listing(sid).join('\n') + '\n' + fs.readFileSync(f, 'utf8'));
  }
  fs.appendFileSync(path.join(HOME, '.claude/projects/-Users-x-workspace-rev/feat-1.jsonl'), [
    J(tool('feat-1', 5, 'Skill', { skill: 'used-plugin:gamma' })),
    // the load the Skill call triggers: one use, not two; the name resolves from the plugin cache path
    J(cl('feat-1', 5, { type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /Users/x/.claude/plugins/cache/market/used-plugin/1.0.0/skills/gamma\n' + 'g'.repeat(3996) }] } })),
    J(tool('feat-1', 6, 'mcp__busy-srv__fetch', { url: 'a' })),
    J(tool('feat-1', 7, 'mcp__busy-srv__fetch', { url: 'b' })),
    J(cl('feat-1', 7, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu7', is_error: true, content: 'Request timed out after 30s' }] } })),
  ].join('\n') + '\n');
  for (const sid of ['rev-1', 'dbg-1', 'feat-1']) fs.appendFileSync(path.join(HOME, '.claude/projects/-Users-x-workspace-rev', `${sid}.jsonl`), [
    J(cl(sid, 0, { type: 'attachment', attachment: { type: 'hook_success', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', command: '/Users/x/bin/intro.sh', durationMs: 1200, exitCode: 0 } })),
    J(cl(sid, 0, { type: 'attachment', attachment: { type: 'hook_additional_context', hookName: 'SessionStart', hookEvent: 'SessionStart', content: ['h'.repeat(8000)] } })),
  ].join('\n') + '\n');
  write('.claude/settings.json', J({ enabledPlugins: { 'idle-plugin@market': true, 'used-plugin@market': true } }));
  write('.claude.json', J({ mcpServers: { 'dusty-server': { command: 'x' } } }));
  fs.mkdirSync(path.join(HOME, '.claude/skills/my-old-skill'), { recursive: true });
}

// ---------------------------------------------------------------------------
// Demo history — a believable month of Claude Code sessions for --demo and screenshots
// ---------------------------------------------------------------------------
/** Deterministic pseudo-random numbers, so every demo run looks the same. */
function prng(seed) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

const ARCHETYPES = [
  { task: 'review', n: 8, title: (i) => `Review PR #${120 + i}`, prompt: (i) => `review PR #${120 + i} before I merge it`,
    steps: (r, i) => [['Bash', { command: r() < 0.6 ? `gh pr diff ${120 + i}` : 'git diff main...HEAD' }, 'diff --git a/src/api.ts b/src/api.ts\n' + 'x'.repeat(3000)],
      ['Read', { file_path: '/home/dev/app/src/api.ts' }, 'y'.repeat(4000)],
      ...(r() < 0.4 ? [['Skill', { skill: 'review-kit:code-review' }, 'Launching skill']] : []),
      ...(r() < 0.3 ? [['Bash', { command: 'npm test' }, 'PASS  42 tests']] : [])] },
  { task: 'debug', n: 8, title: () => 'Fix checkout crash', prompt: () => 'the checkout page crashes with TypeError: cannot read total, fix it',
    steps: (r) => [['Read', { file_path: '/home/dev/app/src/checkout.ts' }, 'z'.repeat(5000)],
      ['Edit', { file_path: '/home/dev/app/src/checkout.ts' }, 'ok'],
      ['Bash', { command: 'npm test' }, 'Exit code 1\nFAIL src/checkout.test.ts', true],
      ['Edit', { file_path: '/home/dev/app/src/checkout.ts' }, 'ok'],
      ['Bash', { command: 'npm test' }, r() < 0.5 ? 'Exit code 1\nFAIL src/checkout.test.ts' : 'PASS', r() < 0.5],
      ['Edit', { file_path: '/home/dev/app/src/checkout.test.ts' }, 'ok'],
      ['Bash', { command: 'npm test' }, 'PASS']] },
  { task: 'feature', n: 7, title: () => 'CSV export for reports', prompt: () => 'implement CSV export for the reports page',
    steps: (r) => [...(r() < 0.3 ? [['EnterPlanMode', {}, 'ok']] : []),
      ['Write', { file_path: '/home/dev/app/src/export/csv.ts' }, 'ok'], ['Edit', { file_path: '/home/dev/app/src/reports.tsx' }, 'ok'],
      ...(r() < 0.5 ? [['Bash', { command: 'npm test' }, 'PASS']] : []),
      ['Bash', { command: 'git add -A' }, ''], ['Bash', { command: 'git commit -m "Add CSV export"' }, '1 file changed']] },
  { task: 'ui', n: 7, title: () => 'Polish pricing page on mobile', prompt: () => 'polish the pricing page layout on mobile, make it beautiful',
    steps: (r) => [['Edit', { file_path: '/home/dev/app/src/pricing.css' }, 'ok'],
      ['mcp__claude-in-chrome__navigate', { url: 'http://localhost:3000/pricing' }, 'navigated'],
      ['mcp__claude-in-chrome__computer', { action: 'screenshot' }, 'IMAGE'],
      ['mcp__claude-in-chrome__computer', { action: 'screenshot' }, r() < 0.3 ? 'Error capturing screenshot: Script injection timed out' : 'IMAGE', r() < 0.3],
      ['Edit', { file_path: '/home/dev/app/src/pricing.css' }, 'ok'],
      ['mcp__claude-in-chrome__computer', { action: 'screenshot' }, 'IMAGE']] },
  { task: 'research', n: 4, title: () => 'How auth middleware works', prompt: () => 'explain how the auth middleware works and compare it with the session approach',
    steps: () => [['Agent', { subagent_type: 'Explore', description: 'map auth flow' }, 'summary of auth flow'],
      ['WebSearch', { query: 'express session vs jwt middleware' }, 'results'], ['Read', { file_path: '/home/dev/app/src/auth.ts' }, 'a'.repeat(3000)]] },
  { task: 'git', n: 2, title: () => 'Open PR for release', prompt: () => 'commit this and open a PR',
    steps: () => [['Bash', { command: 'git status' }, 'modified: src/app.ts'], ['Bash', { command: 'git diff' }, 'b'.repeat(1500)],
      ['Bash', { command: 'git commit -am "Release prep"' }, 'ok'], ['Bash', { command: 'git push' }, 'ok'], ['Bash', { command: 'gh pr create --fill' }, 'https://example.com/pr/9']] },
];

const DEMO_SKILLS = ['- review-kit:code-review: Structured code review with a severity-ranked checklist.', '- review-kit:security-review: Security pass over a diff.',
  '- plan-kit:brainstorm: Explore intent before building.', '- plan-kit:debug-steps: Hypothesis-first debugging.',
  '- legacy-tools:deploy-v1: Deploy with the old pipeline.', '- legacy-tools:migrate-db: Run the old database migrations.', '- legacy-tools:lint-fix: Old lint autofixer.',
  '- deploy-notes: Personal notes for deploying the marketing site.'].join('\n');

/** Write a month of demo sessions plus a matching Claude Code setup into `home`. Returns the session count. */
export function writeDemo(home) {
  const r = prng(7);
  const J = (o) => JSON.stringify(o);
  const put = (rel, text) => { const p = path.join(home, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  const plan = ARCHETYPES.flatMap((a) => Array.from({ length: a.n }, (_, i) => [a, i])).sort(() => r() - 0.5);
  const now = Date.now();
  plan.forEach(([a, i], k) => {
    const sid = `demo-${String(k).padStart(2, '0')}`;
    let t = now - (plan.length - k) * 0.78 * 864e5 + Math.floor(9 + r() * 10) * 3600e3;
    let ctx = 20000;
    const at = () => new Date((t += (40 + r() * 140) * 1000)).toISOString();
    const base = (extra) => ({ sessionId: sid, cwd: '/home/dev/app', gitBranch: `work/${a.task}-${i}`, uuid: `${sid}-${Math.round(r() * 1e9)}`, ...extra });
    const lines = [
      J(base({ type: 'attachment', timestamp: at(), attachment: { type: 'skill_listing', isInitial: true, content: DEMO_SKILLS } })),
      J(base({ type: 'attachment', timestamp: at(), attachment: { type: 'mcp_instructions_delta', addedNames: ['claude-in-chrome', 'linear'], addedBlocks: ['Browser automation in Chrome.', 'Linear issues and projects.'] } })),
      J(base({ type: 'attachment', timestamp: at(), attachment: { type: 'hook_success', hookName: 'SessionStart:startup', hookEvent: 'SessionStart', command: '~/bin/project-brief.sh', durationMs: 300 + Math.round(r() * 900), exitCode: 0 } })),
      J(base({ type: 'attachment', timestamp: at(), attachment: { type: 'hook_additional_context', hookName: 'SessionStart', hookEvent: 'SessionStart', content: ['Project brief: '.padEnd(6000, 'x')] } })),
      J(base({ type: 'user', timestamp: at(), promptSource: 'typed', message: { role: 'user', content: a.prompt(i) } })),
    ];
    const assistantTool = (name, input, id) => {
      ctx += 3000 + Math.round(r() * 9000);
      return J(base({ type: 'assistant', timestamp: at(), message: { model: 'claude-opus-5-5', role: 'assistant',
        usage: { input_tokens: 400, output_tokens: 300 + Math.round(r() * 900), cache_read_input_tokens: ctx, cache_creation_input_tokens: 2000 },
        content: [{ type: 'text', text: 'Working on it.' }, { type: 'tool_use', id, name, input }] } }));
    };
    const result = (id, out, isErr) => J(base({ type: 'user', timestamp: at(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: !!isErr,
      content: out === 'IMAGE' ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] : out }] } }));
    const steps = a.steps(r, i);
    steps.forEach(([name, input, out, isErr], j) => {
      const id = `${sid}-t${j}`;
      lines.push(assistantTool(name, input, id), result(id, out, isErr));
      if (name === 'Edit' && r() < 0.5) lines.push(J(base({ type: 'attachment', timestamp: at(), attachment: { type: 'hook_success', hookName: 'PostToolUse:Edit', hookEvent: 'PostToolUse', command: 'prettier --write', durationMs: 40 + Math.round(r() * 80), exitCode: 0 } })));
      if (j === 1 && r() < 0.35) lines.push(J(base({ type: 'user', timestamp: at(), promptSource: 'typed', message: { role: 'user', content: 'continue' } })));
      if (j === 2 && r() < 0.2) lines.push(J(base({ type: 'user', timestamp: at(), promptSource: 'typed', message: { role: 'user', content: 'no, reuse the existing helper instead' } })));
    });
    lines.push(J(base({ type: 'assistant', timestamp: at(), message: { model: 'claude-opus-5-5', role: 'assistant', usage: { input_tokens: 300, output_tokens: 600, cache_read_input_tokens: ctx, cache_creation_input_tokens: 0 }, content: [{ type: 'text', text: 'Done.' }] } })));
    lines.push(J({ type: 'ai-title', sessionId: sid, aiTitle: a.title(i) }));
    lines.push(J({ type: 'cost-state', sessionId: sid, totalCostUSD: +(0.4 + r() * 5).toFixed(2), modelUsage: {} }));
    put(`.claude/projects/-home-dev-app/${sid}.jsonl`, lines.join('\n') + '\n');
  });
  put('.claude/settings.json', J({ enabledPlugins: { 'review-kit@community': true, 'plan-kit@community': true, 'legacy-tools@internal': true } }));
  put('.claude.json', J({ mcpServers: { linear: { command: 'linear-mcp' } } }));
  fs.mkdirSync(path.join(home, '.claude/skills/deploy-notes'), { recursive: true });
  // a retro "saved" two weeks ago, so the demo's Kaizen block has something to review
  const saved = new Date(now - 14 * 864e5).toISOString();
  put(`.agent-retro/retros/${saved.slice(0, 10)}.json`, J({ version: 1, savedAt: saved, period: null, actions: [
    { id: 'screenshots', title: 'Read pages as text instead of screenshots', metric: 'browserOutputShare', baseline: 0.85 },
    { id: 'check-ins', title: 'Cut the “continue?” check-ins', metric: 'ackRate', baseline: 0.12 },
    { id: 'unused-mcp', title: 'Remove 1 MCP server you never call', metric: 'listingTokensPerSession', baseline: 160 },
  ] }));
  return plan.length;
}
