#!/usr/bin/env node
/**
 * agent-retro — session-transcript analysis for coding agents.
 *
 * Reads local agent logs (Claude Code by default; --all-agents for Codex, pi,
 * opencode, Continue, Zed, Cursor), builds per-session telemetry (task label,
 * turns, tools, cost, efficiency signals) plus a rollup, and serves it to humans
 * (report, web UI) and to agents (--export bundle, --mcp server).
 *
 * Zero dependencies. Node >= 18.
 *
 * Usage:
 *   node agent-retro.mjs                       # human-readable report
 *   node agent-retro.mjs --md                  # markdown report
 *   node agent-retro.mjs --json                # machine-readable JSON
 *   node agent-retro.mjs --days 30             # only last 30 days
 *   node agent-retro.mjs --project myportfolio # filter to one project
 *   node agent-retro.mjs --tz 5.5              # force a UTC offset (hours)
 *   node agent-retro.mjs --top 15 --include-transcripts --no-history
 *   node agent-retro.mjs --ui                  # local web dashboard (http://127.0.0.1:4173)
 *   node agent-retro.mjs --ui --port 5000 --open
 *   node agent-retro.mjs --export ./telemetry  # telemetry.json + sessions.jsonl for agents
 *   node agent-retro.mjs --sessions --text none # one session record per line on stdout
 *   node agent-retro.mjs --mcp --all-agents     # MCP server on stdio
 *
 * Flags:
 *   --dir <path>            Add/override a log root (repeatable)
 *   --project <substr>      Filter project dir names by substring
 *   --days <n>              Only include records within the last n days
 *   --top <n>               Rows per ranked list (default 15)
 *   --tz <hours>            UTC offset for time buckets (default: machine local)
 *   --json | --md           Output format
 *   --ui                    Serve the local web dashboard instead of printing
 *   --port <n>              UI port (default 4173)
 *   --open                  Open the UI in your browser
 *   --include-transcripts   Also read ~/.claude/transcripts/*.jsonl
 *   --all-agents            Merge every detected coding agent's logs
 *   --agent <id>            Restrict to one agent (claude|pi|codex|opencode|continue|zed|cursor)
 *   --scan                  List detected agent stores and sizes, then exit
 *   --list-agents           Print parseable agent ids, then exit
 *   --doctor                Check each adapter's yield; flag stale/rot
 *   --export <dir>          Write the telemetry bundle (schema v1) to <dir>
 *   --sessions              Print session records as JSON Lines
 *   --text <level>          Text in exported data: none | excerpts (default) | full
 *   --mcp                   Run the MCP server on stdio
 *   --split <date>          Compare before/after a date (default: last 14 days vs the 14 before)
 *   --label <id>=<task>     Correct one session's task label (<id>= clears it)
 *   --label-accuracy        How often the rules agree with your corrected labels
 *   --demo                  Use a built-in month of synthetic sessions instead of your logs
 *   --retro                 Print only the sprint retro (with --md: paste-ready markdown)
 *   --save-retro            Save this retro's action items so the next one reviews them
 *   --sprint-start <date>   Your sprint calendar: any sprint's first day (e.g. a Wednesday)
 *   --sprint-days <n>       Sprint length in days (default 14)
 *   --save-sprint           Remember --sprint-start/--sprint-days in ~/.agent-retro/config.json
 *   --sprint <date>         Review the sprint containing <date> (default: the last completed one)
 *   --no-history            Skip ~/.claude/history.jsonl
 *   --all-sources           Include SDK/system-injected prompts too
 *   --errors                Print parse warnings to stderr
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadEvents, eventsToData } from './agents.mjs';
import { recommend, readClaudeConfig, REC_METRIC } from './recommend.mjs';
import { summarizePrompts } from './prompts.mjs';
import { buildRetro, retroSnapshot } from './retro.mjs';
import { buildSessions, summarizeTasks, summarizeSessions, summarizeInventory, summarizeExtensions, comparePeriods, sprintWindows, defaultSprint, localDay, localDate, TASK_IDS, toolBucket } from './sessions.mjs';

const home = () => process.env.AGENT_RETRO_HOME || os.homedir();

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const o = {
    dirs: [], project: null, days: null, top: 15, tz: null, format: 'text',
    includeTranscripts: false, history: true, allSources: false, errors: false,
    ui: false, port: 4173, open: false,
    allAgents: false, agent: null, scan: false, listAgents: false, doctor: false,
    exportDir: null, sessions: false, text: 'excerpts', mcp: false, split: null, label: null, labelAccuracy: false, demo: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--dir': o.dirs.push(next()); break;
      case '--project': o.project = next(); break;
      case '--days': o.days = Number(next()); break;
      case '--top': o.top = Number(next()); break;
      case '--tz': o.tz = Number(next()); break;
      case '--json': o.format = 'json'; break;
      case '--md': o.format = 'md'; break;
      case '--include-transcripts': o.includeTranscripts = true; break;
      case '--ui': o.ui = true; break;
      case '--port': o.port = Number(next()); break;
      case '--open': o.open = true; break;
      case '--all-agents': o.allAgents = true; break;
      case '--agent': o.agent = next(); break;
      case '--scan': o.scan = true; break;
      case '--list-agents': o.listAgents = true; break;
      case '--doctor': o.doctor = true; break;
      case '--export': o.exportDir = next(); break;
      case '--sessions': o.sessions = true; break;
      case '--text': o.text = next(); break;
      case '--mcp': o.mcp = true; break;
      case '--split': o.split = next(); break;
      case '--label': o.label = next(); break;
      case '--label-accuracy': o.labelAccuracy = true; break;
      case '--demo': o.demo = true; break;
      case '--retro': o.retro = true; break;
      case '--save-retro': o.saveRetro = true; break;
      case '--sprint-start': o.sprintStart = next(); break;
      case '--sprint-days': o.sprintDays = Number(next()); break;
      case '--sprint': o.sprintPick = next(); break;
      case '--save-sprint': o.saveSprint = true; break;
      case '--no-history': o.history = false; break;
      case '--all-sources': o.allSources = true; break;
      case '--errors': o.errors = true; break;
      case '-h': case '--help': o.help = true; break;
      default:
        if (a.startsWith('--dir=')) o.dirs.push(a.slice(6));
        else console.error(`Unknown flag: ${a}`);
    }
  }
  return o;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Manual task labels — corrections that override the rules for one session
// ---------------------------------------------------------------------------
export const labelsFile = () => path.join(home(), '.agent-retro', 'labels.json');
export function readLabels() {
  try { return JSON.parse(fs.readFileSync(labelsFile(), 'utf8')); } catch { return {}; }
}
/** Set (or with task null, clear) the label for one session. */
// ---------------------------------------------------------------------------
// Settings — ~/.agent-retro/config.json (currently the sprint calendar)
// ---------------------------------------------------------------------------
const configFile = () => path.join(home(), '.agent-retro', 'config.json');
export function readConfig() {
  try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { return {}; }
}
/** Set (or with null, clear) the sprint calendar: { start: 'YYYY-MM-DD', days }. */
export function writeSprintConfig(sprint) {
  if (sprint != null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(sprint.start || '')) || Number.isNaN(Date.parse(sprint.start))) throw new Error('sprint start must be a date like 2026-09-16');
    const days = Number(sprint.days);
    if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('sprint length must be 1–90 days');
    sprint = { start: sprint.start, days };
  }
  const cfg = readConfig();
  if (sprint == null) delete cfg.sprint; else cfg.sprint = sprint;
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2) + '\n');
  return cfg;
}

