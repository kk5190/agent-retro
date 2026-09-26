/**
 * agents.mjs — multi-agent log collectors for cc-habits.
 *
 * Each adapter reads a different local store and emits normalized events:
 *   { agent, sessionId, project, ts, role, text, toolName?, model? }
 *
 * Verified against on-disk schemas for: Claude Code, pi, Codex CLI, opencode,
 * Continue, Zed, Cursor. Other stores are discovery-only (see STORES).
 *
 * Zero dependencies. SQLite via the `sqlite3` CLI.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';

const HOME = process.env.CC_HABITS_HOME || os.homedir();

// ---------------------------------------------------------------------------
// Discovery catalog (scan shows everything found, parsed or not)
// ---------------------------------------------------------------------------
export const STORES = [
  { id: 'claude', name: 'Claude Code', paths: ['~/.claude/projects', '~/.claude/transcripts'], parses: true, note: 'native' },
  { id: 'pi', name: 'pi', paths: ['~/.pi/agent/sessions'], parses: true, note: 'jsonl' },
  { id: 'codex', name: 'Codex CLI', paths: ['~/.codex/sessions'], parses: true, note: 'jsonl rollout' },
  { id: 'opencode', name: 'opencode', paths: ['~/.local/share/opencode/storage', '~/.opencode/storage', '~/.config/opencode/storage'], parses: true, note: 'json graph' },
  { id: 'continue', name: 'Continue', paths: ['~/.continue/sessions'], parses: true, note: 'json' },
  { id: 'zed', name: 'Zed', paths: ['~/Library/Application Support/Zed/threads'], parses: true, note: 'sqlite + zstd' },
  { id: 'cursor', name: 'Cursor', paths: ['~/Library/Application Support/Cursor/User/globalStorage/state.vscdb'], parses: true, note: 'sqlite kv' },
  { id: 'antigravity', name: 'Antigravity / Gemini', paths: ['~/.gemini/antigravity-cli/conversations', '~/.antigravity'], parses: false, note: 'sqlite blobs — not yet parsed' },
  { id: 'windsurf', name: 'Windsurf', paths: ['~/.codeium/windsurf'], parses: false, note: 'not parsed' },
  { id: 'copilot', name: 'GitHub Copilot', paths: ['~/.copilot'], parses: false, note: 'not parsed' },
  { id: 'amp', name: 'Amp', paths: ['~/.config/amp'], parses: false, note: 'not parsed' },
  { id: 'factory', name: 'Factory', paths: ['~/.factory'], parses: false, note: 'not parsed' },
];

// ---------------------------------------------------------------------------
// Shared text hygiene
// ---------------------------------------------------------------------------
const NOISE = [
  /^\s*\[Image:/, /^\s*\[Request interrupted/, /^\s*<task-notification/,
  /^\s*Base directory for this skill/, /^\s*<launch-selected-element/,
  /^\s*<command-name>/, /^\s*<command-message/, /^\s*<system-reminder/,
  /^\s*<local-command/, /^\s*This session is being continued/,
  /^\s*<bash-input>/, /^\s*<bash-stdout>/, /^\s*<bash-stderr>/,
  /^\s*<preview-annotation-context/, /^\s*\[Usage limit approaching/,
  /^\s*<environment_context>/, /^\s*<user_instructions>/, /^\s*<ENVIRONMENT/,
  /^\s*<permissions instructions>/, /^\s*<turn_aborted/,
  /^\s*\[Your previous response had no visible output/,
];
const TEMPLATE = /^(you are|review\b|#|learn\b|analyz|analys|read the|implement the|fix the following|the \/|create a spec|investigate|verify that|as a |act as |your (job|task)|superpowers|i'm planning a fix)/i;

function classify(text) {
  const t = (text || '').trim();
  if (!t || NOISE.some((re) => re.test(t))) return null;
  return { text: t, template: TEMPLATE.test(t) || t.length > 800 };
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && (b.type === 'text' || b.type === 'input_text' || b.type === 'output_text'))
      .map((b) => b.text || '')
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content.text === 'string') return content.text;
  return '';
}

function basenameOf(p) { return p ? path.basename(String(p).replace(/\/+$/, '')) : 'unknown'; }

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------
function walkFiles(root, match, out = [], limit = 20000) {
  if (out.length >= limit) return out;
  let ents; try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (out.length >= limit) break;
    const p = path.join(root, e.name);
    if (e.isDirectory()) walkFiles(p, match, out, limit);
    else if (e.isFile() && match(e.name)) out.push(p);
  }
  return out;
}

function readJsonl(file, onRec) {
  let data; try { data = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of data.split('\n')) {
    if (!line) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    onRec(rec);
  }
}

function sqlite(db, sql) {
  try { return execFileSync('sqlite3', [db, sql], { encoding: 'utf8', maxBuffer: 1 << 28 }).trim(); }
  catch { return ''; }
}

// ---------------------------------------------------------------------------
// Anti-rot layer 1: shape-based parsing for when exact field names change
// ---------------------------------------------------------------------------
const KEY_TS = /^(t|ts|time|time_stamp|timestamp|date|created|created_at|createdat|updated|updated_at|mtime|at|when)$/i;
const KEY_ROLE = /^(role|author|sender|speaker|from|message_type|msg_type)$/i;
const KEY_TEXT = /^(text|content|message|body|prompt|completion|output|input|richtext|markdown|body_text|value)$/i;
const KEY_TOOL = /^(name|tool|toolname|tool_name|function|function_name)$/i;
const ROLE_MAP = { user: 'user', human: 'user', prompt: 'user', assistant: 'assistant', ai: 'assistant', model: 'assistant', bot: 'assistant', agent: 'assistant', tool: 'tool', function: 'tool', toolresult: 'tool', toolcall: 'tool', system: 'system' };

function asTime(v) {
  if (typeof v === 'number') { if (v > 1e12) return v; if (v > 1e9) return v * 1000; return null; }
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isNaN(t) ? null : t; }
  return null;
}

function scanFor(obj, keyRe, want, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return null;
  if (Array.isArray(obj)) { for (const x of obj) { const r = scanFor(x, keyRe, want, depth + 1); if (r != null) return r; } return null; }
  for (const [k, v] of Object.entries(obj)) {
    if (keyRe.test(k)) {
      if (want === 'time') { const t = asTime(v); if (t) return t; }
      else if (want === 'role') { const r = ROLE_MAP[String(v).toLowerCase().replace(/[\s_-]/g, '')]; if (r) return r; }
      else if (want === 'tool' && typeof v === 'string' && v.length < 60) return v;
    }
  }
  for (const v of Object.values(obj)) if (v && typeof v === 'object') { const r = scanFor(v, keyRe, want, depth + 1); if (r != null) return r; }
  return null;
}

function harvestText(obj, depth = 0) {
  if (obj == null || depth > 5) return '';
  if (typeof obj === 'string') return obj.trim().length > 1 ? obj : '';
  if (Array.isArray(obj)) {
    const parts = obj.map((x) => {
      if (x && typeof x === 'object') {
        const t = x.text != null ? x.text : (x.content != null ? x.content : x.value);
        if (typeof t === 'string' && t.trim() && (x.type === undefined || /text|input|output|message|markdown/i.test(String(x.type)))) return t;
        return harvestText(x, depth + 1);
      }
      return typeof x === 'string' ? x : '';
    }).filter(Boolean);
    return parts.join('\n');
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) if (KEY_TEXT.test(k)) { const t = harvestText(v, depth + 1); if (t) return t; }
    for (const v of Object.values(obj)) if (v && typeof v === 'object') { const t = harvestText(v, depth + 1); if (t) return t; }
  }
  return '';
}

/** Best-effort extraction of a normalized event from an arbitrary record. */
export function harvestEvents(record, ctx = {}) {
  if (!record || typeof record !== 'object') return [];
  const role = scanFor(record, KEY_ROLE, 'role');
  const ts = scanFor(record, KEY_TS, 'time') != null ? scanFor(record, KEY_TS, 'time') : (ctx.ts != null ? ctx.ts : null);
  const out = [];
  if (role === 'tool') {
    out.push({ agent: ctx.agent, sessionId: ctx.sessionId, project: ctx.project, ts, role: 'tool', toolName: scanFor(record, KEY_TOOL, 'tool') || 'tool' });
    return out;
  }
  if (role !== 'user' && role !== 'assistant') return [];
  const text = harvestText(record);
  if (text) out.push({ agent: ctx.agent, sessionId: ctx.sessionId, project: ctx.project, ts, role, text });
  const blocks = Array.isArray(record.content) ? record.content
    : (record.message && Array.isArray(record.message.content) ? record.message.content : []);
  for (const b of blocks) {
    if (b && /tool(_|-)?use|toolcall|tool_call|function_call/i.test(String(b.type))) {
      out.push({ agent: ctx.agent, sessionId: ctx.sessionId, project: ctx.project, ts, role: 'tool', toolName: b.name || b.toolName || 'tool' });
    }
  }
  return out;
}

