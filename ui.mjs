#!/usr/bin/env node
/**
 * cc-habits UI — a local web dashboard for the habits analyzer.
 *
 * Started via `cc-habits --ui` (or `node ui.mjs`). Serves a self-contained page at
 * http://127.0.0.1:<port>/ and JSON at /api/data and /api/meta.
 *
 * No external assets, no network access beyond localhost.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { loadAll, loadRecords, loadHistory, analyze } from './habits.mjs';
import { PARSABLE } from './agents.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(__dirname, 'ui', 'index.html');
const cache = new Map();

function queryOpts(q) {
  return {
    dirs: [], project: q.project || null, days: q.days ? Number(q.days) : null,
    top: q.top ? Number(q.top) : 15, tz: q.tz != null && q.tz !== '' ? Number(q.tz) : null,
    includeTranscripts: q.transcripts === '1', history: q.history !== '0',
    allSources: q.all === '1', errors: false, format: 'json',
    allAgents: q.agents === '1', agent: q.agent || null,
  };
}

async function build(q) {
  const key = JSON.stringify(q);
  if (cache.has(key)) return cache.get(key);
  const o = queryOpts(q);
  const data = await loadAll(o);
  const hist = loadHistory(o);
  const analysis = analyze(data, o);
  const result = { ...analysis, cliHistory: o.history ? hist : null };
  if (cache.size > 32) cache.clear();
  cache.set(key, result);
  return result;
}

async function meta() {
  const key = '__meta__';
  if (cache.has(key)) return cache.get(key);
  const o = queryOpts({});
  const data = await loadRecords(o);
  const analysis = analyze(data, o);
  const result = {
    projects: Object.keys(analysis.projects).sort(),
    agents: ['claude', ...PARSABLE],
    files: data.files.length,
    first: analysis.scope.first,
    last: analysis.scope.last,
    transcripts: fs.existsSync(path.join(process.env.HOME || '', '.claude', 'transcripts')),
  };
  cache.set(key, result);
  return result;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

export function startUi(o = {}) {
  const port = o.port || 4173;
  const host = '127.0.0.1';

  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${host}:${port}`);
      try {
        if (url.pathname === '/' || url.pathname === '/index.html') {
          const html = fs.readFileSync(HTML_PATH);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(html);
          return;
        }
        if (url.pathname === '/api/meta') return sendJson(res, 200, await meta());
        if (url.pathname === '/api/data') {
          const q = Object.fromEntries(url.searchParams.entries());
          return sendJson(res, 200, await build(q));
        }
        sendJson(res, 404, { error: 'not found' });
      } catch (err) {
        sendJson(res, 500, { error: String(err && err.message || err) });
      }
    });

    server.listen(port, host, () => {
      const link = `http://${host}:${port}/`;
      console.log(`cc-habits UI  →  ${link}`);
      console.log('Press Ctrl-C to stop.');
      if (o.open && process.platform === 'darwin') exec(`open ${link}`);
      else if (o.open && process.platform === 'linux') exec(`xdg-open ${link}`);
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
