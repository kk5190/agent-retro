#!/usr/bin/env node
/**
 * agent-retro UI — the local dashboard.
 *
 * Started via `agent-retro --ui` (or `node ui.mjs`). Serves a self-contained page at
 * http://127.0.0.1:<port>/ and JSON at /api/data (rollup), /api/sessions (session
 * records, `?task=` to filter) and /api/meta. POST /api/reload drops cached results; POST
 * /api/label { sessionId, task } corrects a session's task label; POST /api/retro/save saves the
 * current retro for the next one to review; POST /api/config/cycle { cycle: { start, days } | null }
 * sets the review cycle, or null for calendar months (all same-origin JSON only).
 *
 * No external assets, no network access beyond localhost.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { loadTelemetry, loadHistory, writeLabel, saveRetro, writeCycleConfig, retroMd, CONTEXT_LABELS } from './agent-retro.mjs';
import { TASKS } from './sessions.mjs';
import { PARSABLE } from './agents.mjs';
import { sessionView } from './telemetry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, 'ui', 'index.html');
const cache = new Map();

/** Options the dashboard was started with (--dir, --tz, --cycle-start, …): the base every query starts from. */
let launch = {};

/** A page query on top of the launch options: the page's filters win where it sets them. */
function queryOpts(q) {
  const has = (k) => q[k] != null && q[k] !== '';
  return {
    dirs: launch.dirs || [], project: q.project || null, days: has('days') ? Number(q.days) : launch.days || null,
    top: q.top ? Number(q.top) : 15, tz: has('tz') ? Number(q.tz) : launch.tz ?? null,
    includeTranscripts: q.transcripts === '1' || (!has('transcripts') && !!launch.includeTranscripts), history: q.history !== '0' && launch.history !== false,
    allSources: q.all === '1' || (!has('all') && !!launch.allSources), errors: false, format: 'json',
    allAgents: q.agents === '1', agent: q.agent || null,
    scope: ['current', 'last'].includes(q.scope) ? q.scope : null,
    periodPick: q.period || null, cycleStart: launch.cycleStart || null, cycleDays: launch.cycleDays || null,
  };
}

/** The page shows command counts only; the typed lines themselves never leave the process. */
const historySummary = (h) => ({ commands: h.commands, typed: h.typed });

/** Rollup + sessions for one filter combination, parsed once and cached. */
async function build(q) {
  const { task, ...filters } = q;
  const key = JSON.stringify(filters);
  if (cache.has(key)) return cache.get(key);
  const o = queryOpts(filters);
  const { analysis, sessions } = await loadTelemetry(o);
  const result = { analysis: { ...analysis, cliHistory: o.history ? historySummary(loadHistory(o)) : null }, sessions };
  if (cache.size > 32) cache.clear();
  cache.set(key, result);
  return result;
}

async function meta() {
  const { analysis } = await build({});
  return {
    projects: Object.keys(analysis.projects).sort(),
    agents: ['claude', ...PARSABLE],
    contextLabels: CONTEXT_LABELS,
    defaults: { agents: launch.agent ? launch.agent : launch.allAgents ? 'all' : '', days: launch.days ? String(launch.days) : '', transcripts: !!launch.includeTranscripts, all: !!launch.allSources },
    tasks: [...TASKS.map((t) => ({ id: t.id, label: t.label })), { id: 'other', label: 'Other' }],
    files: analysis.scope.files,
    first: analysis.scope.first,
    last: analysis.scope.last,
    transcripts: fs.existsSync(path.join(process.env.AGENT_RETRO_HOME || process.env.HOME || '', '.claude', 'transcripts')),
  };
}

const ALLOWED_HOSTS = (port) => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

/** Writes only from the dashboard itself: same origin, JSON body (so other sites cannot post here). */
function sameOrigin(req, host, port) {
  const origin = req.headers.origin;
  return (!origin || origin === `http://${host}:${port}` || origin === `http://localhost:${port}`) && /^application\/json\b/.test(req.headers['content-type'] || '');
}
function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > limit) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('body is not JSON')); } });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

export function startUi(o = {}) {
  launch = o;
  const port = o.port || 4173;
  const host = '127.0.0.1';

  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${host}:${port}`);
      // DNS rebinding: a hostile site can resolve its own name to 127.0.0.1, so only answer requests addressed to us
      if (!ALLOWED_HOSTS(port).has(String(req.headers.host || '').toLowerCase())) return sendJson(res, 421, { error: 'unexpected Host header' });
      try {
        if (url.pathname === '/' || url.pathname === '/index.html') {
          const html = fs.readFileSync(HTML_PATH);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(html);
          return;
        }
        if (url.pathname === '/api/meta') return sendJson(res, 200, await meta());
        const q = Object.fromEntries(url.searchParams.entries());
        if (req.method === 'POST' && !sameOrigin(req, host, port)) return sendJson(res, 403, { error: 'writes are only accepted from the dashboard itself' });
        if (url.pathname === '/api/reload' && req.method === 'POST') { cache.clear(); return sendJson(res, 200, { ok: true }); }
        if (url.pathname === '/api/retro/save' && req.method === 'POST') {
          const { analysis } = await build(q);
          const file = saveRetro(analysis.retro);
          cache.clear();
          return sendJson(res, 200, { ok: true, file });
        }
        if (url.pathname === '/api/config/cycle' && req.method === 'POST') {
          const { cycle } = await readBody(req);
          try { writeCycleConfig(cycle || null); } catch (err) { return sendJson(res, 400, { error: err.message }); }
          launch = { ...launch, cycleStart: null, cycleDays: null }; // the saved setting now wins over launch flags
          cache.clear();
          return sendJson(res, 200, { ok: true });
        }
        if (url.pathname === '/api/label' && req.method === 'POST') {
          const { sessionId, task } = await readBody(req);
          try { writeLabel(sessionId, task || null); } catch (err) { return sendJson(res, 400, { error: err.message }); }
          cache.clear();
          return sendJson(res, 200, { ok: true });
        }
        if (url.pathname === '/api/data') return sendJson(res, 200, (await build(q)).analysis);
        if (url.pathname === '/api/retro.md') {
          const md = retroMd((await build(q)).analysis.retro).join('\n') + '\n';
          res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(md);
        }
        if (url.pathname === '/api/sessions') {
          const { sessions } = await build(q);
          const list = q.task ? sessions.filter((s) => s.task.primary === q.task) : sessions;
          return sendJson(res, 200, { total: list.length, sessions: list.slice(0, 500).map((s) => sessionView(s, o.text || 'excerpts')) });
        }
        sendJson(res, 404, { error: 'not found' });
      } catch (err) {
        sendJson(res, 500, { error: String(err && err.message || err) });
      }
    });

    server.listen(port, host, () => {
      const link = `http://${host}:${port}/`;
      console.log(`agent-retro UI  →  ${link}`);
      console.log('Press Ctrl-C to stop.');
      if (o.open) exec(process.platform === 'darwin' ? `open ${link}` : process.platform === 'win32' ? `start "" "${link}"` : `xdg-open ${link}`);
    });

    const shutdown = () => { server.close(() => resolve()); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

// Allow `node ui.mjs` directly (resolves symlinks too).
let isDirect = false;
try { isDirect = !!process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { /* ignore */ }
if (isDirect) {
  const portArg = process.argv.indexOf('--port');
  startUi({ port: portArg > -1 ? Number(process.argv[portArg + 1]) : 4173, open: process.argv.includes('--open') });
}