function genericRoots(agentId) {
  const s = STORES.find((x) => x.id === agentId); if (!s) return [];
  return s.paths.map((p) => p.replace('~', HOME)).filter((p) => fs.existsSync(p));
}

/** Fallback collector: harvest events from raw JSON/JSONL under a store's roots. */
export function collectGeneric(agentId, o = {}) {
  const events = [];
  const cutoff = o.days ? Date.now() - o.days * 864e5 : null;
  for (const root of genericRoots(agentId)) {
    const st = fs.statSync(root);
    const files = st.isDirectory() ? walkFiles(root, (n) => /\.(jsonl|json)$/i.test(n), [], 3000) : [root];
    for (const f of files) {
      const project = basenameOf(path.dirname(f));
      const sessionId = path.basename(f).replace(/\.(jsonl|json)$/i, '');
      const push = (r) => { for (const e of harvestEvents(r, { agent: agentId, project, sessionId })) { if (!cutoff || !e.ts || e.ts >= cutoff) events.push(e); } };
      if (f.endsWith('.jsonl')) readJsonl(f, push);
      else { try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); const recs = Array.isArray(j) ? j : (Array.isArray(j.messages) ? j.messages : [j]); for (const r of recs) push(r); } catch { /* skip */ } }
    }
  }
  return events;
}

