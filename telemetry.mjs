/**
 * telemetry.mjs — the agent-facing contract.
 *
 * Turns in-memory analysis + SessionRecords into the versioned, redacted shapes that
 * leave this process: the export bundle (`telemetry.json` + `sessions.jsonl`), the
 * MCP server responses, and `/api/sessions`. Schema: schema/telemetry.schema.json.
 *
 * Text levels:
 *   none      numbers and labels only; no prompt text, titles, or example prompts;
 *             project names and uncommon command names become stable pseudonyms
 *   excerpts  + session title and the first few prompts, truncated (default)
 *   full      + every human prompt, untruncated
 * Every level runs text through redact().
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const SCHEMA_VERSION = 1;
export const TEXT_LEVELS = ['none', 'excerpts', 'full'];
const EXCERPTS = 3;
const EXCERPT_LEN = 200;

export function generator() {
  try {
    const { name, version } = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
    return { name, version };
  } catch { return { name: 'agent-retro', version: '0.0.0' }; } // unpackaged checkout
}

// ---------------------------------------------------------------------------
// Redaction — applied to every string that leaves the process
// ---------------------------------------------------------------------------
const REDACTIONS = [
  [/\b([A-Za-z0-9_]*(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|auth)[A-Za-z0-9_]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1$2[REDACTED]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[REDACTED]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '[REDACTED]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL]'],
  [/(?:\/Users|\/home)\/[^/\s'"]+/g, '~'],
  [/[A-Za-z]:\\Users\\[^\\\s'"]+/g, '~'],
  [/\b[A-Fa-f0-9]{32,}\b/g, '[HEX]'],
  [/(?<![\w/.-])(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[A-Za-z])[A-Za-z0-9+_-]{40,}={0,2}/g, '[BLOB]'],
];

export function redact(text) {
  if (text == null) return text;
  let s = String(text);
  for (const [re, rep] of REDACTIONS) s = s.replace(re, rep);
  return s;
}

// ---------------------------------------------------------------------------
// Pseudonyms (level none): stable within and across exports, so grouping still works
// ---------------------------------------------------------------------------
const pseudo = (prefix, v) => `${prefix}-${crypto.createHash('sha256').update(String(v)).digest('hex').slice(0, 6)}`;
const KNOWN_CMD = new Set(('git gh npm pnpm yarn bun npx node deno python pip pip3 uv poetry cargo rustc go make cmake docker kubectl helm terraform aws gcloud az '
  + 'vercel netlify wrangler flyctl brew apt ls cat head tail sed awk grep rg find fd tree wc sort uniq cut tr xargs jq yq curl wget ssh scp rsync '
  + 'cp mv rm mkdir rmdir touch chmod chown ln echo printf test tee diff difft patch tar zip unzip gzip open which env ps kill pkill lsof du df '
  + 'sqlite3 psql mysql redis-cli pytest jest vitest mocha playwright tsc eslint prettier biome ruff black mypy rspec phpunit dotnet mvn gradle java '
  + 'swift xcodebuild xcrun flutter dart ruby bundle rails php composer lighthouse hyperfine time sleep true date basename dirname realpath stat file '
  + 'claude codex gemini').split(/\s+/));
const projectName = (p, level) => (level === 'none' && p ? pseudo('project', p) : p);
const commandName = (c, level) => {
  const r = redact(c);
  if (level !== 'none') return r;
  const bin = r.split(' ')[0];
  return KNOWN_CMD.has(bin) || /^python -m /.test(r) ? r : pseudo('cmd', r);
};
const mapKeys = (m, f) => {
  const out = {};
  for (const [k, v] of Object.entries(m || {})) { const nk = f(k); out[nk] = (out[nk] || 0) + v; }
  return out;
};

const clip = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
function checkLevel(level) {
  if (!TEXT_LEVELS.includes(level)) throw new Error(`--text must be one of ${TEXT_LEVELS.join(' | ')} (got ${level})`);
  return level;
}

/** Exported shape of one SessionRecord. Strips internal `_` fields. */
export function sessionView(s, level = 'excerpts') {
  checkLevel(level);
  const out = {};
  for (const [k, v] of Object.entries(s)) if (!k.startsWith('_')) out[k] = v;
  out.start = s.start ? new Date(s.start).toISOString() : null;
  out.end = s.end ? new Date(s.end).toISOString() : null;
  out.project = projectName(s.project, level);
  out.tools = { ...s.tools, shell: mapKeys(s.tools.shell, (c) => commandName(c, level)) };
  out.branch = !s.branch ? null : level === 'none' ? pseudo('branch', s.branch) : redact(s.branch);
  out.title = level === 'none' || !s.title ? null : redact(s.title);
  out.text = level === 'none' ? { level }
    : level === 'excerpts' ? { level, prompts: s._prompts.slice(0, EXCERPTS).map((t) => clip(redact(t), EXCERPT_LEN)) }
      : { level, prompts: s._prompts.map(redact) };
  return out;
}

