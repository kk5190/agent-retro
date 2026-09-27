/**
 * agents.mjs — multi-agent log collectors for agent-retro.
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
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';

/** Resolved on each use so --demo (and tests) can point every reader at another home. */
const home = () => process.env.AGENT_RETRO_HOME || os.homedir();

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
export const NOISE = [
  /^\s*\[Image:/, /^\s*\[Request interrupted/, /^\s*<task-notification/,
  /^\s*Base directory for this skill/, /^\s*<launch-selected-element/,
  /^\s*<command-name>/, /^\s*<command-message/, /^\s*<system-reminder/,
  /^\s*<local-command/, /^\s*This session is being continued/,
  /^\s*<bash-input>/, /^\s*<bash-stdout>/, /^\s*<bash-stderr>/,
  /^\s*<preview-annotation-context/, /^\s*\[Usage limit approaching/,
  /^\s*<environment_context>/, /^\s*<user_instructions>/, /^\s*<ENVIRONMENT/,
  /^\s*<permissions instructions>/, /^\s*<turn_aborted/,
  /^\s*\[Your previous response had no visible output/,
  /^\s*<user-prompt-submit-hook/, /^\s*\[Automated/,
];
export const TEMPLATE = /^(you are|review\b|#|learn\b|analyz|analys|read the|implement the|fix the following|the \/|create a spec|investigate|verify that|as a |act as |your (job|task)|superpowers|i'm planning a fix)/i;

/** promptSource values that represent a person typing (Claude Code). */
export const HUMAN_SRC = ['typed', 'queued', 'suggestion_accepted', 'sdk'];

export function classify(text) {
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

/** Short, human-meaningful argument of a tool call: shell command, skill, subagent, or file path. */
export function toolDetail(input) {
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch { return undefined; } }
  if (!input || typeof input !== 'object') return undefined;
  const cmd = input.command != null ? input.command : input.cmd;
  if (cmd != null) return (Array.isArray(cmd) ? cmd.join(' ') : String(cmd)).slice(0, 300);
  if (input.skill) return String(input.skill);
  if (input.subagent_type) return `${input.subagent_type}: ${input.description || ''}`.slice(0, 160);
  const f = input.file_path || input.filePath || input.notebook_path || input.path;
  return f ? String(f) : undefined;
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
      out.push({ agent: ctx.agent, sessionId: ctx.sessionId, project: ctx.project, ts, role: 'tool', toolName: b.name || b.toolName || 'tool', detail: toolDetail(b.input || b.arguments) });
    }
  }
  return out;
}

function genericRoots(agentId) {
  const s = STORES.find((x) => x.id === agentId); if (!s) return [];
  return s.paths.map((p) => p.replace('~', home())).filter((p) => fs.existsSync(p));
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
  const root = path.join(home(), '.pi/agent/sessions');
  if (!fs.existsSync(root)) return events;
  for (const file of walkFiles(root, (n) => n.endsWith('.jsonl'))) {
    let sid = path.basename(file, '.jsonl'); let proj = basenameOf(path.dirname(file));
    readJsonl(file, (r) => {
      const ts = r.timestamp ? Date.parse(r.timestamp) : null;
      if (r.type === 'session') { sid = r.id || sid; proj = basenameOf(r.cwd) || proj; return; }
      if (r.type !== 'message' || !r.message) return;
      const m = r.message;
      if (m.role === 'toolResult') { if (m.isError) events.push({ agent: 'pi', sessionId: sid, project: proj, ts, role: 'tool_error', toolName: m.toolName || 'tool', text: firstText(m.content) }); return; }
      if (m.role !== 'user' && m.role !== 'assistant') return;
      const text = textFromContent(m.content);
      if (text) events.push({ agent: 'pi', sessionId: sid, project: proj, ts, role: m.role, text, model: m.model });
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b && (b.type === 'toolCall' || b.type === 'tool_use')) events.push({ agent: 'pi', sessionId: sid, project: proj, ts, role: 'tool', toolName: b.name || b.toolName || 'tool', detail: toolDetail(b.arguments || b.input) });
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
  const root = path.join(home(), '.codex/sessions');
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
        events.push({ agent: 'codex', sessionId: sid, project: proj, ts, role: 'tool', toolName: p.name || p.type, detail: toolDetail(p.arguments || p.input || p.action) });
      }
    });
  }
  return events;
}

function collectOpencode(o) {
  const events = [];
  const roots = ['~/.local/share/opencode/storage', '~/.opencode/storage', '~/.config/opencode/storage'].map((p) => p.replace('~', home()));
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
    for (const b of blocks) {
      if (b.type !== 'tool' && b.type !== 'tool_use') continue;
      const base = { agent: 'opencode', sessionId: m.sessionID, project: proj, ts, toolName: (b.tool && (b.tool.name || b.tool)) || 'tool' };
      events.push({ ...base, role: 'tool', detail: toolDetail(b.state && b.state.input) });
      if (b.state && b.state.status === 'error') events.push({ ...base, role: 'tool_error' });
    }
    if (m.cost != null || m.tokens) events.push({ agent: 'opencode', sessionId: m.sessionID, project: proj, ts, role: 'usage', model: m.modelID,
      input: (m.tokens && m.tokens.input) || 0, output: (m.tokens && m.tokens.output) || 0,
      cacheRead: (m.tokens && m.tokens.cache && m.tokens.cache.read) || 0, cacheWrite: (m.tokens && m.tokens.cache && m.tokens.cache.write) || 0,
      reasoning: (m.tokens && m.tokens.reasoning) || 0, cost: m.cost != null ? m.cost : null });
  }
  return events;
}

function collectContinue(o) {
  const events = [];
  const dir = path.join(home(), '.continue/sessions');
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
  const dd = path.join(home(), '.continue/dev_data');
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
  const root = path.join(home(), 'Library/Application Support/Zed/threads');
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
        if (Array.isArray(m.content)) for (const b of m.content) if (b && b.type === 'tool_use') events.push({ agent: 'zed', sessionId: id, project: proj, ts, role: 'tool', toolName: b.name, detail: toolDetail(b.input) });
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
  const db = path.join(home(), 'Library/Application Support/Cursor/User/globalStorage/state.vscdb');
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
// Claude Code — streamed, since its logs are the largest store
// ---------------------------------------------------------------------------
/** Characters of text inside a content value; images count as ~1.6k tokens. */
function textLen(v, depth = 0) {
  if (v == null || depth > 6) return 0;
  if (typeof v === 'string') return v.length;
  if (Array.isArray(v)) return v.reduce((n, x) => n + textLen(x, depth + 1), 0);
  if (typeof v === 'object') {
    if (v.type === 'image') return 6400;
    let n = 0;
    for (const [k, x] of Object.entries(v)) if (k !== 'type' && k !== 'signature' && k !== 'id' && k !== 'tool_use_id') n += textLen(x, depth + 1);
    return n;
  }
  return 0;
}

/**
 * Context sources for Claude attachments. `max` sources are re-sent snapshots (system
 * prompt, memory files): the largest one is what sits in context; the rest accumulate.
 */
const ATTACHMENT_CTX = {
  prompt_snapshot: ['system', (a) => a.systemPrompt, true],
  instructions: ['memory', (a) => (a.files || []).map((f) => f.content), true],
  skill_listing: ['skills', (a) => a.content],
  invoked_skills: ['skills', (a) => (a.skills || []).map((x) => x.content)],
  hook_additional_context: ['hooks', (a) => a.content],
  deferred_tools_delta: ['toolDefs', (a) => a.addedLines],
  agent_listing_delta: ['toolDefs', (a) => a.addedLines],
  mcp_instructions_delta: ['toolDefs', (a) => a.addedBlocks],
  file: ['files', (a) => a.content],
  edited_text_file: ['files', (a) => a.snippet],
  plan_file_reference: ['files', (a) => a.planContent],
};
const REMINDER_ATTACHMENTS = /reminder|date|environment|model|session_context|plan_mode|auto_mode|queued_command/;

/**
 * Installed skills and MCP servers announced to the model, with the characters each adds:
 * skill listings ("- name: description" lines), MCP server instructions, and deferred MCP
 * tool names (mcp__<server>__<tool>).
 */
function loadedFromAttachment(a) {
  const out = [];
  if (a.type === 'skill_listing' && typeof a.content === 'string') {
    for (const line of a.content.split(/\n(?=- )/)) {
      const m = /^- ([^\n]+?): /.exec(line); // plugin skills are "plugin:skill: description"
      if (m) out.push({ kind: 'skill', name: m[1].trim(), chars: line.length });
    }
  } else if (a.type === 'mcp_instructions_delta') {
    (a.addedNames || []).forEach((name, i) => out.push({ kind: 'mcp', name, chars: textLen((a.addedBlocks || [])[i]) }));
  } else if (a.type === 'deferred_tools_delta') {
    (a.addedNames || []).forEach((name, i) => {
      const m = /^mcp__(.+?)__/.exec(name);
      if (m) out.push({ kind: 'mcp', name: m[1], chars: textLen((a.addedLines || [])[i]) || name.length });
    });
  }
  return out;
}

/**
 * A skill's name from its base directory. Plugin skills live under
 * plugins/cache/<marketplace>/<plugin>/<version>/skills/<skill> and are named "plugin:skill",
 * matching how they are listed and invoked.
 */
function skillName(dir) {
  const parts = String(dir).trim().split(/[\\/]/).filter(Boolean);
  const skill = parts[parts.length - 1];
  const i = parts.indexOf('cache');
  return parts[i - 1] === 'plugins' && parts.length > i + 2 && parts.includes('skills') ? `${parts[i + 2]}:${skill}` : skill;
}

/**
 * One name per hook: tool hooks keep their tool ("PreToolUse:Bash"); other events group under the
 * event, since "SessionStart:startup" and "SessionStart:compact" are the same hook firing.
 */
function hookName(a) {
  const ev = a.hookEvent || String(a.hookName || 'hook').split(':')[0];
  return /ToolUse|PermissionRequest/.test(ev) && a.hookName && a.hookName.includes(':') ? a.hookName : ev;
}

/** The first few hundred characters of a tool result, for classifying why it failed. */
function firstText(content) {
  const t = typeof content === 'string' ? content : Array.isArray(content) ? content.map((b) => (b && b.text) || '').join(' ') : '';
  return t.slice(0, 300);
}

function subagentMeta(file) {
  if (!/[\\/]subagents[\\/]/.test(file)) return null;
  try { return JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch { return {}; }
}

export function claudeRoots(o = {}) {
  if (o.dirs && o.dirs.length) return o.dirs;
  const dirs = [path.join(home(), '.claude', 'projects')];
  if (o.includeTranscripts) dirs.push(path.join(home(), '.claude', 'transcripts'));
  return dirs;
}

function claudeProject(file, roots) {
  const root = roots.find((r) => file.startsWith(r)) || roots[0];
  const rel = path.relative(root, file);
  let name = rel.split(path.sep)[0];
  if (name.endsWith('.jsonl')) name = path.basename(rel, '.jsonl'); // transcripts style
  return name.replace(/^-Users-[^-]+-workspace-/, '').replace(/^-Users-[^-]+-/, '~').replace(/^ses_.*/, 'transcript');
}

/**
 * Claude Code transcripts, including subagent files (`<session>/subagents/agent-*.jsonl`).
 * Subagent records carry the parent sessionId and `isSidechain`, so their work is
 * attributed to the parent session but never counted as human prompts.
 */
export async function collectClaude(o = {}) {
  const roots = claudeRoots(o);
  const files = [];
  for (const r of roots) walkFiles(r, (n) => n.endsWith('.jsonl'), files, 200000);
  const events = [];
  const seen = new Set(); // resumed/forked sessions copy earlier records into a new file
  let parseErrors = 0;
  for (const file of files) {
    const project = claudeProject(file, roots);
    const fileSid = path.basename(file, '.jsonl');
    const meta = subagentMeta(file);
    const toolNames = new Map(); // tool_use id -> tool name, to attribute tool output
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { parseErrors++; continue; }
      if (rec.uuid) { if (seen.has(rec.uuid)) continue; seen.add(rec.uuid); }
      const ts = rec.timestamp ? Date.parse(rec.timestamp) : null;
      const base = { agent: 'claude', sessionId: rec.sessionId || fileSid, project, ts };
      if (rec.isSidechain) base.sidechain = rec.agentId || true;
      if (meta && meta.agentType) base.agentType = meta.agentType;
      const ctx = (cat, v, extra) => { const chars = textLen(v); if (chars) events.push({ ...base, role: 'ctx', cat, chars, ...extra }); };
      if (rec.cwd) base.cwd = rec.cwd;
      if (rec.gitBranch) base.branch = rec.gitBranch;

      if (rec.type === 'user') {
        const content = rec.message && rec.message.content;
        let text = null;
        if (typeof content === 'string') text = content;
        else if (Array.isArray(content)) {
          for (const b of content) {
            if (!b || b.type !== 'tool_result') continue;
            const tool = toolNames.get(b.tool_use_id) || 'tool';
            ctx('toolOutput', b.content, { tool });
            if (b.is_error) events.push({ ...base, role: 'tool_error', toolName: tool, text: firstText(b.content) });
          }
          const block = content.find((b) => b && b.type === 'text');
          if (block && !rec.isMeta) text = block.text;
          // skill instructions arrive as meta records: count the load, never a prompt
          const meta = rec.isMeta && block && typeof block.text === 'string' && block.text.match(/Base directory for this skill:\s*([^\n]+)/);
          if (meta) { events.push({ ...base, role: 'skill', text: skillName(meta[1]), via: 'load', chars: block.text.length }); ctx('skills', block.text); continue; }
        }
        const t = text && text.trim();
        if (!t) continue;
        const cm = t.match(/<command-name>([^<]+)<\/command-name>/);
        if (cm) { events.push({ ...base, role: 'command', text: cm[1] }); continue; }
        const sk = t.match(/Base directory for this skill:\s*([^\n]+)/);
        if (sk) { const name = skillName(sk[1]); events.push({ ...base, role: 'skill', text: name, via: 'load', chars: t.length }); ctx('skills', t); continue; }
        if (/^\[Request interrupted/.test(t)) { events.push({ ...base, role: 'interrupt' }); continue; }
        events.push({ ...base, role: 'user', text: t, src: rec.promptSource || (rec.isSidechain ? 'subagent' : 'typed') });
        ctx(NOISE.some((re) => re.test(t)) ? 'reminders' : 'userText', t);
      } else if (rec.type === 'assistant' && rec.message) {
        const m = rec.message;
        events.push({ ...base, role: 'assistant', model: m.model });
        const u = m.usage;
        if (u) events.push({ ...base, role: 'usage', model: m.model,
          input: u.input_tokens || 0, output: u.output_tokens || 0,
          cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0,
          reasoning: (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0 });
        if (Array.isArray(m.content)) for (const b of m.content) {
          if (!b) continue;
          if (b.type === 'thinking') { ctx('reasoning', b.thinking); continue; }
          if (b.type === 'text') { ctx('assistantText', b.text); continue; }
          if (b.type !== 'tool_use') continue;
          if (b.id) toolNames.set(b.id, b.name);
          ctx('toolInput', b.input);
          events.push({ ...base, role: 'tool', toolName: b.name, detail: toolDetail(b.input) });
          if (b.name === 'Skill' && b.input && b.input.skill) events.push({ ...base, role: 'skill', text: b.input.skill, via: 'tool' });
        }
      } else if (rec.type === 'attachment' && rec.attachment) {
        const a = rec.attachment; const known = ATTACHMENT_CTX[a.type];
        for (const l of loadedFromAttachment(a)) events.push({ ...base, role: 'loaded', ...l });
        if (/^hook_/.test(a.type || '')) events.push({ ...base, role: 'hook', event: a.hookEvent || null, name: hookName(a),
          command: a.command ? String(a.command).slice(0, 200) : null, ms: a.durationMs != null ? a.durationMs : null,
          failed: a.exitCode != null ? a.exitCode !== 0 : /error|fail/.test(a.type), chars: a.type === 'hook_additional_context' ? textLen(a.content) : 0 });
        if (known) ctx(known[0], known[1](a), known[2] ? { max: true } : undefined);
        else if (REMINDER_ATTACHMENTS.test(a.type || '')) ctx('reminders', a.text != null ? a.text : a.content);
      } else if (rec.type === 'system' && rec.subtype === 'compact_boundary') {
        const cm = rec.compactMetadata || {};
        events.push({ ...base, role: 'compact', trigger: cm.trigger || null, preTokens: cm.preTokens || 0 });
      } else if (rec.type === 'system' && rec.subtype === 'api_error') {
        events.push({ ...base, role: 'api_error' });
      } else if (rec.type === 'cost-state' && rec.totalCostUSD != null) {
        events.push({ ...base, role: 'cost', usd: rec.totalCostUSD, modelUsage: rec.modelUsage || null });
      } else if ((rec.type === 'custom-title' && rec.customTitle) || (rec.type === 'ai-title' && rec.aiTitle)) {
        events.push({ ...base, role: 'title', text: rec.customTitle || rec.aiTitle, custom: rec.type === 'custom-title' });
      }
    }
  }
  return { events, files, parseErrors };
}

// ---------------------------------------------------------------------------
// One event stream for every selected agent, with shared filters applied
// ---------------------------------------------------------------------------
/**
 * Load normalized events. Default is Claude only; `o.allAgents` adds every parsable
 * agent, `o.agent` restricts to one. `o.days` / `o.project` filter every agent alike.
 * Returns { events, files, parseErrors } — `files` lists transcript sources (paths for
 * Claude, `agent:session` ids for stores without one-file-per-session).
 */
export async function loadEvents(o = {}) {
  const ids = o.agent ? [o.agent] : (o.allAgents ? ['claude', ...PARSABLE] : ['claude']);
  const cutoff = o.days ? Date.now() - o.days * 864e5 : null;
  const keep = (e) => (!cutoff || !e.ts || e.ts >= cutoff) && (!o.project || (e.project && e.project.includes(o.project)));
  const events = []; const files = []; let parseErrors = 0;
  for (const id of ids) {
    let ev = [];
    if (id === 'claude') {
      const r = await collectClaude(o);
      ev = r.events; files.push(...r.files); parseErrors += r.parseErrors;
    } else {
      if (!ADAPTERS[id]) continue;
      try { ev = ADAPTERS[id](o) || []; } catch (err) { if (o.errors) console.error(`[agents] ${id}: ${err.message}`); }
      if (!ev.length) {
        ev = collectGeneric(id, o);
        if (ev.length && o.errors) console.error(`[agents] ${id}: precise adapter empty; shape-based fallback recovered ${ev.length} events`);
      }
      files.push(...new Set(ev.map((e) => `${id}:${e.sessionId}`)));
    }
    for (const e of ev) if (keep(e)) events.push(e);
  }
  return { events, files, parseErrors };
}

/** Flatten events into the aggregate arrays `analyze()` consumes. */
export function eventsToData(events, o = {}) {
  const prompts = [], tools = [], titles = [], usage = [], costs = [];
  const models = {}, sources = {}, skills = {}, commands = {};
  let totalUser = 0, totalAssistant = 0, interruptions = 0;
  const inc = (m, k) => { m[k] = (m[k] || 0) + 1; };

  for (const e of events) {
    const { agent, sessionId } = e;
    const proj = e.project || agent;
    switch (e.role) {
      case 'title': titles.push({ proj, ts: e.ts, t: e.text, agent }); break;
      case 'usage': usage.push({ agent, sessionId, proj, ts: e.ts, model: e.model, input: e.input || 0, output: e.output || 0, cacheRead: e.cacheRead || 0, cacheWrite: e.cacheWrite || 0, reasoning: e.reasoning || 0, ctx: e.ctx || 0, cost: e.cost != null ? e.cost : null, cumulative: !!e.cumulative }); break;
      case 'cost': costs.push({ agent, sessionId, usd: e.usd, modelUsage: e.modelUsage, ts: e.ts }); break;
      case 'skill': inc(skills, e.text || e.toolName || 'skill'); break;
      case 'command': inc(commands, e.text); break;
      case 'interrupt': interruptions++; break;
      case 'tool': tools.push({ proj, ts: e.ts, name: e.toolName || 'tool', agent, sessionId }); break;
      case 'assistant': totalAssistant++; if (e.model) inc(models, e.model); break;
      case 'user': {
        if (e.sidechain) break; // subagent prompt, not a human turn
        totalUser++;
        if (e.src && !o.allSources && !HUMAN_SRC.includes(e.src)) break;
        const c = classify(e.text); if (!c) break;
        inc(sources, e.src ? e.src : `${agent}:log`);
        prompts.push({ proj, ts: e.ts, text: c.text, len: c.text.length, src: e.src || 'log', template: c.template, agent, sessionId });
        break;
      }
      default: break;
    }
  }
  return { prompts, tools, titles, models, sources, usage, costs, skills, commands, totalUser, totalAssistant, interruptions };
}

// ---------------------------------------------------------------------------
// scan — discovery only, no parsing
// ---------------------------------------------------------------------------
export function scanStores() {
  return STORES.map((s) => {
    const found = s.paths.map((p) => p.replace('~', home())).filter((p) => fs.existsSync(p));
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