/** Best-effort events for one agent: precise adapter, else shape-based fallback. */
export function collectFor(id, o = {}) {
  if (id === 'claude') return [];
  const fn = ADAPTERS[id]; if (!fn) return [];
  let ev = []; try { ev = fn(o) || []; } catch { ev = []; }
  if (!ev.length) ev = collectGeneric(id, o);
  return ev;
}

// ---------------------------------------------------------------------------
// Adapters — each returns normalized events
// ---------------------------------------------------------------------------
function collectPi(o) {
  const events = [];
  const root = path.join(HOME, '.pi/agent/sessions');
  if (!fs.existsSync(root)) return events;
  for (const file of walkFiles(root, (n) => n.endsWith('.jsonl'))) {
    let sid = path.basename(file, '.jsonl'); let proj = basenameOf(path.dirname(file));
    readJsonl(file, (r) => {
      const ts = r.timestamp ? Date.parse(r.timestamp) : null;
      if (r.type === 'session') { sid = r.id || sid; proj = basenameOf(r.cwd) || proj; return; }
      if (r.type !== 'message' || !r.message) return;
      const m = r.message;
      if (m.role === 'toolResult') { events.push({ agent: 'pi', sessionId: sid, project: proj, ts, role: 'tool', toolName: m.toolName || 'tool' }); return; }
      if (m.role !== 'user' && m.role !== 'assistant') return;
      const text = textFromContent(m.content);
      if (text) events.push({ agent: 'pi', sessionId: sid, project: proj, ts, role: m.role, text, model: m.model });
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b && (b.type === 'toolCall' || b.type === 'tool_use')) events.push({ agent: 'pi', sessionId: sid, project: proj, ts, role: 'tool', toolName: b.name || b.toolName || 'tool' });
        }
      }
      if (m.usage) events.push({ agent: 'pi', sessionId: sid, project: proj, ts, role: 'usage', model: m.model,
        input: m.usage.input || 0, output: m.usage.output || 0,
        cacheRead: m.usage.cacheRead || 0, cacheWrite: m.usage.cacheWrite || 0,
        reasoning: m.usage.reasoning || 0, cost: (m.usage.cost && m.usage.cost.total) != null ? m.usage.cost.total : null });
    });
  }
  return events;
}

