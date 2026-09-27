/**
 * mcp.mjs — a zero-dependency MCP server (JSON-RPC 2.0 over stdio, one message per line)
 * that exposes agent-retro telemetry to agents. It is a thin read layer over the same
 * views the export writes (telemetry.mjs), so both surfaces always agree.
 *
 * Register with Claude Code:
 *   claude mcp add agent-retro -- npx -y agent-retro --mcp --all-agents
 *
 * stdout carries protocol messages only; diagnostics go to stderr.
 */
import readline from 'node:readline';
import { loadTelemetry, loadHistory } from './agent-retro.mjs';
import { sessionView, rollupView, generator, SCHEMA_VERSION } from './telemetry.mjs';
import { TASK_IDS } from './sessions.mjs';

const PROTOCOL = '2025-06-18';
const CACHE_MS = 60000;

const FILTERS = {
  days: { type: 'number', description: 'Only include activity from the last N days' },
  project: { type: 'string', description: 'Project name substring' },
};
const SORTS = ['recent', 'cost', 'turns', 'duration', 'tools'];

export const TOOLS = [
  {
    name: 'get_overview',
    description: 'Summary of coding-agent usage: volume, per-task profile (sessions, turns, cost, error and correction rates, top tools/commands/skills), tokens, cost, estimated context sources (what fills the window), compactions, subagent types, risk signals, why tool calls fail, working vs waiting time, repeated command sequences, edit habits (edits without a read first, files patched 5+ times, what you interrupted), a before/after trend (the reviewed month vs the month before), and top tools, skills and MCP servers.',
    inputSchema: { type: 'object', properties: { ...FILTERS } },
  },
  {
    name: 'list_sessions',
    description: 'Per-session telemetry records, newest first by default. Each record has the task label, turns, tool usage, shell command heads, files, skills, subagents, tokens, cost and efficiency signals.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILTERS,
        task: { type: 'string', enum: TASK_IDS, description: 'Primary task label' },
        agent: { type: 'string', description: 'Agent id, e.g. claude, codex, pi' },
        sort: { type: 'string', enum: SORTS },
        limit: { type: 'number', description: 'Max records (default 20, max 200)' },
      },
    },
  },
  {
    name: 'get_recommendations',
    description: 'Evidence-backed changes that would make this person\'s agent usage cheaper or safer: unused plugins, skills and MCP servers to disable, context-heavy habits, secret-file access, repeated prompts to save as commands. Each has the evidence, the action, and a ready-to-apply fix (settings JSON, shell commands, a CLAUDE.md line, or a command file). Present them to the user; never apply a fix without their approval.',
    inputSchema: { type: 'object', properties: { ...FILTERS } },
  },
  {
    name: 'get_retro',
    description: 'A personal review of one period of agent use (a calendar month by default, or the configured cycle): a period card (sessions, spend, agent hours, main task), Went well / Didn\'t go well, Change (one list of things to start or stop; the top three, marked `next`, carry the metric to watch and one is marked as the experiment; `actions` repeats those three with their fixes), and Did it work? (the last saved review\'s actions, baseline → now). Good for "how did my agent use go last month?".',
    inputSchema: { type: 'object', properties: { ...FILTERS, period: { type: 'string', description: 'A date inside the period to review (YYYY-MM-DD); default: the last completed period' } } },
  },
  {
    name: 'get_extensions',
    description: 'Per-extension usage from the session logs: plugins (skills used/listed, MCP servers, enabled key), skills (uses, sessions used vs listed, tokens each load, listing cost), MCP servers (source, calls, failure rate and cause, output tokens), hooks (runs, p90 duration, failures, context injected per session) and slash commands. Each has a verdict: used, rarely used, unused.',
    inputSchema: { type: 'object', properties: { ...FILTERS, kind: { type: 'string', enum: ['plugins', 'skills', 'mcpServers', 'hooks', 'commands'], description: 'Only this kind' }, verdict: { type: 'string', enum: ['used', 'rarely used', 'unused'] } } },
  },
  {
    name: 'get_context',
    description: 'What fills the main conversation\'s context window, per session: where it starts (the real window at the first reply) and how big it grows, the fixed part loaded before the first prompt (system prompt and built-in tools, which the logs never show, tool and MCP listings, CLAUDE.md, start-up hooks) against what the work adds, every source, every item (a tool\'s results, an MCP server\'s tool listing or output, a plugin\'s skill listing, a skill\'s loads, a hook) with tokens per session and what to try, the heaviest sessions, and the biggest item you can change. Estimates at ~4 characters a token; use it to find the context bottleneck.',
    inputSchema: { type: 'object', properties: { ...FILTERS } },
  },
  {
    name: 'get_agent_output',
    description: 'What the agent writes (replies, reasoning, tool calls and edits) and how the setup lines up with results: per model, and per skill, MCP server and plugin (sessions with it vs without), the median output and cost per session, prompts per session, correction rate, failed tool calls and fix loops, each with its main task. Correlation, not causation. Also the cost breakdown by task, model and project, the token mix, and the costliest sessions.',
    inputSchema: { type: 'object', properties: { ...FILTERS } },
  },
  {
    name: 'get_session',
    description: 'One session record by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'get_task_profile',
    description: 'Everything known about one task type: aggregate stats, the ids of its costliest and longest sessions (drill in with get_session), and its playbook recommendation when practices are missing: which good practices its sessions skip, useful tools, and a slash-command workflow to install.',
    inputSchema: { type: 'object', properties: { ...FILTERS, task: { type: 'string', enum: TASK_IDS } }, required: ['task'] },
  },
];