/** All sessions in view, at a glance (the retro covers one sprint; this covers everything). */
function overview(a, sessions) {
  const tasks = Object.entries(a.tasks || {}).slice(0, 3).map(([id, t]) => ({ id, label: t.label, share: t.share }));
  return {
    sessions: sessions.length, prompts: a.volume.prompts, first: a.scope.first, last: a.scope.last, activeDays: a.scope.activeDays,
    spend: a.cost.usd, tokens: a.tokens.total, agentHours: +(((a.time || {}).agentMinutes || 0) / 60).toFixed(1), topTasks: tasks,
    recommendations: (a.recommendations || []).length,
  };
}

// ---------------------------------------------------------------------------
// Saved retros — action items and metric baselines, so the next retro can review them
// ---------------------------------------------------------------------------
const retrosDir = () => path.join(home(), '.agent-retro', 'retros');
/** The most recently saved retro, or null. */
export function latestRetro() {
  let files = [];
  try { files = fs.readdirSync(retrosDir()).filter((f) => /^\d{4}-\d{2}-\d{2}.*\.json$/.test(f)).sort(); } catch { return null; }
  for (const f of files.reverse()) { try { return JSON.parse(fs.readFileSync(path.join(retrosDir(), f), 'utf8')); } catch { /* skip unreadable */ } }
  return null;
}
/** Save the retro's action items and baselines. Returns the file written. */
export function saveRetro(retro) {
  const snap = retroSnapshot(retro);
  fs.mkdirSync(retrosDir(), { recursive: true });
  const file = path.join(retrosDir(), `${snap.savedAt.slice(0, 10)}.json`);
  fs.writeFileSync(file, JSON.stringify(snap, null, 2) + '\n');
  return file;
}

export function writeLabel(sessionId, task) {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200) throw new Error('invalid session id');
  if (task != null && !TASK_IDS.includes(task)) throw new Error(`unknown task: ${task}`);
  const labels = readLabels();
  if (task == null) delete labels[sessionId]; else labels[sessionId] = task;
  fs.mkdirSync(path.dirname(labelsFile()), { recursive: true });
  fs.writeFileSync(labelsFile(), JSON.stringify(labels, null, 2) + '\n');
  return labels;
}


/**
 * Load every selected agent's events once and derive both views from the same stream:
 *   data      — flat aggregates for analyze()
 *   sessions  — per-session telemetry records (sessions.mjs)
 *   analysis  — the rollup (analyze(), including the per-task profile)
 */
export async function loadTelemetry(o) {
  const { events, files, parseErrors } = await loadEvents(o);
  const data = eventsToData(events, o);
  data.files = files; data.parseErrors = parseErrors;
  const sessions = buildSessions(events, { ...o, labels: o.labels || readLabels() });
  data.sessions = sessions.filter((s) => s.start).map((s) => ({ proj: s.project, turns: s.turns.assistant, first: s.start, last: s.end, agent: s.agent }));
  const analysis = analyze(data, o, sessions);
  // Sprint: a calendar from flags or ~/.agent-retro/config.json, else a rolling 14 days
  const calendar = o.sprintStart ? { start: o.sprintStart, days: o.sprintDays || 14 } : readConfig().sprint || null;
  const windows = sprintWindows(sessions, calendar);
  const pick = o.sprintPick ? localDay(o.sprintPick) : null;
  const selected = (pick != null && windows.find((w) => pick >= w.from && pick < w.to)) || defaultSprint(windows);
  const isoDay = localDate;
  analysis.sprint = { calendar, windows: windows.map((w) => ({ from: isoDay(w.from), to: isoDay(w.to - 1), current: w.current, sessions: w.sessions })), selected: selected ? isoDay(selected.from) : null };
  analysis.trend = comparePeriods(sessions, o.split ? { split: Date.parse(o.split) } : { window: selected });
  const config = readClaudeConfig();
  analysis.extensions = summarizeExtensions(sessions, analysis.inventory, config);
  analysis.recommendations = recommend(analysis, sessions, config).map((r) => {
    const m = analysis.trend && analysis.trend.metrics[REC_METRIC[r.id]];
    return m ? { ...r, trend: { metric: REC_METRIC[r.id], ...m } } : r;
  });
  analysis.retro = buildRetro(analysis, sessions, latestRetro(), selected, calendar);
  analysis.overview = overview(analysis, sessions);
  return { data, sessions, analysis };
}