function collectCodex(o) {
  const events = [];
  const root = path.join(HOME, '.codex/sessions');
  if (!fs.existsSync(root)) return events;
  for (const file of walkFiles(root, (n) => n.endsWith('.jsonl'))) {
    let sid = path.basename(file, '.jsonl'); let proj = 'codex';
    readJsonl(file, (r) => {
      const p = r.payload || {}; const ts = r.timestamp ? Date.parse(r.timestamp) : null;
      if (r.type === 'session_meta' || p.type === 'session_meta' || p.session_id) {
        if (p.session_id) sid = p.session_id; if (p.cwd) proj = basenameOf(p.cwd); return;
      }
      if (p.type === 'message') {
        const role = p.role === 'assistant' ? 'assistant' : 'user';
        const text = textFromContent(p.content);
        if (text) events.push({ agent: 'codex', sessionId: sid, project: proj, ts, role, text });
        return;
      }
      if (p.type === 'token_count' && p.info && p.info.total_token_usage) {
        const u = p.info.total_token_usage;
        events.push({ agent: 'codex', sessionId: sid, project: proj, ts, role: 'usage', cumulative: true,
          input: Math.max(0, (u.input_tokens || 0) - (u.cached_input_tokens || 0)), output: u.output_tokens || 0,
          cacheRead: u.cached_input_tokens || 0, cacheWrite: u.cache_write_input_tokens || 0, reasoning: u.reasoning_output_tokens || 0,
          ctx: (p.info.last_token_usage && p.info.last_token_usage.input_tokens) || 0 });
      }
      if (p.type === 'function_call' || p.type === 'local_shell_call' || p.type === 'custom_tool_call') {
        events.push({ agent: 'codex', sessionId: sid, project: proj, ts, role: 'tool', toolName: p.name || p.type });
      }
    });
  }
  return events;
}

