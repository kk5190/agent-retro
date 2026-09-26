#!/usr/bin/env node
/**
 * cc-habits — a reusable dashboard for Claude Code conversation logs.
 *
 * Reads ~/.claude/projects/**\/*.jsonl (and optionally ~/.claude/transcripts)
 * and reports your real-world working habits: cadence, prompt style, themes,
 * workflow loops, tool usage, sessions, and CLI commands.
 *
 * Zero dependencies. Node >= 18.
 *
 * Usage:
 *   node habits.mjs                       # human-readable report
 *   node habits.mjs --md                  # markdown report
 *   node habits.mjs --json                # machine-readable JSON
 *   node habits.mjs --days 30             # only last 30 days
 *   node habits.mjs --project myportfolio # filter to one project
 *   node habits.mjs --tz 5.5              # force a UTC offset (hours)
 *   node habits.mjs --top 15 --include-transcripts --no-history
 *   node habits.mjs --ui                  # local web dashboard (http://127.0.0.1:4173)
 *   node habits.mjs --ui --port 5000 --open
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
 *   --doctor                Check each adapter's yield; flag stale/rot *   --no-history            Skip ~/.claude/history.jsonl
 *   --all-sources           Include SDK/system-injected prompts too
 *   --errors                Print parse warnings to stderr
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HOME = os.homedir();

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const o = {
    dirs: [], project: null, days: null, top: 15, tz: null, format: 'text',
    includeTranscripts: false, history: true, allSources: false, errors: false,
    ui: false, port: 4173, open: false,
    allAgents: false, agent: null, scan: false, listAgents: false, doctor: false,
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
// Classification config
// ---------------------------------------------------------------------------
const NOISE = [
  /^\s*\[Image:/, /^\s*\[Request interrupted/, /^\s*<task-notification/,
  /^\s*Base directory for this skill/, /^\s*<launch-selected-element/,
  /^\s*<command-name>/, /^\s*<command-message/, /^\s*<system-reminder/,
  /^\s*<local-command/, /^\s*This session is being continued/,
  /^\s*<bash-input>/, /^\s*<bash-stdout>/, /^\s*<bash-stderr>/,
  /^\s*<preview-annotation-context/, /^\s*\[Usage limit approaching/,
  /^\s*\[Your previous response had no visible output/,
  /^\s*<user-prompt-submit-hook/, /^\s*\[Automated/,
];

const TEMPLATE = /^(you are|review\b|#|learn\b|analyz|analys|read the|implement the|fix the following|the \/|create a spec|investigate|verify that|as a |act as |your (job|task)|superpowers|i'm planning a fix)/i;

const THEMES = {
  'design / aesthetic': /aesthetic|beautiful|design|visual|polish|clean|minimal|layout|typograph|font|color|palette/i,
  'motion / interaction': /animat|motion|transition|scroll|gsap|framer|anime\.?js|three\.?js|hover|interactiv|reduced.?motion/i,
  'content / copy': /copy|content|text|wording|emoji|em.?dash|sound( ai| like)|ai generated|artificial/i,
  'git / commits': /commit|git (config|author|log|branch)|author|contributor|github|branch/i,
  'deploy / hosting': /deploy|netlify|vercel|publish|build fail|production/i,
  'bug / debugging': /\bbug|broken|not work|doesn.?t work|error|fail|why |crash|stuck/i,
  'a11y / perf / seo': /accessib|a11y|seo|lighthouse|performance|\bperf\b|contrast|core web/i,
  'verify / preview': /localhost|screenshot|verify|check in browser|preview|dev server|annotation/i,
  'agentic setup': /claude\.md|agents\.md|\bmcp\b|skill|subagent|\bhook\b|settings|superpowers|\bsdd\b/i,
  'refactor / cleanup': /refactor|clean ?up|simplify|rewrite|remove|delete|scrap|nuke/i,
  'responsive / mobile': /responsive|mobile|breakpoint|viewport|touch/i,
  'framework / lang': /typescript|react|next\.?js|angular|astro|vue|svelte|component|tsx|\.ts\b/i,
};

const TONE = {
  'blunt / informal': /\b(dude|bro|man|wtf|crap|sucks|dumb|ugly|hate)\b/i,
  'emphatic directive': /make sure|\bdo not\b|\bdon.?t\b|\bmust\b|ensure|exactly|only\b/i,
  'agreement / go-ahead': /^(ok|okay|yes|yep|yeah|go ahead|proceed|sure|do it|continue|go on|push it|great|nice|cool|looks good)\b/i,
  'question': /\?/,
  'pushback': /^(no|nope|stop|wait|hold on|actually|meh|not )\b/i,
  'explanation request': /\b(why|how do|how to|what is|explain|compare|audit)\b/i,
  'polite': /\bplease\b/i,
  'goal framing': /recruiter|user|goal|i want|i need|my goal|impress|award/i,
};

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------
function walkJsonl(root, out = []) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) walkJsonl(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function resolveDirs(o) {
  if (o.dirs.length) return o.dirs;
  const dirs = [path.join(HOME, '.claude', 'projects')];
  if (o.includeTranscripts) dirs.push(path.join(HOME, '.claude', 'transcripts'));
  return dirs;
}

function projectOf(file, roots) {
  const root = roots.find((r) => file.startsWith(r)) || roots[0];
  const rel = path.relative(root, file);
  let name = rel.split(path.sep)[0];
  if (name.endsWith('.jsonl')) name = path.basename(rel, '.jsonl'); // transcripts style
  return name.replace(/^-Users-[^-]+-workspace-/, '').replace(/^-Users-[^-]+-/, '~').replace(/^ses_.*/, 'transcript');
}