/** Exported shape of the rollup. Raw-text fields are redacted, or dropped at level none. */
export function rollupView(a, level = 'excerpts') {
  checkLevel(level);
  const none = level === 'none';
  const r = { ...a };
  delete r.generatedAt;
  r.repeated = none ? [] : a.repeated.map(([k, v]) => [redact(k), v]);
  r.tasks = Object.fromEntries(Object.entries(a.tasks || {}).map(([k, t]) => [k, { ...t, topShell: t.topShell.map(([c, n]) => [commandName(c, level), n]) }]));
  if (a.extensions) r.extensions = { ...a.extensions, hooks: a.extensions.hooks.map((h) => ({ ...h, commands: none ? [] : h.commands.map(redact) })) };
  if (a.prompting) r.prompting = { ...a.prompting, vagueExamples: none ? [] : a.prompting.vagueExamples.map((v) => ({ ...v, text: redact(v.text) })) };
  r.workflows = (a.workflows || []).map((w) => ({ ...w, steps: w.steps.map((c) => commandName(c, level)) }));
  r.projects = mapKeys(a.projects, (p) => projectName(p, level));
  r.sessions = { ...a.sessions, longest: a.sessions.longest.map((x) => ({ ...x, proj: projectName(x.proj, level) })) };
  r.recommendations = (a.recommendations || []).map((x) => {
    if (none && x.personal) { const { evidence, fix, ...rest } = x; return rest; }
    return { ...x, evidence: redact(x.evidence), ...(x.fix && { fix: { ...x.fix, content: redact(x.fix.content) } }) };
  });
  if (a.cliHistory) r.cliHistory = { commands: a.cliHistory.commands, typed: a.cliHistory.typed };
  return r;
}

export function buildBundle({ analysis, sessions }, o = {}) {
  const level = checkLevel(o.text || 'excerpts');
  return {
    telemetry: {
      schemaVersion: SCHEMA_VERSION,
      generator: generator(),
      generatedAt: analysis.generatedAt,
      textLevel: level,
      filters: { days: o.days || null, project: o.project ? projectName(o.project, level) : null, agent: o.agent || null, allAgents: !!o.allAgents },
      rollup: rollupView(analysis, level),
    },
    sessions: sessions.map((s) => sessionView(s, level)),
  };
}

/** Write telemetry.json + sessions.jsonl into dir. Returns the written paths. */
export function writeExport(dir, bundle) {
  fs.mkdirSync(dir, { recursive: true });
  const tFile = path.join(dir, 'telemetry.json');
  const sFile = path.join(dir, 'sessions.jsonl');
  fs.writeFileSync(tFile, JSON.stringify(bundle.telemetry, null, 2) + '\n');
  fs.writeFileSync(sFile, bundle.sessions.map((s) => JSON.stringify(s)).join('\n') + (bundle.sessions.length ? '\n' : ''));
  return [tFile, sFile];
}