function collectOpencode(o) {
  const events = [];
  const roots = ['~/.local/share/opencode/storage', '~/.opencode/storage', '~/.config/opencode/storage'].map((p) => p.replace('~', HOME));
  const root = roots.find((p) => fs.existsSync(p)); if (!root) return events;

  // sessions: session/<group>/<id>.json
  const sessions = {};
  const sdir = path.join(root, 'session');
  if (fs.existsSync(sdir)) for (const f of walkFiles(sdir, (n) => n.endsWith('.json'))) {
    try { const s = JSON.parse(fs.readFileSync(f, 'utf8')); sessions[s.id] = s; } catch { /* skip */ }
  }
  // parts: part/<msgID>/<partID>.json
  const parts = {};
  const pdir = path.join(root, 'part');
  if (fs.existsSync(pdir)) for (const f of walkFiles(pdir, (n) => n.endsWith('.json'))) {
    try { const pt = JSON.parse(fs.readFileSync(f, 'utf8')); (parts[pt.messageID] = parts[pt.messageID] || []).push(pt); } catch { /* skip */ }
  }
  // messages: message/<sessionID>/<msgID>.json
  const mdir = path.join(root, 'message');
  if (fs.existsSync(mdir)) for (const f of walkFiles(mdir, (n) => n.endsWith('.json'))) {
    let m; try { m = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const s = sessions[m.sessionID] || {};
    const proj = basenameOf(s.directory || m.path && m.path.cwd) || 'opencode';
    const ts = m.time && (m.time.created || m.time.completed);
    const blocks = parts[m.id] || [];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n');
    if (text) events.push({ agent: 'opencode', sessionId: m.sessionID, project: proj, ts, role: m.role, text, model: m.modelID });
    for (const b of blocks) if (b.type === 'tool' || b.type === 'tool_use') events.push({ agent: 'opencode', sessionId: m.sessionID, project: proj, ts, role: 'tool', toolName: (b.tool && (b.tool.name || b.tool)) || 'tool' });
    if (m.cost != null || m.tokens) events.push({ agent: 'opencode', sessionId: m.sessionID, project: proj, ts, role: 'usage', model: m.modelID,
      input: (m.tokens && m.tokens.input) || 0, output: (m.tokens && m.tokens.output) || 0,
      cacheRead: (m.tokens && m.tokens.cache && m.tokens.cache.read) || 0, cacheWrite: (m.tokens && m.tokens.cache && m.tokens.cache.write) || 0,
      reasoning: (m.tokens && m.tokens.reasoning) || 0, cost: m.cost != null ? m.cost : null });
  }
  return events;
}

function collectContinue(o) {
  const events = [];
  const dir = path.join(HOME, '.continue/sessions');
  if (!fs.existsSync(dir)) return events;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f === 'sessions.json') continue;
    let s; try { s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const proj = basenameOf(s.workspaceDirectory) || 'continue';
    const items = Array.isArray(s.history) ? s.history : [];
    // ts is only reliably available at session granularity
    items.forEach((it, i) => {
      const msg = it.message || it; if (!msg || !msg.role) return;
      const role = msg.role === 'assistant' ? 'assistant' : 'user';
      const text = textFromContent(msg.content);
      if (text) events.push({ agent: 'continue', sessionId: s.sessionId || f, project: proj, ts: null, role, text });
    });
  }
  const dd = path.join(HOME, '.continue/dev_data');
  if (fs.existsSync(dd)) for (const f of walkFiles(dd, (n) => n.endsWith('.jsonl'))) {
    readJsonl(f, (r) => {
      if (r.promptTokens == null && r.generatedTokens == null) return;
      events.push({ agent: 'continue', sessionId: 'dev_data', project: 'continue', ts: r.timestamp ? Date.parse(r.timestamp) : null, role: 'usage', model: r.model, input: r.promptTokens || 0, output: r.generatedTokens || 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
    });
  }
  return events;
}

function collectZed(o) {
  const events = [];
  const root = path.join(HOME, 'Library/Application Support/Zed/threads');
  if (!fs.existsSync(root)) return events;
  const dbs = fs.readdirSync(root).filter((n) => n.endsWith('.db'));
  for (const name of dbs) {
    const db = path.join(root, name);
    const rows = sqlite(db, "SELECT id, summary, created_at, data_type, hex(data) FROM threads;");
    if (!rows) continue;
    for (const line of rows.split('\n')) {
      const [id, summary, created, dtype, hex] = line.split('|');
      if (!hex) continue;
      let raw = Buffer.from(hex, 'hex');
      try { if (dtype === 'zstd') raw = zlib.zstdDecompressSync(raw); } catch { continue; }
      let thread; try { thread = JSON.parse(raw.toString('utf8')); } catch { continue; }
      const ts = thread.updated_at || (created ? Number(created) : null);
      const proj = basenameOf((thread.folder_paths && thread.folder_paths[0])) || 'zed';
      const msgs = extractMessages(thread);
      for (const m of msgs) {
        const text = textFromContent(m.content) || m.text || '';
        if (text) events.push({ agent: 'zed', sessionId: id, project: proj, ts, role: m.role === 'assistant' ? 'assistant' : 'user', text });
        if (Array.isArray(m.content)) for (const b of m.content) if (b && b.type === 'tool_use') events.push({ agent: 'zed', sessionId: id, project: proj, ts, role: 'tool', toolName: b.name });
      }
      if (summary) events.push({ agent: 'zed', sessionId: id, project: proj, ts, role: 'title', text: summary });
    }
  }
  return events;
}

// tolerant walk for message-shaped objects
function extractMessages(node, out = [], depth = 0) {
  if (!node || depth > 8) return out;
  if (Array.isArray(node)) { for (const x of node) extractMessages(x, out, depth + 1); return out; }
  if (typeof node !== 'object') return out;
  if ((node.role === 'user' || node.role === 'assistant') && (node.content || node.text)) out.push(node);
  for (const v of Object.values(node)) if (v && typeof v === 'object') extractMessages(v, out, depth + 1);
  return out;
}

function collectCursor(o) {
  const events = [];
  const db = path.join(HOME, 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
  if (!fs.existsSync(db)) return events;
  // composers
  const headers = sqlite(db, 'SELECT composerId, createdAt, value FROM composerHeaders;');
  const composers = {};
  for (const line of (headers ? headers.split('\n') : [])) {
    const m = line.match(/^([^|]*)\|([^|]*)\|(.*)$/); if (!m) continue;
    const [, id, created, valueJson] = m;
    let v = {}; try { v = JSON.parse(valueJson); } catch { /* keep {} */ }
    composers[id] = { created: Number(created) || null, title: v.name || '', ws: v.workspaceIdentifier && (v.workspaceIdentifier.uri || v.workspaceIdentifier.id) };
  }
  // bubbles
  const bubbleKeys = sqlite(db, "SELECT key FROM cursorDiskKV WHERE key LIKE 'bubbleId:%';");
  const byComposer = {};
  for (const k of (bubbleKeys ? bubbleKeys.split('\n') : [])) (byComposer[k.split(':')[1]] = true);
  for (const composerId of Object.keys(byComposer)) {
    const rows = sqlite(db, `SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:${composerId}:%';`);
    const c = composers[composerId] || {};
    const proj = basenameOf(c.ws) || 'cursor';
    for (const line of (rows ? rows.split('\n') : [])) {
      const idx = line.indexOf('|'); if (idx < 0) continue;
      let b; try { b = JSON.parse(line.slice(idx + 1)); } catch { continue; }
      const text = b.text || textFromContent(b.richText) || '';
      // Cursor bubble.type: 1 = user, 2 = assistant
      const role = b.type === 2 ? 'assistant' : 'user';
      if (text) events.push({ agent: 'cursor', sessionId: composerId, project: proj, ts: c.created, role, text });
    }
  }
  return events;
}

const ADAPTERS = { pi: collectPi, codex: collectCodex, opencode: collectOpencode, continue: collectContinue, zed: collectZed, cursor: collectCursor };
export const PARSABLE = Object.keys(ADAPTERS);

// ---------------------------------------------------------------------------
// events -> analysis data shape
// ---------------------------------------------------------------------------
function eventsToData(events, o) {
  const cutoff = o.days ? Date.now() - o.days * 864e5 : null;
  const prompts = [], tools = [], titles = [], models = {}, sources = {}, usage = [], skills = {};
  const sessions = new Map();
  let totalUser = 0, totalAssistant = 0;

  for (const e of events) {
    if (cutoff && e.ts && e.ts < cutoff) continue;
    if (e.project && o.project && !e.project.includes(o.project)) continue;
    const agent = e.agent;
    if (e.role === 'title') { titles.push({ proj: e.project, ts: e.ts, t: e.text, agent }); continue; }
    if (e.role === 'usage') { usage.push({ agent, sessionId: e.sessionId, proj: e.project, ts: e.ts, model: e.model, input: e.input || 0, output: e.output || 0, cacheRead: e.cacheRead || 0, cacheWrite: e.cacheWrite || 0, reasoning: e.reasoning || 0, ctx: e.ctx || 0, cost: e.cost != null ? e.cost : null, cumulative: !!e.cumulative }); continue; }
    if (e.role === 'skill') { const nm = e.text || e.toolName || 'skill'; skills[nm] = (skills[nm] || 0) + 1; continue; }
    if (e.role === 'tool') { tools.push({ proj: e.project || agent, ts: e.ts, name: e.toolName || 'tool', agent }); continue; }
    if (e.role !== 'user' && e.role !== 'assistant') continue;
    if (e.role === 'user') totalUser++; else totalAssistant++;
    if (e.model) models[e.model] = (models[e.model] || 0) + 1;
    const c = classify(e.text); if (!c) continue;
    sources[`${agent}:log`] = (sources[`${agent}:log`] || 0) + 1;
    prompts.push({ proj: e.project || agent, ts: e.ts, text: c.text, len: c.text.length, src: 'log', template: c.template, agent });
    if (e.sessionId && e.ts) {
      const key = `${agent}:${e.sessionId}`;
      let s = sessions.get(key);
      if (!s) { s = { proj: e.project || agent, turns: 0, first: e.ts, last: e.ts, agent }; sessions.set(key, s); }
      s.turns++; s.last = Math.max(s.last, e.ts);
    }
  }
  return { files: [], roots: [], prompts, tools, titles, humanTurns: [], models, versions: {}, sources,
    sessions: [...sessions.values()], totalUser, totalAssistant, parseErrors: 0, interruptions: 0, usage, skills, costs: [], commands: {} };
}

function emptyData() {
  return { files: [], roots: [], prompts: [], tools: [], titles: [], humanTurns: [], models: {}, versions: {},
    sources: {}, sessions: [], totalUser: 0, totalAssistant: 0, parseErrors: 0, interruptions: 0, usage: [], skills: {}, costs: [], commands: {} };
}

function mergeInto(base, add) {
  base.prompts.push(...add.prompts); base.tools.push(...add.tools); base.titles.push(...add.titles);
  base.sessions.push(...add.sessions);
  base.usage.push(...(add.usage || []));
  for (const [k, v] of Object.entries(add.skills || {})) base.skills[k] = (base.skills[k] || 0) + v;
  if (add.costs) base.costs.push(...add.costs);
  for (const [k, v] of Object.entries(add.commands || {})) base.commands[k] = (base.commands[k] || 0) + v;
  base.totalUser += add.totalUser; base.totalAssistant += add.totalAssistant;
  for (const [k, v] of Object.entries(add.models)) base.models[k] = (base.models[k] || 0) + v;
  for (const [k, v] of Object.entries(add.sources)) base.sources[k] = (base.sources[k] || 0) + v;
  return base;
}

/**
 * Merge non-Claude agent data into a Claude-shaped data object.
 * `o.allAgents` or `o.agent` triggers this. Claude data is expected to already
 * be tagged with agent:'claude' by the caller.
 */
export async function mergeOthers(data, o) {
  if (o.agent === 'claude') return data; // Claude data is already the only thing loaded
  const wanted = o.agent ? [o.agent] : PARSABLE;
  const merged = o.agent ? emptyData() : data;
  for (const id of wanted) {
    const fn = ADAPTERS[id]; if (!fn) continue;
    try {
      let ev = fn(o) || [];
      if (!ev.length) {
        const g = collectGeneric(id, o);
        if (g.length) { ev = g; if (o.errors) console.error(`[agents] ${id}: precise adapter empty; shape-based fallback recovered ${g.length} events`); }
      }
      mergeInto(merged, eventsToData(ev, o));
    } catch (err) { if (o.errors) console.error(`[agents] ${id}: ${err.message}`); }
  }
  if (o.agent) {
    // single-agent filter: keep only that agent
    const keep = (arr) => { const f = arr.filter((x) => x.agent === o.agent); arr.length = 0; arr.push(...f); };
    keep(merged.prompts); keep(merged.tools); keep(merged.titles);
    const s = merged.sessions.filter((x) => x.agent === o.agent); merged.sessions.length = 0; merged.sessions.push(...s);
  }
  merged.files = data.files; merged.roots = data.roots;
  return merged;
}

// ---------------------------------------------------------------------------
// scan — discovery only, no parsing
// ---------------------------------------------------------------------------
export function scanStores() {
  return STORES.map((s) => {
    const found = s.paths.map((p) => p.replace('~', HOME)).filter((p) => fs.existsSync(p));
    let files = 0, bytes = 0;
    for (const p of found) {
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        const all = walkFiles(p, () => true, [], 5000);
        files += all.length;
        for (const f of all.slice(0, 5000)) { try { bytes += fs.statSync(f).size; } catch { /* skip */ } }
      } else { files++; bytes += st.size; }
    }
    return { id: s.id, name: s.name, parses: s.parses, note: s.note, found, files, mb: +(bytes / 1e6).toFixed(1) };
  }).filter((s) => s.found.length);
}

// ---------------------------------------------------------------------------
// Anti-rot layer 2: per-adapter health / yield report
// ---------------------------------------------------------------------------
export function adapterHealth(o = {}) {
  const report = [];
  for (const id of PARSABLE) {
    const fn = ADAPTERS[id];
    let events = [];
    try { events = fn(o) || []; }
    catch (e) { report.push({ id, files: 0, events: 0, fallback: false, status: 'ERROR', error: e.message }); continue; }
    const files = genericRoots(id).reduce((n, r) => {
      const st = fs.statSync(r);
      return n + (st.isDirectory() ? walkFiles(r, (x) => /\.(jsonl|json|db|sqlite|vscdb)$/i.test(x), [], 3000).length : 1);
    }, 0);
    let fallback = false;
    if (!events.length && files) { const g = collectGeneric(id, o); if (g.length) { fallback = true; events = g; } }
    const status = events.length ? (fallback ? 'FALLBACK' : 'ok') : (files ? 'STALE' : 'EMPTY');
    report.push({ id, files, events: events.length, fallback, status });
  }
  return report;
}