export function loadHistory(o) {
  if (!o.history) return { entries: [], commands: {}, typed: 0 };
  const file = path.join(home(), '.claude', 'history.jsonl');
  const cutoff = o.days ? Date.now() - o.days * 864e5 : null;
  const commands = {}; let typed = 0;
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { return { entries: [], commands, typed }; }
  const entries = [];
  for (const line of lines) {
    if (!line) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    if (cutoff && rec.timestamp && rec.timestamp < cutoff) continue;
    const display = rec.display || '';
    if (!display) continue;
    entries.push({ ts: rec.timestamp, display, project: rec.project });
    const m = display.match(/^[/!][a-zA-Z0-9_:@.-]+/);
    if (m) commands[m[0]] = (commands[m[0]] || 0) + 1;
    else typed++;
  }
  return { entries, commands, typed };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function bucketedTs(ts, tz) {
  if (ts == null) return null;
  const d = tz == null ? new Date(ts) : new Date(ts + tz * 3600 * 1000);
  const g = tz == null
    ? { h: d.getHours(), w: d.getDay(), key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
    : { h: d.getUTCHours(), w: d.getUTCDay(), key: d.toISOString().slice(0, 10) };
  return g;
}

export function analyze(data, o, sessionRecords = []) {
  const { prompts, tools, sessions, models } = data;
  const human = prompts.filter((p) => !p.template);

  const hour = Array(24).fill(0), dow = Array(7).fill(0), byDay = {};
  for (const p of prompts) {
    const b = bucketedTs(p.ts, o.tz);
    if (!b) continue;
    hour[b.h]++; dow[b.w]++; byDay[b.key] = (byDay[b.key] || 0) + 1;
  }
  const activeDays = Object.keys(byDay).sort();
  const lens = prompts.map((p) => p.len).sort((a, b) => a - b);
  const humanLens = human.map((p) => p.len).sort((a, b) => a - b);
  const pct = (arr, f) => arr.length ? Math.round(100 * arr.filter(f).length / arr.length) : 0;
  const median = (arr) => arr.length ? arr[Math.floor(arr.length / 2)] : 0;
  const mean = (arr) => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;

  const n = prompts.length;
  const agents = {};
  for (const p of prompts) { const ag = p.agent || 'claude'; agents[ag] = (agents[ag] || 0) + 1; }
  const toolsByName = {};
  for (const t of tools) toolsByName[t.name] = (toolsByName[t.name] || 0) + 1;
  const toolBuckets = { shell: 0, edit: 0, read: 0, browser: 0, agent: 0, web: 0, other: 0 };
  for (const [name, c] of Object.entries(toolsByName)) toolBuckets[toolBucket(name)] += c;

  const repeated = {};
  for (const p of human.filter((p) => p.len <= 30)) {
    const k = p.text.toLowerCase();
    repeated[k] = (repeated[k] || 0) + 1;
  }

  const projects = {};
  for (const p of prompts) projects[p.proj] = (projects[p.proj] || 0) + 1;

  const projOf = (x) => x.proj;
  const sessTurns = sessions.map((s) => s.turns).sort((a, b) => a - b);
  const sessDur = sessions.map((s) => (s.last - s.first) / 60000).sort((a, b) => a - b);
  const longest = [...sessions].sort((a, b) => b.turns - a.turns).slice(0, o.top)
    .map((s) => ({ proj: projOf(s), turns: s.turns, minutes: Math.round((s.last - s.first) / 60000) }));

  // --- pattern-oriented aggregates -----------------------------------------
  const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const p of prompts) { const b = bucketedTs(p.ts, o.tz); if (b) heatmap[b.w][b.h]++; }
  const daily = Object.entries(byDay).map(([date, c]) => ({ date, n: c })).sort((a, b) => (a.date < b.date ? -1 : 1));

  const histogram = (arr, edges) => {
    const bins = new Array(edges.length).fill(0);
    for (const v of arr) { let i = 0; while (i < edges.length - 1 && v >= edges[i + 1]) i++; bins[i]++; }
    return bins;
  };
  const promptHistEdges = [0, 40, 80, 160, 320, 640, 1280];
  const promptHist = histogram(prompts.map((p) => p.len), promptHistEdges);
  const sessHistEdges = [0, 5, 20, 50, 120, 300, 1000];
  const sessHist = histogram(sessTurns, sessHistEdges);

  const agentMetrics = {};
  const am = (a) => (agentMetrics[a] = agentMetrics[a] || { prompts: 0, tools: 0, sessions: 0, days: new Set(), lens: [] });
  for (const p of prompts) { const m = am(p.agent || 'claude'); m.prompts++; m.lens.push(p.len); const b = bucketedTs(p.ts, o.tz); if (b) m.days.add(b.key); }
  for (const t of tools) am(t.agent || 'claude').tools++;
  for (const s of sessions) am(s.agent || 'claude').sessions++;
  const agentMatrix = Object.entries(agentMetrics)
    .map(([agent, m]) => ({ agent, prompts: m.prompts, tools: m.tools, sessions: m.sessions, activeDays: m.days.size, medianLen: median(m.lens.slice().sort((a, b) => a - b)) }))
    .sort((a, b) => b.prompts - a.prompts);

  // --- tokens, cost, context window ---------------------------------------
  const rawUsage = data.usage || [];
  const cumMax = new Map(); const usageRows = [];
  for (const u of rawUsage) {
    if (u.cumulative) {
      const k = `${u.agent}:${u.sessionId}`; const p = cumMax.get(k);
      const size = (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
      const psize = p ? (p.input + p.output + p.cacheRead + p.cacheWrite) : -1;
      if (size >= psize) cumMax.set(k, u);
    } else usageRows.push(u);
  }
  for (const u of cumMax.values()) usageRows.push(u);

  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  const costByAgent = {}; const costByModel = {}; const contexts = []; let recordedCost = 0;
  for (const u of usageRows) {
    tokens.input += u.input || 0; tokens.output += u.output || 0;
    tokens.cacheRead += u.cacheRead || 0; tokens.cacheWrite += u.cacheWrite || 0;
    tokens.reasoning += u.reasoning || 0;
    const ctx = u.cumulative ? (u.ctx || 0) : (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
    if (ctx > 0) contexts.push(ctx);
    if (u.cost != null) { recordedCost += u.cost; costByAgent[u.agent] = (costByAgent[u.agent] || 0) + u.cost; if (u.model) costByModel[u.model] = (costByModel[u.model] || 0) + u.cost; }
  }
  tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  tokens.inputSide = tokens.input + tokens.cacheRead + tokens.cacheWrite;

  const claudeCost = new Map();
  for (const c of (data.costs || [])) { const p = claudeCost.get(c.sessionId); if (!p || (c.usd || 0) >= (p.usd || 0)) claudeCost.set(c.sessionId, c); }
  let claudeUsd = 0;
  for (const c of claudeCost.values()) {
    claudeUsd += c.usd || 0;
    if (c.modelUsage) for (const [m, v] of Object.entries(c.modelUsage)) { const usd = (v && (v.costUSD != null ? v.costUSD : v.cost)) || 0; costByModel[m] = (costByModel[m] || 0) + usd; }
  }
  const cost = {
    usd: +(claudeUsd + recordedCost).toFixed(2), claudeUSD: +claudeUsd.toFixed(2), recordedUSD: +recordedCost.toFixed(4),
    byAgent: Object.fromEntries(Object.entries({ ...costByAgent, claude: claudeUsd }).map(([k, v]) => [k, +v.toFixed(2)])),
    byModel: Object.fromEntries(Object.entries(costByModel).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => [k, +v.toFixed(2)])),
    sessions: claudeCost.size,
  };

  const sortedCtx = contexts.slice().sort((a, b) => a - b);
  const context = {
    turns: contexts.length, median: median(sortedCtx),
    p90: sortedCtx.length ? sortedCtx[Math.floor(sortedCtx.length * 0.9)] : 0,
    max: sortedCtx.length ? sortedCtx[sortedCtx.length - 1] : 0,
    cacheHitRate: tokens.inputSide ? Math.round(100 * tokens.cacheRead / tokens.inputSide) : 0,
    highTurns: contexts.filter((x) => x > 150000).length,
  };

  const tokenDailyMap = {};
  for (const u of usageRows) {
    const b = bucketedTs(u.ts, o.tz); if (!b) continue;
    const d = (tokenDailyMap[b.key] = tokenDailyMap[b.key] || { tokens: 0, cost: 0 });
    d.tokens += (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
    d.cost += u.cost || 0;
  }
  tokens.daily = Object.entries(tokenDailyMap).map(([date, v]) => ({ date, n: v.tokens, cost: +v.cost.toFixed(2) })).sort((a, b) => (a.date < b.date ? -1 : 1));

  // --- skills & plugins ----------------------------------------------------
  const skills = {}; // per session, a Skill call and the load it triggers count once
  for (const s of sessionRecords) for (const [k, v] of Object.entries(s.skills)) skills[k] = (skills[k] || 0) + v;
  const mcpServers = {};
  for (const t of tools) if (/^mcp__/.test(t.name)) { const srv = t.name.split('__')[1]; mcpServers[srv] = (mcpServers[srv] || 0) + 1; }
  const pluginCommands = {}; const slashCommands = {};
  for (const [c, cnt] of Object.entries(data.commands || {})) { if (c.includes(':')) pluginCommands[c] = cnt; else slashCommands[c] = cnt; }
  const plugins = { mcpServers, pluginCommands, slashCommands };

  const busiest = Object.entries(byDay).sort((a, b) => b[1] - a[1])[0] || ['—', 0];
  const result = {
    generatedAt: new Date().toISOString(),
    scope: { files: data.files.length, activeDays: activeDays.length, first: activeDays[0] || null, last: activeDays.at(-1) || null },
    volume: {
      prompts: n, humanPrompts: human.length,
      interruptions: data.interruptions, toolCalls: tools.length,
      totalUser: data.totalUser, totalAssistant: data.totalAssistant, parseErrors: data.parseErrors,
      promptsPerActiveDay: activeDays.length ? +(n / activeDays.length).toFixed(1) : 0,
      busiestDay: busiest,
    },
    cadence: { hour, dow: Object.fromEntries(DOW.map((d, i) => [d, dow[i]])), byDay, heatmap, daily },
    promptStyle: {
      avg: Math.round(mean(prompts.map((p) => p.len))), median: median(lens),
      p90: lens[Math.floor(lens.length * 0.9)] || 0, max: lens.at(-1) || 0,
      tersePct: pct(lens, (x) => x < 40), longPct: pct(lens, (x) => x > 500),
      humanAvg: Math.round(mean(human.map((p) => p.len))), humanMedian: median(humanLens),
    },
    projects, agents,
    tools: { total: tools.length, byName: toolsByName, buckets: toolBuckets },
    models, sessions: {
      count: sessions.length, medianTurns: median(sessTurns), maxTurns: sessTurns.at(-1) || 0,
      avgTurns: Math.round(mean(sessTurns)), medianMinutes: Math.round(median(sessDur)),
      maxMinutes: Math.round(sessDur.at(-1) || 0), longest,
    },
    histograms: { prompt: { edges: promptHistEdges, bins: promptHist }, sessions: { edges: sessHistEdges, bins: sessHist } },
    agentMatrix,
    tokens, cost, context, skills, plugins,
    tasks: summarizeTasks(sessionRecords),
    prompting: summarizePrompts(sessionRecords),
    ...(({ context: contextBreakdown, subagents: subagentTypes, ...rest }) => ({ contextBreakdown, subagentTypes, ...rest }))(summarizeSessions(sessionRecords)),
    inventory: summarizeInventory(sessionRecords),
    repeated: Object.entries(repeated).sort((a, b) => b[1] - a[1]).slice(0, o.top),
  };
  result.findings = deriveFindings(result, sessionRecords);
  return result;
}

// ---------------------------------------------------------------------------
// Findings — plain-language conclusions, each pointing at the section that backs it
// ---------------------------------------------------------------------------
export const CONTEXT_LABELS = {
  system: 'System prompt', memory: 'CLAUDE.md / memory', toolDefs: 'Tool & agent listings', skills: 'Skill instructions',
  hooks: 'Hook output', reminders: 'Reminders & status', userText: 'Your prompts', files: 'Attached files',
  toolInput: 'Tool call arguments', toolOutput: 'Tool results', reasoning: 'Reasoning', assistantText: 'Agent replies',
};
export const prettyTool = (name) => { const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name); return m ? `${m[2]} · ${m[1]}` : name; };

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function deriveFindings(a, sessions) {
  const F = [];
  const pct = (x) => Math.round(100 * x);
  const sum = (m) => Object.values(m || {}).reduce((x, v) => x + v, 0);
  const n = sessions.length;
  const fmtK = (v) => (v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? Math.round(v / 1e3) + 'k' : String(v));

  const tasks = Object.entries(a.tasks || {}).filter(([id]) => id !== 'other');
  if (tasks.length) {
    const [, t] = tasks[0];
    const costShare = a.cost.usd ? t.totalCost / a.cost.usd : 0;
    F.push({ id: 'focus', level: 'info', section: 'tasks',
      title: `${t.label} is ${pct(t.share)}% of your sessions${costShare >= 0.1 ? ` and ${pct(costShare)}% of recorded spend` : ''}.`,
      detail: `A typical one takes ${plural(t.medianTurns, 'prompt')}, ${plural(t.medianToolCalls, 'tool call')} and ${plural(t.medianMinutes, 'minute')}.` });
  }

  const cb = a.contextBreakdown || {};
  const srcTotal = sum(cb.sources);
  if (srcTotal) {
    const [k, v] = Object.entries(cb.sources).sort((x, y) => y[1] - x[1])[0];
    const out = Object.entries(cb.toolOutputByTool || {});
    const outTotal = sum(cb.toolOutputByTool);
    const browser = out.filter(([name]) => toolBucket(name) === 'browser').reduce((x, [, c]) => x + c, 0);
    const [topTool, topOut] = out[0] || ['', 0];
    F.push({ id: 'context-source', level: v / srcTotal >= 0.4 ? 'attention' : 'info', section: 'tokens',
      title: `${CONTEXT_LABELS[k] || k} make up ${pct(v / srcTotal)}% of what fills your context window.`,
      detail: k === 'toolOutput' && outTotal
        ? (browser / outTotal >= 0.25 ? `Browser tools (screenshots, page reads) produce ${pct(browser / outTotal)}% of those results.` : `${prettyTool(topTool)} produces the most (${pct(topOut / outTotal)}%).`)
        : 'Estimated from logged content, main conversation only.' });
  }

  const cx = a.context || {};
  if (cx.turns && cx.highTurns / cx.turns >= 0.1) {
    F.push({ id: 'context-pressure', level: 'attention', section: 'tokens',
      title: `${pct(cx.highTurns / cx.turns)}% of agent turns ran with more than 150k tokens in context.`,
      detail: `Peak ${fmtK(cx.max)} tokens${cb.compactions ? `; the context was compacted ${cb.compactions} time${cb.compactions === 1 ? '' : 's'}` : ''}. Every such turn re-sends that whole context.` });
  }

  const human = sessions.reduce((x, s) => x + s.turns.human, 0);
  const acks = sessions.reduce((x, s) => x + s.turns.ack, 0);
  const pushback = sessions.reduce((x, s) => x + s.turns.pushback, 0);
  if (human && acks / human >= 0.12) {
    F.push({ id: 'acks', level: 'info', section: 'sessions',
      title: `${pct(acks / human)}% of your prompts were just “yes”, “continue” or similar.`,
      detail: `${acks} of ${human} prompts handed control back without new direction.` });
  }
  if (human && pushback / human >= 0.08) {
    F.push({ id: 'corrections', level: 'attention', section: 'sessions',
      title: `${pct(pushback / human)}% of your prompts correct the agent (“no”, “wait”, “actually”).`,
      detail: 'Frequent corrections usually mean the first instruction was missing context.' });
  }

  const risk = a.risk || {};
  if (n && risk.sessionsWithErrorBursts) {
    F.push({ id: 'error-bursts', level: risk.sessionsWithErrorBursts / n >= 0.2 ? 'attention' : 'info', section: 'risk',
      title: `${risk.sessionsWithErrorBursts} of ${n} sessions had a turn where 3 or more tool calls failed.`,
      detail: `Across all sessions, ${pct(a.volume.toolCalls ? sessions.reduce((x, s) => x + s.tools.errors, 0) / a.volume.toolCalls : 0)}% of tool calls failed.` });
  }
  if (risk.sensitiveAccess || risk.destructiveCommands) {
    F.push({ id: 'risk', level: 'attention', section: 'risk',
      title: `${risk.sensitiveAccess} touches of secrets or keys and ${risk.destructiveCommands} destructive commands.`,
      detail: 'Reads of .env files, keys or ~/.ssh; rm -rf outside build folders, force-pushes, hard resets.' });
  }

  const sub = Object.entries(a.subagentTypes || {})[0];
  if (sub && a.tokens.total && sub[1].tokens / a.tokens.total >= 0.05) {
    F.push({ id: 'subagents', level: 'info', section: 'sessions',
      title: `${sub[0]} subagents used ${fmtK(sub[1].tokens)} tokens over ${sub[1].runs} runs.`,
      detail: `That is ${pct(sub[1].tokens / a.tokens.total)}% of all tokens, with ${sub[1].errors} failed tool calls.` });
  }

  if (cx.cacheHitRate >= 80) {
    F.push({ id: 'cache', level: 'info', section: 'tokens',
      title: `${cx.cacheHitRate}% of input tokens were served from cache.`,
      detail: 'Cached input is billed at a fraction of the normal rate, so long sessions cost less than their size suggests.' });
  }

  return F.sort((x, y) => (x.level === y.level ? 0 : x.level === 'attention' ? -1 : 1)).slice(0, 7);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function bar(v, max, width = 30) { return '█'.repeat(max ? Math.round((v / max) * width) : 0); }

const fmtMetric = (m, v) => (m.usd ? '$' + v.toFixed(2) : m.share ? Math.round(v * 100) + '%' : v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'k' : String(+v.toFixed(2)));
const trendWindow = (t) => (t.mode === 'split' ? `before vs after ${t.boundary.slice(0, 10)}` : t.mode === 'sprint' ? 'this sprint vs the previous one' : `last ${t.days} days vs the ${t.days} before`);

const RETRO_COLUMNS = [['wentWell', 'Went well'], ['didntGoWell', "Didn't go well"], ['start', 'Start'], ['stop', 'Stop']];

const retroPeriod = (r) => (!r.period.from ? 'all sessions' : `${r.period.calendar ? 'sprint' : 'last ' + r.period.days + ' days'} ${r.period.from} → ${r.period.to}${r.period.current ? ' (in progress)' : ''}`);

function retroText(r) {
  if (!r) return [];
  const L = ['', `=== RETRO · ${retroPeriod(r)} ===`, `  ${r.headline}`];
  for (const [key, title] of RETRO_COLUMNS) {
    L.push('', `  ${title.toUpperCase()}`);
    if (!r[key].length) L.push('    —');
    for (const it of r[key]) L.push(`    • ${it.text}${it.detail ? `\n      ${it.detail}` : ''}`);
  }
  L.push('', '  ACTION ITEMS');
  if (!r.actions.length) L.push('    —');
  r.actions.forEach((x, i) => L.push(`    ${i + 1}. [ ] ${x.title}${x.metric ? `  (watch: ${x.metric.label}, now ${x.metric.display})` : ''}`));
  L.push('', '  KAIZEN');
  const k = r.kaizen;
  if (k.review) {
    L.push(`    Since the retro saved ${k.review.savedAt.slice(0, 10)}:`);
    for (const it of k.review.items) L.push(`      ${it.verdict === 'better' ? '✓' : it.verdict === 'worse' ? '✗' : '·'} ${it.title}${it.metric ? `: ${it.metric} ${it.baseline} → ${it.now} (${it.verdict})` : ''}${it.stillOpen ? ' · still recommended' : ''}`);
  }
  if (k.experiment) L.push(`    Experiment for the next ${k.experiment.days} days: ${k.experiment.title}.`, `    Measure: ${k.experiment.metric.label}, now ${k.experiment.metric.display}. Check with: ${k.experiment.check}`);
  if (!k.review) L.push('    Save this retro (--save-retro) so the next one reviews how these action items went.');
  return L;
}

function retroMd(r) {
  if (!r) return [];
  const L = [`## Retro: ${retroPeriod(r)}`, '', r.headline, ''];
  for (const [key, title] of RETRO_COLUMNS) {
    L.push(`### ${title}`, '');
    if (!r[key].length) L.push('- —');
    for (const it of r[key]) L.push(`- **${it.text}**${it.detail ? ` ${it.detail}` : ''}`);
    L.push('');
  }
  L.push('### Action items', '');
  if (!r.actions.length) L.push('- —');
  for (const x of r.actions) L.push(`- [ ] **${x.title}**${x.metric ? ` (watch ${x.metric.label}, now ${x.metric.display})` : ''}`);
  L.push('', '### Kaizen', '');
  const k = r.kaizen;
  if (k.review) {
    L.push(`Since the retro saved ${k.review.savedAt.slice(0, 10)}:`, '');
    for (const it of k.review.items) L.push(`- ${it.verdict === 'better' ? '✅' : it.verdict === 'worse' ? '❌' : '➖'} ${it.title}${it.metric ? `: ${it.metric} ${it.baseline} → ${it.now} (${it.verdict})` : ''}`);
    L.push('');
  }
  if (k.experiment) L.push(`**Experiment for the next ${k.experiment.days} days:** ${k.experiment.title}. Measure ${k.experiment.metric.label} (now ${k.experiment.metric.display}); check with \`${k.experiment.check}\`.`);
  return L;
}

function renderText(a, hist, o) {
  const L = [];
  const row = (label, val) => L.push(`  ${label.padEnd(26)} ${val}`);
  const sec = (t) => { L.push(''); L.push(`=== ${t} ===`); };
  const rank = (obj, total, top = o.top) => {
    const entries = Object.entries(obj).sort((x, y) => y[1] - x[1]).slice(0, top);
    const maxv = entries[0]?.[1] || 1;
    for (const [k, v] of entries) L.push(`  ${k.padEnd(24)} ${String(v).padStart(5)}  ${total ? String(Math.round(100 * v / total)).padStart(3) + '%' : ''} ${bar(v, maxv, 24)}`);
  };

  const multi = Object.keys(a.agents || {}).some((x) => x !== 'claude');
  L.push(`AGENT-RETRO REPORT · ${multi ? 'all coding agents' : 'Claude Code'}`);
  L.push(`Generated ${a.generatedAt.slice(0, 19).replace('T', ' ')}  |  ${a.scope.files} transcripts  |  ${a.scope.first} → ${a.scope.last}`);

  L.push(...retroText(a.retro));

  sec('RECOMMENDATIONS');
  const recs = a.recommendations || [];
  if (!recs.length) L.push('  nothing to recommend for this selection');
  recs.forEach((r, i) => {
    L.push(`  ${i + 1}. [${r.level}] ${r.title}`);
    L.push(`     why: ${r.evidence}`);
    L.push(`     do:  ${r.action}`);
    if (r.trend) L.push(`     trend: ${fmtMetric(r.trend, r.trend.before)} → ${fmtMetric(r.trend, r.trend.after)} (${r.trend.verdict}, ${trendWindow(a.trend)})`);
    if (r.fix) { L.push(`     fix (${r.fix.kind} → ${r.fix.target}):`); for (const line of r.fix.content.split('\n')) L.push(`       ${line}`); }
  });

  if (a.trend) {
    sec(`TREND (${trendWindow(a.trend)}; ${a.trend.sessions.before} → ${a.trend.sessions.after} sessions)`);
    for (const m of Object.values(a.trend.metrics)) L.push(`  ${m.label.padEnd(40)} ${fmtMetric(m, m.before).padStart(12)} → ${fmtMetric(m, m.after).padEnd(12)} ${m.verdict}`);
  }

  if (a.time && (a.time.agentMinutes || a.time.waitMinutes)) {
    sec('TIME');
    row('Agent working', `${Math.round(a.time.agentMinutes / 60)} h`);
    row('You waiting to reply', `${Math.round(a.time.waitMinutes / 60)} h (median reply ${a.time.medianResponseSec ?? '—'} s)`);
    row('Away (gaps > 30 min)', `${Math.round(a.time.awayMinutes / 60)} h`);
  }

  if (a.toolErrors && a.toolErrors.total) {
    sec(`WHY TOOLS FAIL (${a.toolErrors.total} failures; plus ${a.toolErrors.rejected} you rejected, ${a.toolErrors.blocked} blocked by guards)`);
    rank(a.toolErrors.byClass, a.toolErrors.total, 10);
    L.push('  by tool:');
    rank(a.toolErrors.byTool, a.toolErrors.total, 6);
  }

  if ((a.workflows || []).length) {
    sec('REPEATED COMMAND SEQUENCES');
    for (const w of a.workflows) L.push(`  ${String(w.sessions).padStart(3)} sessions  ${w.steps.join(' → ')}`);
  }

  sec('TASKS (per session)');
  const tasks = Object.entries(a.tasks || {});
  if (tasks.length) {
    L.push(`  ${'task'.padEnd(20)} ${'sess'.padStart(5)} ${'share'.padStart(6)} ${'turns'.padStart(6)} ${'min'.padStart(5)} ${'cost'.padStart(9)} ${'err%'.padStart(5)} ${'fix%'.padStart(5)}  top commands`);
    for (const [k, t] of tasks) L.push(`  ${k.padEnd(20)} ${String(t.sessions).padStart(5)} ${(Math.round(t.share * 100) + '%').padStart(6)} ${String(t.medianTurns).padStart(6)} ${String(t.medianMinutes).padStart(5)} ${('$' + t.totalCost).padStart(9)} ${String(Math.round(t.toolErrorRate * 100)).padStart(5)} ${String(Math.round(t.correctionRate * 100)).padStart(5)}  ${t.topShell.slice(0, 3).map(([c]) => c).join(', ')}`);
    L.push('  (turns/min = medians; err% = tool errors; fix% = prompts pushing back)');
  } else L.push('  no sessions');

  sec('VOLUME');
  row('Your prompts', a.volume.prompts);
  row('Assistant turns', a.volume.totalAssistant);
  row('Tool calls', a.volume.toolCalls);
  row('Interruptions', a.volume.interruptions);
  row('Active days', a.scope.activeDays);
  row('Prompts / active day', a.volume.promptsPerActiveDay);
  row('Busiest day', a.volume.busiestDay ? `${a.volume.busiestDay[0]} (${a.volume.busiestDay[1]})` : '—');

  sec('CADENCE');
  const maxH = Math.max(...a.cadence.hour);
  a.cadence.hour.forEach((v, h) => { if (v) L.push(`  ${String(h).padStart(2, '0')}h  ${String(v).padStart(4)}  ${bar(v, maxH, 34)}`); });
  L.push(`  Weekday: ${Object.entries(a.cadence.dow).map(([d, v]) => `${d}:${v}`).join('  ')}`);

  sec('PROMPT STYLE');
  row('Median length', `${a.promptStyle.median} chars`);
  row('Average length', `${a.promptStyle.avg} chars`);
  row('Conversational median', `${a.promptStyle.humanMedian} chars`);
  row('Terse (<40 chars)', `${a.promptStyle.tersePct}%`);
  row('Long (>500 chars)', `${a.promptStyle.longPct}%`);
  row('p90 / max', `${a.promptStyle.p90} / ${a.promptStyle.max}`);

  sec('AGENTS');
  if (Object.keys(a.agents).length > 1) rank(a.agents, a.volume.prompts, 12);
  else L.push(`  ${Object.keys(a.agents)[0] || 'claude'} (single agent; use --all-agents)`);

  sec('PROJECTS');
  rank(a.projects, a.volume.prompts);

  sec('TOOLS');
  const tb = a.tools.buckets;
  L.push(`  Buckets: shell ${tb.shell} | edit ${tb.edit} | read ${tb.read} | browser ${tb.browser} | agent ${tb.agent} | web ${tb.web} | other ${tb.other}`);
  rank(a.tools.byName, a.tools.total, o.top);

  sec('MODELS');
  rank(a.models, a.volume.totalAssistant, 8);

  sec('SESSIONS');
  row('Sessions', a.sessions.count);
  row('Median turns / session', a.sessions.medianTurns);
  row('Longest turns', a.sessions.maxTurns);
  row('Median duration', `${a.sessions.medianMinutes} min`);
  row('Longest duration', `${a.sessions.maxMinutes} min`);
  a.sessions.longest.slice(0, 5).forEach((s) => L.push(`    ${s.proj}: ${s.turns} turns, ${s.minutes} min`));

  const fmtN = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0));
  sec('TOKENS & COST');
  const tk = a.tokens || {};
  row('Total tokens', fmtN(tk.total));
  row('  input (new)', fmtN(tk.input));
  row('  cache read', fmtN(tk.cacheRead));
  row('  cache write', fmtN(tk.cacheWrite));
  row('  output', fmtN(tk.output));
  row('  reasoning', fmtN(tk.reasoning));
  row('Cost (recorded)', a.cost ? `$${a.cost.usd}` : 'n/a');
  if (a.cost && Object.keys(a.cost.byAgent).length) row('  by agent', Object.entries(a.cost.byAgent).filter(([, v]) => v > 0).map(([k, v]) => `${k} $${v}`).join(' · '));
  if (a.cost && Object.keys(a.cost.byModel).length) row('  by model', Object.entries(a.cost.byModel).slice(0, 4).map(([k, v]) => `${k} $${v}`).join(' · '));

  sec('CONTEXT WINDOW');
  const cx = a.context || {};
  row('Turns measured', cx.turns);
  row('Median context', fmtN(cx.median));
  row('p90 context', fmtN(cx.p90));
  row('Peak context', fmtN(cx.max));
  row('Cache hit rate', (cx.cacheHitRate || 0) + '%');
  row('Turns > 150k', cx.highTurns);

  const cb = a.contextBreakdown;
  if (cb && cb.sessionsMeasured) {
    sec(`CONTEXT SOURCES (estimated, ${cb.sessionsMeasured} sessions, main thread)`);
    rank(cb.sources, Object.values(cb.sources).reduce((x, v) => x + v, 0), 12);
    L.push('  tool output by tool:');
    rank(cb.toolOutputByTool, Object.values(cb.toolOutputByTool).reduce((x, v) => x + v, 0), 6);
    row('Compactions', `${cb.compactions} in ${cb.compactedSessions} sessions`);
    row('Turns > 150k context', cb.highContextTurns);
    row('API errors', cb.apiErrors);
  }

  const st = Object.entries(a.subagentTypes || {});
  if (st.length) {
    sec('SUBAGENTS');
    L.push(`  ${'type'.padEnd(22)} ${'runs'.padStart(5)} ${'tools'.padStart(6)} ${'errors'.padStart(7)} ${'tokens'.padStart(9)} ${'output'.padStart(8)}`);
    for (const [k, t] of st) L.push(`  ${k.padEnd(22)} ${String(t.runs).padStart(5)} ${String(t.toolCalls).padStart(6)} ${String(t.errors).padStart(7)} ${fmtN(t.tokens).padStart(9)} ${fmtN(t.outputTokens).padStart(8)}`);
  }

  if (a.risk) {
    sec('RISK SIGNALS');
    row('Sensitive file access', a.risk.sensitiveAccess);
    row('Destructive commands', a.risk.destructiveCommands);
    row('Sessions w/ error bursts', `${a.risk.sessionsWithErrorBursts} (3+ tool errors in one turn)`);
  }

  const E = a.extensions;
  if (E) {
    const t = (v) => (v == null ? '—' : fmtN(v));
    const table = (title, rows, cols) => {
      sec(title);
      if (!rows.length) { L.push('  none recorded'); return; }
      L.push('  ' + cols.map(([h, , w]) => (w < 0 ? h.padEnd(-w) : h.padStart(w))).join(' '));
      for (const r of rows.slice(0, o.top)) L.push('  ' + cols.map(([, f, w]) => { const v = String(f(r)); return w < 0 ? v.slice(0, -w).padEnd(-w) : v.padStart(w); }).join(' '));
      if (rows.length > o.top) L.push(`  … ${rows.length - o.top} more (--top to show more)`);
    };
    table(`PLUGINS (${E.plugins.length})`, E.plugins, [['plugin', (p) => p.name, -22], ['verdict', (p) => p.verdict, -12], ['skills used', (p) => `${p.skillsUsed}/${p.skillsListed}`, 11], ['uses', (p) => p.uses, 6], ['mcp', (p) => p.mcpServers.length, 4], ['list tok/sess', (p) => t(p.listingTokens), 13]]);
    table(`SKILLS (${E.skills.length}; ${E.skills.filter((x) => x.verdict === 'unused').length} unused)`, E.skills, [['skill', (x) => x.name, -36], ['verdict', (x) => x.verdict, -12], ['uses', (x) => x.uses, 5], ['sessions', (x) => `${x.sessionsUsed}/${x.sessionsLoaded}`, 9], ['tok/load', (x) => t(x.tokensPerLoad), 9], ['list tok', (x) => t(x.listingTokens), 9]]);
    table(`MCP SERVERS (${E.mcpServers.length})`, E.mcpServers, [['server', (m) => m.name, -26], ['source', (m) => m.source, -9], ['verdict', (m) => m.verdict, -12], ['calls', (m) => m.calls, 6], ['fail', (m) => (m.calls ? Math.round(m.errorRate * 100) + '%' : '—'), 5], ['top cause', (m) => m.topError || '—', -14], ['output tok', (m) => t(m.outputTokens), 10]]);
    table(`HOOKS (${E.hooks.length})`, E.hooks, [['hook', (h) => h.name, -28], ['runs', (h) => h.runs, 6], ['p90', (h) => (h.p90Ms == null ? '—' : h.p90Ms + 'ms'), 8], ['fail', (h) => h.failures, 5], ['injected', (h) => t(h.injectedTokens), 9], ['tok/sess', (h) => t(h.tokensPerSession), 9]]);
    table(`SLASH COMMANDS (${E.commands.length})`, E.commands, [['command', (c) => c.name, -36], ['uses', (c) => c.uses, 6], ['sessions', (c) => c.sessions, 9], ['last used', (c) => (c.lastUsed || '').slice(0, 10), 11]]);
  }

  const P = a.prompting;
  if (P && P.openings) {
    sec(`PROMPT PRACTICES (${P.openings} opening prompts; pattern-based: detects a practice, not its quality)`);
    for (const line of P.summary) L.push(`  ${line}`);
    L.push(`  Types: ${Object.entries(P.types.shots).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(' · ')} · role ${Math.round(P.types.techniques.role * 100)}% · step-by-step ${Math.round(P.types.techniques['step-by-step'] * 100)}%`);
    for (const p of P.practices) {
      const o = p.outcome;
      L.push(`  ${p.label.padEnd(36)} ${(Math.round(p.share * 100) + '%').padStart(4)}  ${o ? `with it: ${o.with.medianFollowUps} follow-ups, ${Math.round(o.with.correctionRate * 100)}% corrected · without: ${o.without.medianFollowUps}, ${Math.round(o.without.correctionRate * 100)}%${o.helps ? '  ← helps you' : ''}` : 'not enough sessions to compare'}`);
    }
  }

  sec('MOST-REPEATED SHORT PROMPTS');
  a.repeated.forEach(([k, v]) => L.push(`  ${String(v).padStart(3)} × "${k}"`));

  if (o.history) {
    sec('CLI HISTORY (typed)');
    row('Non-command entries', hist.typed);
    row('Distinct slash/! commands', Object.keys(hist.commands).length);
    rank(hist.commands, hist.entries.length, o.top);
  }

  return L.join('\n');
}

function renderMd(a, hist, o) {
  const pct = (v, t) => t ? `${Math.round(100 * v / t)}%` : '0%';
  const title = `agent-retro: ${Object.keys(a.agents || {}).some((x) => x !== 'claude') ? 'coding agents' : 'Claude Code'}`;
  const L = [`# ${title} Report`, '', `_Generated ${a.generatedAt.slice(0, 19).replace('T', ' ')} — ${a.scope.files} transcripts, ${a.scope.first} → ${a.scope.last}_`, ''];
  L.push('## Volume', '', '| Metric | Value |', '| --- | --- |',
    `| Your prompts | ${a.volume.prompts} |`,
    `| Assistant turns | ${a.volume.totalAssistant} |`,
    `| Tool calls | ${a.volume.toolCalls} |`,
    `| Active days | ${a.scope.activeDays} |`,
    `| Prompts / active day | ${a.volume.promptsPerActiveDay} |`, '');
  L.push(...retroMd(a.retro), '');
  L.push('## Recommendations', '');
  for (const r of a.recommendations || []) {
    L.push(`### ${r.title} _(${r.level})_`, '', `**Why:** ${r.evidence}`, '', `**Do:** ${r.action}`, '');
    if (r.fix) L.push(`Fix (${r.fix.kind} → \`${r.fix.target}\`):`, '', '```' + (r.fix.kind === 'settings' ? 'json' : r.fix.kind === 'shell' ? 'bash' : ''), r.fix.content, '```', '');
  }
  L.push('## Tasks', '', '| Task | Sessions | Median turns | Median min | Cost | Tool errors | Corrections | Top commands |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const [k, t] of Object.entries(a.tasks || {})) L.push(`| ${k} | ${t.sessions} | ${t.medianTurns} | ${t.medianMinutes} | $${t.totalCost} | ${Math.round(t.toolErrorRate * 100)}% | ${Math.round(t.correctionRate * 100)}% | ${t.topShell.slice(0, 3).map(([c]) => '`' + c + '`').join(' ')} |`);
  L.push('');
  const cb = a.contextBreakdown;
  if (cb && cb.sessionsMeasured) {
    const tot = Object.values(cb.sources).reduce((x, v) => x + v, 0);
    L.push('## Context sources (estimated)', '', '| Source | Tokens | Share |', '| --- | --- | --- |');
    for (const [k, v] of Object.entries(cb.sources)) L.push(`| ${k} | ${v} | ${pct(v, tot)} |`);
    L.push('', `Compactions: ${cb.compactions} in ${cb.compactedSessions} sessions · turns over 150k: ${cb.highContextTurns}`, '');
  }
  if (Object.keys(a.subagentTypes || {}).length) {
    L.push('## Subagents', '', '| Type | Runs | Tool calls | Errors | Tokens |', '| --- | --- | --- | --- | --- |');
    for (const [k, t] of Object.entries(a.subagentTypes)) L.push(`| ${k} | ${t.runs} | ${t.toolCalls} | ${t.errors} | ${t.tokens} |`);
    L.push('');
  }
  if (a.risk) L.push('## Risk signals', '', `- Sensitive file access: ${a.risk.sensitiveAccess}`, `- Destructive commands: ${a.risk.destructiveCommands}`, `- Sessions with error bursts: ${a.risk.sessionsWithErrorBursts}`, '');
  if (a.prompting && a.prompting.openings) {
    L.push('## Prompt practices', '', ...a.prompting.summary.map((x) => `- ${x}`), '', '| Practice | Openings using it | With it (follow-ups, corrected) | Without it |', '| --- | --- | --- | --- |');
    for (const p of a.prompting.practices) L.push(`| ${p.label} | ${Math.round(p.share * 100)}% | ${p.outcome ? `${p.outcome.with.medianFollowUps}, ${Math.round(p.outcome.with.correctionRate * 100)}%` : '—'} | ${p.outcome ? `${p.outcome.without.medianFollowUps}, ${Math.round(p.outcome.without.correctionRate * 100)}%` : '—'} |`);
    L.push('');
  }
  L.push('## Cadence', '', '| Hour | Prompts |', '| --- | --- |');
  a.cadence.hour.forEach((v, h) => { if (v) L.push(`| ${String(h).padStart(2, '0')}h | ${v} |`); });
  L.push('', `Weekday: ${Object.entries(a.cadence.dow).map(([d, v]) => `${d} ${v}`).join(', ')}`, '');
  L.push('', '## Projects', '', '| Project | Prompts |', '| --- | --- |');
  Object.entries(a.projects).sort((x, y) => y[1] - x[1]).forEach(([k, v]) => L.push(`| ${k} | ${v} |`));
  L.push('', '## Tools', '', '| Tool | Calls | Share |', '| --- | --- | --- |');
  Object.entries(a.tools.byName).sort((x, y) => y[1] - x[1]).slice(0, o.top).forEach(([k, v]) => L.push(`| ${k} | ${v} | ${pct(v, a.tools.total)} |`));
  L.push('', '## Sessions', '', `- Median ${a.sessions.medianTurns} turns / session, longest ${a.sessions.maxTurns}`, `- Median ${a.sessions.medianMinutes} min, longest ${a.sessions.maxMinutes} min`, '');
  L.push('## Repeated short prompts', '');
  a.repeated.forEach(([k, v]) => L.push(`- ${v} × \`${k}\``));
  if (o.history) {
    L.push('', '## CLI commands', '', '| Command | Count |', '| --- | --- |');
    Object.entries(hist.commands).sort((x, y) => y[1] - x[1]).slice(0, o.top).forEach(([k, v]) => L.push(`| \`${k}\` | ${v} |`));
  }
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    const src = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n');
    const end = src.findIndex((l, i) => i > 1 && l.trim() === '*/');
    console.log(src.slice(2, end < 0 ? 42 : end).map((l) => l.replace(/^\s?\*?\/?/, '')).join('\n'));
    return;
  }
  if (o.demo) {
    // Everything below reads home() lazily, so pointing it at a temp dir swaps in the demo data.
    const { writeDemo } = await import('./fixtures.mjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-retro-demo-'));
    process.env.AGENT_RETRO_HOME = dir;
    const n = writeDemo(dir);
    console.error(`[agent-retro] demo mode: ${n} synthetic sessions in ${dir} (your own logs are not read)`);
  }
  if (o.sprintStart && (!/^\d{4}-\d{2}-\d{2}$/.test(o.sprintStart) || Number.isNaN(Date.parse(o.sprintStart)))) { console.error('--sprint-start needs a date like 2026-09-16'); process.exit(2); }
  if (o.sprintPick && Number.isNaN(Date.parse(o.sprintPick))) { console.error('--sprint needs a date like 2026-09-20'); process.exit(2); }
  if (o.saveSprint) {
    if (!o.sprintStart) { console.error('--save-sprint needs --sprint-start <date> (and optionally --sprint-days <n>)'); process.exit(2); }
    try { writeSprintConfig({ start: o.sprintStart, days: o.sprintDays || 14 }); } catch (err) { console.error(err.message); process.exit(2); }
    console.error(`[agent-retro] sprint calendar saved: ${o.sprintDays || 14}-day sprints starting ${o.sprintStart}.`);
  }
  if (o.ui) { const { startUi } = await import('./ui.mjs'); await startUi(o); return; }
  if (o.listAgents) { const { PARSABLE } = await import('./agents.mjs'); console.log(PARSABLE.join('\n')); return; }
  if (o.doctor) {
    const { adapterHealth } = await import('./agents.mjs');
    const rows = adapterHealth(o);
    console.log('ADAPTER HEALTH');
    console.log('  ' + 'agent'.padEnd(12) + 'files'.padStart(7) + 'events'.padStart(8) + '  status');
    for (const r of rows) console.log('  ' + r.id.padEnd(12) + String(r.files).padStart(7) + String(r.events).padStart(8) + '  ' + r.status + (r.error ? ' — ' + r.error : ''));
    const bad = rows.filter((r) => r.status === 'STALE' || r.status === 'ERROR');
    console.log(bad.length ? `\n${bad.length} adapter(s) need attention: ${bad.map((b) => b.id).join(', ')}` : '\nall adapters healthy');
    return;
  }
  if (o.scan) {
    const { scanStores } = await import('./agents.mjs');
    const rows = scanStores();
    console.log('DETECTED AGENT STORES');
    console.log('  ' + 'agent'.padEnd(18) + 'files'.padStart(7) + 'MB'.padStart(9) + '  parsed  note');
    for (const r of rows) console.log('  ' + r.id.padEnd(18) + String(r.files).padStart(7) + String(r.mb).padStart(9) + '  ' + (r.parses ? 'yes   ' : 'no    ') + '  ' + r.note);
    return;
  }

  if (o.split && Number.isNaN(Date.parse(o.split))) { console.error('--split needs a date, e.g. 2026-09-01'); process.exit(2); }
  if (o.label) {
    const i = o.label.indexOf('=');
    if (i < 1) { console.error('--label needs <session-id>=<task>, e.g. --label 85e90e82=code-review'); process.exit(2); }
    try { writeLabel(o.label.slice(0, i), o.label.slice(i + 1) || null); } catch (err) { console.error(err.message + `. Tasks: ${TASK_IDS.join(', ')}`); process.exit(2); }
    console.log(`Saved to ${labelsFile()}`);
    return;
  }
  if (o.mcp) { const { startMcp } = await import('./mcp.mjs'); await startMcp(o); return; }
  const { TEXT_LEVELS } = await import('./telemetry.mjs');
  if (!TEXT_LEVELS.includes(o.text)) { console.error(`--text must be one of: ${TEXT_LEVELS.join(', ')}`); process.exit(2); }

  const started = Date.now();
  const { data, sessions, analysis } = await loadTelemetry(o);
  if (o.errors && data.parseErrors) console.error(`[agent-retro] ${data.parseErrors} unparseable lines skipped`);
  if (!data.files.length) { console.error('No transcripts found. Check --dir, or try --all-agents / --scan.'); process.exit(1); }
  const hist = loadHistory(o);

  if (o.saveRetro) {
    const file = saveRetro(analysis.retro);
    console.error(`[agent-retro] retro saved to ${file}; the next retro will review its action items.`);
    if (!o.retro) return;
  }
  if (o.retro) { console.log((o.format === 'md' ? retroMd(analysis.retro) : retroText(analysis.retro)).join('\n').replace(/^\n/, '')); return; }

  if (o.labelAccuracy) {
    const manual = sessions.filter((s) => s.task.source === 'manual');
    if (!manual.length) { console.log(`No corrected labels yet. Add some with --label <session-id>=<task> or in the dashboard; they are stored in ${labelsFile()}.`); return; }
    const agree = manual.filter((s) => (s.task.rulePrimary || s.task.primary) === s.task.primary);
    console.log(`Rules agree with ${agree.length} of ${manual.length} corrected labels (${Math.round(100 * agree.length / manual.length)}%).`);
    const miss = {};
    for (const s of manual) if (s.task.rulePrimary) { const k = `${s.task.rulePrimary} → ${s.task.primary}`; miss[k] = (miss[k] || 0) + 1; }
    for (const [k, v] of Object.entries(miss).sort((a, b) => b[1] - a[1])) console.log(`  rules said ${k}: ${v}`);
    return;
  }

  if (o.exportDir || o.sessions) {
    const { buildBundle, writeExport } = await import('./telemetry.mjs');
    const bundle = buildBundle({ analysis: { ...analysis, cliHistory: o.history ? hist : null }, sessions }, o);
    if (o.sessions) for (const s of bundle.sessions) console.log(JSON.stringify(s));
    if (o.exportDir) {
      const written = writeExport(o.exportDir, bundle);
      console.error(`[agent-retro] ${sessions.length} sessions, text=${o.text} → ${written.join(', ')}`);
    }
    return;
  }

  if (o.format === 'json') console.log(JSON.stringify({ ...analysis, cliHistory: o.history ? hist : undefined }, null, 2));
  else if (o.format === 'md') console.log(renderMd(analysis, hist, o));
  else console.log(renderText(analysis, hist, o));

  if (o.format === 'text') console.error(`\n[agent-retro] ${data.files.length} sources, ${sessions.length} sessions, ${data.prompts.length} prompts analyzed in ${Date.now() - started}ms`);
}

let isMain = false;
try { isMain = !!process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { /* ignore */ }
if (isMain) main().catch((err) => { console.error(err); process.exit(1); });