const SORT_KEY = {
  recent: (s) => s.start || 0, cost: (s) => s.costUsd, turns: (s) => s.turns.human,
  duration: (s) => s.durationMin || 0, tools: (s) => s.tools.total,
};

export function createServer(o = {}) {
  const level = o.text || 'excerpts';
  const cache = new Map();

  async function telemetry(args = {}) {
    const f = { days: args.days || null, project: args.project || null, periodPick: args.period || null };
    const key = JSON.stringify(f);
    const hit = cache.get(key);
    // The server lives as long as the Claude Code session: re-read the logs once the snapshot is a minute old.
    if (!hit || Date.now() - hit.at > CACHE_MS) {
      cache.set(key, { at: Date.now(), value: (async () => {
        const opts = { ...o, dirs: o.dirs || [], ...f, top: 15, history: true };
        const t = await loadTelemetry(opts);
        t.analysis.cliHistory = loadHistory(opts);
        return t;
      })() });
    }
    try { return await cache.get(key).value; } catch (err) { cache.delete(key); throw err; }
  }

  const handlers = {
    async get_overview(args) {
      const { analysis } = await telemetry(args);
      const r = rollupView(analysis, level);
      const top = (m, n = 10) => Object.entries(m || {}).sort((a, b) => b[1] - a[1]).slice(0, n);
      return {
        schemaVersion: SCHEMA_VERSION, textLevel: level, scope: r.scope, volume: r.volume, sessions: r.sessions,
        tasks: r.tasks, tokens: { ...r.tokens, daily: undefined }, cost: r.cost, context: r.context,
        contextBreakdown: r.contextBreakdown, subagentTypes: r.subagentTypes, risk: r.risk,
        trend: r.trend, time: r.time, toolErrors: r.toolErrors, workflows: r.workflows, prompting: r.prompting,
        topTools: top(r.tools.byName), toolBuckets: r.tools.buckets, topSkills: top(r.skills),
        mcpServers: top(r.plugins.mcpServers), agents: r.agentMatrix, findings: r.findings,
      };
    },
    async list_sessions(args) {
      const { sessions } = await telemetry(args);
      let list = sessions;
      if (args.task) list = list.filter((s) => s.task.primary === args.task);
      if (args.agent) list = list.filter((s) => s.agent === args.agent);
      const sort = SORT_KEY[args.sort] || SORT_KEY.recent;
      const limit = Math.max(1, Math.min(200, Number(args.limit) || 20));
      return { total: list.length, sessions: [...list].sort((a, b) => sort(b) - sort(a)).slice(0, limit).map((s) => sessionView(s, level)) };
    },
    async get_recommendations(args) {
      const { analysis } = await telemetry(args);
      return { recommendations: rollupView(analysis, level).recommendations };
    },
    async get_retro(args) {
      const { analysis } = await telemetry(args);
      return rollupView(analysis, level).retro;
    },
    async get_extensions(args) {
      const { analysis } = await telemetry(args);
      const E = rollupView(analysis, level).extensions;
      const kinds = args.kind ? [args.kind] : ['plugins', 'skills', 'mcpServers', 'hooks', 'commands'];
      return Object.fromEntries(kinds.map((kind) => [kind, args.verdict ? E[kind].filter((x) => x.verdict === args.verdict) : E[kind]]));
    },
    async get_context(args) {
      const { analysis } = await telemetry(args);
      const r = rollupView(analysis, level);
      return { context: r.contextAnalysis, sources: r.contextBreakdown, window: r.context };
    },
    async get_agent_output(args) {
      const { analysis } = await telemetry(args);
      const r = rollupView(analysis, level);
      return { output: r.agentOutput, cost: r.costBreakdown };
    },
    async get_session(args) {
      const { sessions } = await telemetry({});
      const s = sessions.find((x) => x.id === args.id);
      if (!s) throw new Error(`no session with id ${args.id}`);
      return sessionView(s, level);
    },
    async get_task_profile(args) {
      const { analysis, sessions } = await telemetry(args);
      const profile = analysis.tasks[args.task];
      if (!profile) return { task: args.task, sessions: 0 };
      const list = sessions.filter((s) => s.task.primary === args.task);
      const ids = (key) => [...list].sort((a, b) => SORT_KEY[key](b) - SORT_KEY[key](a)).slice(0, 5).map((s) => s.id);
      const playbook = rollupView(analysis, level).recommendations.find((r) => r.task === args.task) || null;
      return { task: args.task, ...rollupView({ ...analysis, tasks: { [args.task]: profile } }, level).tasks[args.task], costliest: ids('cost'), longest: ids('turns'), playbook };
    },
  };

  /** Handle one JSON-RPC message; resolves to a response object, or null for notifications. */
  return async function handle(msg) {
    const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid Request');
    const isNotification = msg.id === undefined;
    switch (msg.method) {
      case 'initialize':
        return reply({ protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: generator(),
          instructions: 'Local coding-agent session telemetry. Start with get_overview, then list_sessions / get_task_profile to drill into a task.' });
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: TOOLS });
      case 'tools/call': {
        const { name, arguments: args = {} } = msg.params || {};
        const h = handlers[name];
        if (!h) return fail(-32602, `Unknown tool: ${name}`);
        try {
          const result = await h(args);
          return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result });
        } catch (err) {
          return reply({ content: [{ type: 'text', text: String(err && err.message || err) }], isError: true });
        }
      }
      default:
        return isNotification ? null : fail(-32601, `Method not found: ${msg.method}`);
    }
  };
}

export async function startMcp(o = {}) {
  const handle = createServer(o);
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
    handle(msg).then((res) => { if (res && msg.id !== undefined) send(res); }, (err) => console.error('[agent-retro mcp]', err));
  }
}