export async function loadRecords(o) {
  const roots = resolveDirs(o);
  const files = [];
  for (const r of roots) files.push(...walkJsonl(r).filter((f) => !o.project || f.includes(o.project)));
  const cutoff = o.days ? Date.now() - o.days * 864e5 : null;

  const prompts = [], tools = [], titles = [], humanTurns = [];
  const models = {}, versions = {}, sources = {};
  const sessions = new Map();
  const usage = [], costs = [], skills = [], commands = {};
  let totalUser = 0, totalAssistant = 0, parseErrors = 0, interruptions = 0;

  const wantHuman = (src) => o.allSources || ['typed', 'queued', 'suggestion_accepted', 'sdk'].includes(src);

  for (const file of files) {
    const proj = projectOf(file, roots);
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      let rec;
      try { rec = JSON.parse(line); }
      catch { parseErrors++; continue; }
      const ts = rec.timestamp ? Date.parse(rec.timestamp) : null;
      if (cutoff && ts && ts < cutoff) continue;

      if (rec.version) versions[rec.version] = (versions[rec.version] || 0) + 1;

      if (rec.type === 'user') {
        totalUser++;
        const content = rec.message && rec.message.content;
        let text = null;
        if (typeof content === 'string') text = content;
        else if (Array.isArray(content)) {
          const block = content.find((b) => b.type === 'text');
          if (block && !rec.isMeta) text = block.text;
        }
        if (!text || !text.trim()) continue;
        const t = text.trim();
        const cm = t.match(/<command-name>([^<]+)<\/command-name>/);
        if (cm) commands[cm[1]] = (commands[cm[1]] || 0) + 1;
        const sk = t.match(/Base directory for this skill:\s*([^\n]+)/);
        if (sk) skills.push({ agent: 'claude', name: sk[1].split('/').filter(Boolean).pop(), ts, proj, source: 'inject' });
        if (/^\[Request interrupted/.test(t)) { interruptions++; continue; }
        if (NOISE.some((re) => re.test(t))) continue;
        const src = rec.promptSource || 'typed';
        sources[src] = (sources[src] || 0) + 1;
        if (!wantHuman(src)) continue;
        prompts.push({ proj, ts, text: t, len: t.length, src, template: TEMPLATE.test(t) || t.length > 800, agent: 'claude' });
      } else if (rec.type === 'assistant') {
        totalAssistant++;
        if (rec.sessionId && ts) {
          let s = sessions.get(rec.sessionId);
          if (!s) { s = { proj, turns: 0, first: ts, last: ts, agent: 'claude' }; sessions.set(rec.sessionId, s); }
          s.turns++; s.last = ts;
        }
        if (rec.message) {
          if (rec.message.model) models[rec.message.model] = (models[rec.message.model] || 0) + 1;
          const u = rec.message.usage;
          if (u) usage.push({ agent: 'claude', sessionId: rec.sessionId, proj, ts, model: rec.message.model,
            input: u.input_tokens || 0, output: u.output_tokens || 0,
            cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0,
            reasoning: (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0 });
          if (Array.isArray(rec.message.content)) {
            for (const b of rec.message.content) {
              if (b.type !== 'tool_use') continue;
              tools.push({ proj, ts, name: b.name, agent: 'claude' });
              if (b.name === 'Skill' && b.input && b.input.skill) skills.push({ agent: 'claude', name: b.input.skill, ts, proj, source: 'tool' });
            }
          }
        }
      } else if (rec.type === 'cost-state') {
        if (rec.totalCostUSD != null) costs.push({ agent: 'claude', sessionId: rec.sessionId, usd: rec.totalCostUSD, modelUsage: rec.modelUsage || null, ts });
      } else if (rec.type === 'custom-title' && rec.customTitle) {
        titles.push({ proj, ts, t: rec.customTitle, agent: 'claude' });
      } else if (rec.lastPrompt) {
        humanTurns.push({ proj, ts, text: rec.lastPrompt });
      }
    }
  }
  return { files, roots, prompts, tools, titles, humanTurns, models, versions, sources, usage, costs, skills, commands,
    sessions: [...sessions.values()], totalUser, totalAssistant, parseErrors, interruptions };
}

/** Load Claude logs, and optionally merge every other detected agent. */
export async function loadAll(o) {
  const data = await loadRecords(o);
  if (o.allAgents || o.agent) {
    const { mergeOthers } = await import('./agents.mjs');
    return await mergeOthers(data, o);
  }
  return data;
}

export function loadHistory(o) {
  if (!o.history) return { entries: [], commands: {}, typed: 0 };
  const file = path.join(HOME, '.claude', 'history.jsonl');
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

export function analyze(data, o) {
  const { prompts, tools, sessions, models } = data;
  const human = prompts.filter((p) => !p.template);
  const templates = prompts.filter((p) => p.template);

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
  const themes = {};
  for (const [k, re] of Object.entries(THEMES)) themes[k] = prompts.filter((p) => re.test(p.text)).length;
  const tone = {};
  for (const [k, re] of Object.entries(TONE)) tone[k] = prompts.filter((p) => re.test(p.text)).length;

  const agents = {};
  for (const p of prompts) { const ag = p.agent || 'claude'; agents[ag] = (agents[ag] || 0) + 1; }
  const toolsByName = {};
  for (const t of tools) toolsByName[t.name] = (toolsByName[t.name] || 0) + 1;
  const toolBuckets = { shell: 0, edit: 0, read: 0, browser: 0, agent: 0, web: 0, other: 0 };
  for (const [name, c] of Object.entries(toolsByName)) {
    if (/bash|shell|exec|terminal|command|\brun\b|run_/i.test(name)) toolBuckets.shell += c;
    else if (/browser|chrome|computer|navigate|preview|tabs_|page|screenshot/i.test(name)) toolBuckets.browser += c;
    else if (/edit|write|patch|apply|str_replace|create_file|insert|replace/i.test(name)) toolBuckets.edit += c;
    else if (/read|view|glob|grep|search|list_?files|\bls\b|\bcat\b/i.test(name)) toolBuckets.read += c;
    else if (/agent|task|skill|todo|plan|subagent|monitor|send_message/i.test(name)) toolBuckets.agent += c;
    else if (/web|fetch|http|url/i.test(name)) toolBuckets.web += c;
    else toolBuckets.other += c;
  }

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
  const skills = {};
  if (Array.isArray(data.skills)) for (const s of data.skills) skills[s.name] = (skills[s.name] || 0) + 1;
  else Object.assign(skills, data.skills || {});
  const mcpServers = {};
  for (const t of tools) if (/^mcp__/.test(t.name)) { const srv = t.name.split('__')[1]; mcpServers[srv] = (mcpServers[srv] || 0) + 1; }
  const pluginCommands = {}; const slashCommands = {};
  for (const [c, cnt] of Object.entries(data.commands || {})) { if (c.includes(':')) pluginCommands[c] = cnt; else slashCommands[c] = cnt; }
  const plugins = { mcpServers, pluginCommands, slashCommands };

  // --- prompt phases -------------------------------------------------------
  const PHASES = [
    ['Code review', /code review|review (this|the|my|diff|pr|branch|implementation)|whole-branch|task-scoped|reviewer|verdict|re-?review/i],
    ['Review', /\breview\b|audit|sanity|critique|inspect|validate|verify|check\b/i],
    ['Debugging', /\bbug|error|broken|fix\b|debug|fail|crash|not work|doesn.t work|why (is|does|did)|traceback|regression|wrong/i],
    ['Planning', /\bplan|spec\b|prd|brainstorm|architect|propose|approach|roadmap|strategy|outline|how should|what.s the best|design doc|idea|think about/i],
    ['Implementation', /\bimplement|build|create|add\b|write\b|make\b|scaffold|refactor|wire|set ?up|phase \d|tdd|component|redesign|style|polish|hook\b/i],
  ];
  const phases = {}; const phaseExamples = {};
  for (const p of human) {
    let hit = null;
    if (p.text.length < 25 && /^(yes|yep|ok|okay|continue|contiue|go ahead|do it|sure|proceed|no|nope|\d+)\b/i.test(p.text)) hit = 'Ack / continue';
    if (!hit) for (const [name, re] of PHASES) if (re.test(p.text)) { hit = name; break; }
    if (!hit) hit = 'Other';
    phases[hit] = (phases[hit] || 0) + 1;
    if (hit !== 'Other' && p.text.length < 140) { const arr = (phaseExamples[hit] = phaseExamples[hit] || []); if (arr.length < 3) arr.push(p.text); }
  }

  const busiest = Object.entries(byDay).sort((a, b) => b[1] - a[1])[0] || ['—', 0];
  const peakHour = hour.indexOf(Math.max(...hour));
  const peakDow = DOW[dow.indexOf(Math.max(...dow))];
  const weekendShare = n ? Math.round(100 * (dow[0] + dow[6]) / n) : 0;
  const topTheme = Object.entries(themes).sort((a, b) => b[1] - a[1])[0] || ['—', 0];
  const topAgent = agentMatrix[0] || { agent: 'claude', prompts: n };
  const topRepeated = Object.entries(repeated).sort((a, b) => b[1] - a[1])[0];
  const share = (v) => (n ? Math.round(100 * v / n) : 0);
  const insights = [
    { k: 'Peak hour', v: `${String(peakHour).padStart(2, '0')}:00`, d: `${hour[peakHour]} prompts · ${share(hour[peakHour])}%` },
    { k: 'Rhythm', v: weekendShare >= 40 ? 'Weekend-heavy' : 'Weekday-shifting', d: `${weekendShare}% weekends · peak ${peakDow}` },
    { k: 'Prompting', v: `${median(lens)} chars`, d: `${pct(lens, (x) => x < 40)}% terse · ${pct(lens, (x) => x > 500)}% long` },
    { k: 'Focus', v: topTheme[0], d: `${topTheme[1]} prompts · ${share(topTheme[1])}%` },
    { k: 'Primary agent', v: topAgent.agent, d: agentMatrix.length > 1 ? `${topAgent.prompts} prompts · ${share(topAgent.prompts)}%` : 'only agent detected' },
    { k: 'Sessions', v: `${median(sessTurns)} turns`, d: `median ${Math.round(median(sessDur))} min · max ${sessTurns.at(-1) || 0} turns` },
    { k: 'Busiest day', v: busiest[0], d: `${busiest[1]} prompts` },
    { k: 'Go-to prompt', v: topRepeated ? `“${topRepeated[0]}”` : '—', d: topRepeated ? `${topRepeated[1]}×` : '' },
    { k: 'Spend', v: cost.usd ? `$${cost.usd}` : 'n/a', d: `${(tokens.total / 1e6).toFixed(1)}M tokens · ${context.cacheHitRate}% cached` },
    { k: 'Context', v: context.p90 ? `${Math.round(context.p90 / 1000)}k p90` : 'n/a', d: `peak ${Math.round(context.max / 1000)}k · ${context.highTurns} turns >150k` },
  ];

  return {
    generatedAt: new Date().toISOString(),
    scope: { files: data.files.length, activeDays: activeDays.length, first: activeDays[0] || null, last: activeDays.at(-1) || null },
    volume: {
      prompts: n, humanPrompts: human.length, templatePrompts: templates.length,
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
    themes, tone, projects, agents,
    tools: { total: tools.length, byName: toolsByName, buckets: toolBuckets },
    models, sessions: {
      count: sessions.length, medianTurns: median(sessTurns), maxTurns: sessTurns.at(-1) || 0,
      avgTurns: Math.round(mean(sessTurns)), medianMinutes: Math.round(median(sessDur)),
      maxMinutes: Math.round(sessDur.at(-1) || 0), longest,
    },
    histograms: { prompt: { edges: promptHistEdges, bins: promptHist }, sessions: { edges: sessHistEdges, bins: sessHist } },
    agentMatrix, insights,
    tokens, cost, context, skills, plugins, phases, phaseExamples,
    repeated: Object.entries(repeated).sort((a, b) => b[1] - a[1]).slice(0, o.top),
    sampleTitles: [...new Set((data.titles || []).map((t) => t.t))].slice(0, o.top),
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function bar(v, max, width = 30) { return '█'.repeat(max ? Math.round((v / max) * width) : 0); }

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
  L.push(multi ? 'CODING AGENT HABITS REPORT' : 'CLAUDE CODE HABITS REPORT');
  L.push(`Generated ${a.generatedAt.slice(0, 19).replace('T', ' ')}  |  ${a.scope.files} transcripts  |  ${a.scope.first} → ${a.scope.last}`);

  sec('PATTERNS');
  for (const i of a.insights) L.push(`  ${i.k.padEnd(16)} ${String(i.v).padEnd(24)} ${i.d}`);

  sec('VOLUME');
  row('Human prompt turns', `${a.volume.prompts} (${a.volume.humanPrompts} conversational, ${a.volume.templatePrompts} templates)`);
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

  sec('THEMES (share of prompts)');
  rank(a.themes, a.volume.prompts, 20);

  sec('TONE MARKERS');
  Object.entries(a.tone).sort((x, y) => y[1] - x[1]).forEach(([k, v]) => row(k, `${v} (${Math.round(100 * v / (a.volume.prompts || 1))}%)`));

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

  sec('SKILLS & PLUGINS');
  const skTotal = Object.values(a.skills || {}).reduce((s, v) => s + v, 0);
  if (Object.keys(a.skills || {}).length) rank(a.skills, skTotal, o.top); else L.push('  no skill invocations detected');
  if (a.plugins) {
    L.push('  MCP servers:');
    rank(a.plugins.mcpServers, a.tools.total, 10);
    if (Object.keys(a.plugins.pluginCommands).length) { L.push('  plugin commands:'); rank(a.plugins.pluginCommands, Object.values(a.plugins.pluginCommands).reduce((s, v) => s + v, 0), 10); }
  }

  sec('PROMPT PHASES');
  rank(a.phases || {}, a.volume.humanPrompts || a.volume.prompts, 10);
  for (const [name, ex] of Object.entries(a.phaseExamples || {})) if (ex && ex[0]) L.push(`    ${name}: “${String(ex[0]).replace(/\s+/g, ' ').slice(0, 70)}”`);

  sec('MOST-REPEATED SHORT PROMPTS');
  a.repeated.forEach(([k, v]) => L.push(`  ${String(v).padStart(3)} × "${k}"`));

  if (o.history) {
    sec('CLI HISTORY (typed)');
    row('Non-command entries', hist.typed);
    row('Distinct slash/! commands', Object.keys(hist.commands).length);
    rank(hist.commands, hist.entries.length, o.top);
  }

  if (a.sampleTitles.length) {
    sec('SESSION TITLES (task labels)');
    a.sampleTitles.forEach((t) => L.push(`  - ${t}`));
  }
  return L.join('\n');
}

function renderMd(a, hist, o) {
  const pct = (v, t) => t ? `${Math.round(100 * v / t)}%` : '0%';
  const title = Object.keys(a.agents || {}).some((x) => x !== 'claude') ? 'Coding Agent Habits' : 'Claude Code Habits';
  const L = [`# ${title} Report`, '', `_Generated ${a.generatedAt.slice(0, 19).replace('T', ' ')} — ${a.scope.files} transcripts, ${a.scope.first} → ${a.scope.last}_`, ''];
  L.push('## Volume', '', '| Metric | Value |', '| --- | --- |',
    `| Human prompt turns | ${a.volume.prompts} (${a.volume.humanPrompts} conversational, ${a.volume.templatePrompts} templates) |`,
    `| Assistant turns | ${a.volume.totalAssistant} |`,
    `| Tool calls | ${a.volume.toolCalls} |`,
    `| Active days | ${a.scope.activeDays} |`,
    `| Prompts / active day | ${a.volume.promptsPerActiveDay} |`, '');
  L.push('## Cadence', '', '| Hour | Prompts |', '| --- | --- |');
  a.cadence.hour.forEach((v, h) => { if (v) L.push(`| ${String(h).padStart(2, '0')}h | ${v} |`); });
  L.push('', `Weekday: ${Object.entries(a.cadence.dow).map(([d, v]) => `${d} ${v}`).join(', ')}`, '');
  L.push('## Themes', '', '| Theme | Prompts | Share |', '| --- | --- | --- |');
  Object.entries(a.themes).sort((x, y) => y[1] - x[1]).forEach(([k, v]) => L.push(`| ${k} | ${v} | ${pct(v, a.volume.prompts)} |`));
  L.push('', '## Tone', '');
  Object.entries(a.tone).sort((x, y) => y[1] - x[1]).forEach(([k, v]) => L.push(`- ${k}: ${v} (${pct(v, a.volume.prompts)})`));
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

  const started = Date.now();
  const data = await loadAll(o);
  if (o.errors && data.parseErrors) console.error(`[cc-habits] ${data.parseErrors} unparseable lines skipped`);
  if (!data.files.length) { console.error('No transcript files found. Check --dir.'); process.exit(1); }
  const hist = loadHistory(o);
  const analysis = analyze(data, o);

  if (o.format === 'json') console.log(JSON.stringify({ ...analysis, cliHistory: o.history ? hist : undefined }, null, 2));
  else if (o.format === 'md') console.log(renderMd(analysis, hist, o));
  else console.log(renderText(analysis, hist, o));

  if (o.format === 'text') console.error(`\n[cc-habits] ${data.files.length} files, ${(data.prompts.length)} prompts analyzed in ${Date.now() - started}ms`);
}

let isMain = false;
try { isMain = !!process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { /* ignore */ }
if (isMain) main().catch((err) => { console.error(err); process.exit(1); });
