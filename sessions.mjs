/**
 * sessions.mjs — per-session telemetry and heuristic task labelling.
 *
 * buildSessions(events) folds the normalized event stream (see agents.mjs) into one
 * SessionRecord per `agent:sessionId`: turns, tools, files, skills, tokens, cost, and
 * efficiency signals. labelTask() scores each session against the TASKS table.
 *
 * Human prompt texts are kept on the record as `_prompts` (and subagent prompts as
 * `_subPrompts`); fields starting with `_` are internal and never exported as-is —
 * telemetry.mjs decides what text leaves the machine.
 */
import path from 'node:path';
import { classify, HUMAN_SRC } from './agents.mjs';

// ---------------------------------------------------------------------------
// Task taxonomy. One row per task; each channel is a regex tested against:
//   p   human prompts (first prompt counts double, subagent prompts count half)
//   sh  shell commands run in the session
//   sk  skills and slash commands
//   t   tool names and subagent types
//   f   edited file paths
// Add a task by adding a row.
// ---------------------------------------------------------------------------
const TEST_CMD = /\b(npm|pnpm|yarn|bun) (run )?test\b|\b(jest|vitest|pytest|mocha|rspec|phpunit|playwright test|go test|cargo test|node --test|deno test|dotnet test|mvn test|gradle test)\b/i;
const SENSITIVE = /(^|[\s/'"=])\.env(\.[\w-]+)?\b|id_(rsa|ed25519|ecdsa)\b|\.(pem|p12|pfx|key)\b|\.aws\/credentials|\.ssh\/|\.netrc|\.npmrc|credentials\.json|secrets?\.(json|ya?ml|toml)|\.kube\/config/i;
const DESTRUCTIVE = /git push\b[^\n;&|]*\s(--force(-with-lease)?|-f)\b|git reset --hard|git clean -[a-z]*f|git checkout -- \.|\bdrop (table|database|schema)\b|chmod -R 777|\bmkfs\b|\bdd if=/i;
const RM_RF = /\brm\s+-[a-z]*(?:rf|fr)[a-z]*\s+([^;&|\n]+)/gi;
const DISPOSABLE = /^['"]?(\.\/)?([\w.-]+\/)*(node_modules|dist|build|out|\.next|\.nuxt|\.svelte-kit|coverage|\.cache|\.turbo|\.parcel-cache|target|__pycache__|\.pytest_cache|tmp|temp)\/?['"]?$|^['"]?(\/tmp|\/private\/tmp|\/var\/folders|\$TMPDIR|\$\{?TMPDIR)/;

/** The part of a shell command that is command, not payload: drops heredoc bodies and long inline scripts. */
function commandText(cmd) {
  return String(cmd)
    .replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?(\n\1\b|$)/g, '<<$1')
    .replace(/(['"])(?:(?!\1)[\s\S]){120,}?(\1|$)/g, '$1…$1');
}

/** Irreversible shell operations; `rm -rf` of build output, caches and temp dirs is routine. */
export function isDestructive(cmd) {
  const c = commandText(cmd);
  if (DESTRUCTIVE.test(c)) return true;
  for (const m of c.matchAll(RM_RF)) if (m[1].trim().split(/\s+/).some((t) => t && !t.startsWith('-') && !DISPOSABLE.test(t))) return true;
  return false;
}

export const isSensitive = (detail) => SENSITIVE.test(commandText(detail));

/**
 * Why a tool call failed, from the start of its error message. Order matters: specific causes
 * first, a bare non-zero exit last. `rejected` (you declined) and `blocked` (a guard or policy
 * stopped it) are not failures of the tool and are counted separately.
 */
const ERROR_CLASSES = [
  ['rejected', /user doesn.?t want to proceed|user (rejected|declined)|denied by (the )?user/i],
  ['blocked', /\bis blocked\b|blocked by|not allowed by (the )?(policy|permission)|permission (for|to use) .{0,200}?(was |has been )?denied|denied by the claude code|only ever publishes/i],
  ['service', /temporarily unavailable|overloaded|rate.?limit|session limit|usage limit/i],
  ['timeout', /timed? ?out|did not respond in time|still loading/i],
  ['environment', /is in use|already in use|not installed|exited during startup|failed to start|command not found|extension disconnected/i],
  ['stale-file', /modified since read|has not been read|read it first/i],
  ['invalid-input', /validation|invalid (argument|input|param)|requires a prior|call \w+ first|not initialized|syntaxerror|unknown (option|argument)|missing required|region exceeds|cannot exceed|typeerror/i],
  ['not-found', /does not exist|no such file|not found|enoent|no longer exists|no tab group|is open\b|no longer open|not a web page|unparseable url|no [\w.]+ found|cannot find|could ?n.?t determine which page/i],
  ['permission', /eperm|eacces|permission denied|not permitted/i],
  ['command-failed', /^\s*exit code [1-9]/i],
];
/** `unfinished`: a call that never got a result (the session crashed, was killed or lost it). */
export const ERROR_CLASS_IDS = [...ERROR_CLASSES.map(([c]) => c), 'unfinished', 'other', 'unknown'];
export function errorClass(text) {
  if (!text) return 'unknown';
  for (const [c, re] of ERROR_CLASSES) if (re.test(text)) return c;
  return 'other';
}
const NOT_FAILURES = new Set(['rejected', 'blocked']);
const REWORK_EDITS = 5; // one file edited this many times in a session is going in circles
const AWAY_MS = 30 * 60000; // a gap longer than this before your next prompt counts as away, not waiting

export const CONTEXT_SOURCES = ['system', 'memory', 'toolDefs', 'skills', 'hooks', 'reminders', 'userText', 'files', 'toolInput', 'toolOutput', 'reasoning', 'assistantText'];
const HIGH_CONTEXT = 150000;
const TEST_FILE = /(\.|_)(test|spec)\.[a-z]+$|__tests__\/|(^|\/)tests?\//i;
const DOC_FILE = /\.(md|mdx|rst|txt)$/i;

export const TASKS = [
  { id: 'code-review', label: 'Code review',
    p: /code review|review (this|the|my|a|our)? ?(diff|pr|pull request|branch|changes|implementation|code|commit)|\bpr #?\d+|re-?review|reviewer|\blgtm\b|nitpick/i,
    sh: /\bgh pr (view|diff|review|checks|checkout)\b|\bgit (diff|show)\b|\bdifft\b/i,
    sk: /review/i, t: /review/i },
  { id: 'debugging', label: 'Debugging',
    p: /\bbugs?\b|\berror\b|broken|not work|doesn.?t work|\bfail(s|ed|ing|ure)?\b|crash|debug|traceback|stack ?trace|exception|regression|why (is|does|did|isn.?t|doesn.?t)|\bfix\b/i,
    sk: /debug|diagnos/i, t: /debug/i },
  { id: 'testing', label: 'Testing',
    p: /\btests?\b|\btdd\b|coverage|unit test|e2e|playwright|jest|vitest|pytest/i,
    sh: TEST_CMD, sk: /tdd|test/i, f: TEST_FILE },
  { id: 'feature', label: 'Feature work',
    p: /\b(implement|build|create|add|scaffold|wire up|new feature|support for)\b/i,
    sk: /executing-plans|subagent-driven|implement/i },
  { id: 'refactor', label: 'Refactor',
    p: /refactor|clean ?up|simplif|rename|restructure|extract|dedupe|consolidat|dead code/i,
    sk: /simplify|refactor/i },
  { id: 'planning', label: 'Planning & design',
    p: /\bplan\b|\bspec\b|\bprd\b|brainstorm|architect|design doc|approach|roadmap|trade-?offs?|how should|what.s the best/i,
    sk: /brainstorm|plan|spec|grill/i, t: /^(EnterPlanMode|ExitPlanMode)$|^Plan\b/ },
  { id: 'ui-design', label: 'UI & visual design',
    p: /\bui\b|\bux\b|layout|\bcss\b|tailwind|styling|aesthetic|animation|responsive|typograph|colou?r|landing page|beautiful|polish|redesign|reimagine|website|\bdesign\b(?! doc)|visual|minimal/i,
    sk: /design|frontend|gsap/i, t: /chrome|browser|screenshot|preview/i, f: /\.(css|scss|html|vue|svelte)$/i },
  { id: 'performance', label: 'Performance',
    p: /performance|\bperf\b|\bslow\b|latency|bundle size|lighthouse|core web vitals|profil(e|ing)\b|optimi[sz]e|memory leak|first paint/i,
    sh: /\b(lighthouse|hyperfine|clinic|0x|perf|py-spy|pprof)\b|--profile|--inspect/i, sk: /perf/i },
  { id: 'docs', label: 'Docs & writing',
    p: /readme|\bdocs?\b|documentation|changelog|write-?up|blog post/i, f: DOC_FILE },
  { id: 'git-ops', label: 'Git & PR ops',
    p: /\bcommit\b|\bpush\b|rebase|merge conflict|cherry-pick|open a pr|create (a )?pr/i,
    sh: /\bgit (commit|push|rebase|merge|cherry-pick|stash|reset)\b|\bgh pr create\b/i,
    sk: /commit|merge|worktree|finishing/i },
  { id: 'deploy-ops', label: 'Deploy & infra',
    p: /deploy|vercel|netlify|docker|kubernetes|\bk8s\b|\bci\b|pipeline|github actions|production|release|hosting/i,
    sh: /\b(docker|kubectl|vercel|netlify|terraform|helm|flyctl|railway|wrangler|aws|gcloud)\b/i },
  { id: 'research', label: 'Research & explain',
    p: /\b(explain|what is|how does|how do|why does|compare|research|investigate|understand|look up|find out)\b/i,
    t: /^(WebSearch|WebFetch)$|explore|research/i, sk: /research/i },
  { id: 'agent-setup', label: 'Agent setup',
    p: /claude\.md|agents\.md|\bmcp\b|\bskills?\b|subagent|\bhooks?\b|settings\.json|slash command|\bplugins?\b/i,
    sk: /skill-creator|writing-skills|update-config|^init$|automation/i, f: /(CLAUDE|AGENTS)\.md$|\.claude\/|SKILL\.md$/ },
];
const CHANNEL_WEIGHT = { p: 2, sh: 1.2, sk: 2.5, t: 1, f: 1 };
export const TASK_IDS = [...TASKS.map((t) => t.id), 'other'];

// ---------------------------------------------------------------------------
// Tool and command normalization
// ---------------------------------------------------------------------------
export function toolBucket(name) {
  if (/bash|shell|exec|terminal|command|\brun\b|run_/i.test(name)) return 'shell';
  if (/browser|chrome|computer|navigate|preview|tabs_|page|screenshot/i.test(name)) return 'browser';
  if (/edit|write|patch|apply|str_replace|create_file|insert|replace/i.test(name)) return 'edit';
  if (/read|view|glob|grep|search|list_?files|\bls\b|\bcat\b/i.test(name)) return 'read';
  if (/agent|task|skill|todo|plan|subagent|monitor|send_message/i.test(name)) return 'agent';
  if (/web|fetch|http|url/i.test(name)) return 'web';
  return 'other';
}

const MULTI = /^(git|gh|npm|pnpm|yarn|bun|cargo|go|docker|kubectl|uv|pip|pip3|poetry|make|terraform|aws|gcloud|vercel|netlify|brew|deno|dotnet|mvn|gradle|helm|flyctl|wrangler)$/;
const SKIP_SEG = /^(cd|export|source|set|echo|sleep|true|false|printf)\b/;

/** Normalize a shell command to its head: `git diff`, `npm run build`, `pytest`. */
export function commandHead(cmd) {
  if (!cmd) return null;
  const s = String(cmd).replace(/^\s*(bash|zsh|sh)\s+-l?c\s+/, '').replace(/^['"]|['"]$/g, '');
  const segs = s.split(/&&|\|\||;|\||\n/).map((x) => x.trim()).filter(Boolean);
  const seg = segs.find((x) => !SKIP_SEG.test(x)) || '';
  const words = seg.replace(/^(\w+=\S*\s+)+/, '').replace(/^((sudo|time|rtk|npx|bunx|uvx|command)\s+)+/, '').split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const w0 = path.basename(words[0]).replace(/[^\w.+-]/g, '');
  if (!w0) return null;
  const w1 = words[1] && !words[1].startsWith('-') ? words[1].replace(/[^\w:.-]/g, '') : '';
  if (/^python3?$/.test(w0)) return words[1] === '-m' && words[2] ? `python -m ${words[2]}` : 'python';
  if (!MULTI.test(w0) || !w1) return w0;
  if (/^(npm|pnpm|yarn|bun)$/.test(w0) && w1 === 'run' && words[2]) return `${w0} run ${words[2].replace(/[^\w:.-]/g, '')}`;
  return `${w0} ${w1}`;
}

const ACK = /^(yes|yep|yeah|ok|okay|continue|contiue|go ahead|go on|do it|sure|proceed|lgtm|looks good|great|nice|\d+|[a-d])\b[.!]?$/i;
const PUSHBACK = /^(no|nope|stop|wait|hold on|actually|not (that|this|what)|that'?s (wrong|not)|wrong|undo|revert)\b/i;

// ---------------------------------------------------------------------------
// Session builder
// ---------------------------------------------------------------------------
function newSession(e) {
  return {
    id: e.sessionId, agent: e.agent, project: e.project || e.agent, branch: null, start: null, end: null, title: null,
    turns: { human: 0, assistant: 0, ack: 0, pushback: 0, interruptions: 0 },
    tools: { total: 0, errors: 0, rejected: 0, blocked: 0, errorsByTool: {}, errorsByClass: {}, byName: {}, buckets: {}, shell: {} },
    time: { agentMinutes: 0, waitMinutes: 0, awayMinutes: 0, medianResponseSec: null },
    files: { edited: 0, read: 0, testEdits: 0, docEdits: 0 },
    editing: { edits: 0, blind: 0, rewrites: 0, reworkedFiles: 0 },
    interruptedAfter: {},
    skills: {}, mcpServers: {}, commands: {},
    subagents: { runs: 0, toolCalls: 0, types: {}, byType: {} },
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    costUsd: 0, peakContext: 0, models: {},
    context: { estimated: false, sources: {}, toolOutputByTool: {}, compactions: 0, compactPreTokens: 0, highContextTurns: 0, apiErrors: 0 },
    risk: { sensitiveAccess: 0, destructiveCommands: 0, maxErrorsPerTurn: 0 },
    signals: { testRuns: 0, fixLoops: 0, toolErrorRate: 0, correctionRate: 0, ackRate: 0 },
    _prompts: [], _subPrompts: [], _shellCmds: [], _toolNames: [], _edited: new Set(), _read: new Set(),
    _usageCost: 0, _claudeCost: null, _cum: null, _editsSinceTest: 0, _seenTest: false,
    _ctxMax: {}, _turnErrors: 0, _subRuns: new Map(), _loaded: { skill: {}, mcp: {} },
    _skillUse: {}, _hooks: {}, _toolErrClass: {}, _toolSeq: 0, _firstEdit: null, _firstRun: null,
    _known: {}, _editsByFile: {}, _lastTool: null,
    _shellHeads: [], _turnStart: null, _lastAgent: null, _agentMs: 0, _waitMs: 0, _awayMs: 0, _responses: [],
  };
}

const inc = (m, k, n = 1) => { if (k) m[k] = (m[k] || 0) + n; };

function addTool(s, e) {
  const name = e.toolName || 'tool';
  const bucket = toolBucket(name);
  if (!e.sidechain) { // order of the main thread's first run and first edit (did it reproduce before changing code?)
    s._toolSeq++; s._lastTool = name;
    if (bucket === 'shell' && s._firstRun == null) s._firstRun = s._toolSeq;
    if (bucket === 'edit' && s._firstEdit == null) s._firstEdit = s._toolSeq;
  }
  s.tools.total++; inc(s.tools.byName, name); inc(s.tools.buckets, bucket);
  s._toolNames.push(name);
  if (e.sidechain) { s.subagents.toolCalls++; sub(s, e).toolCalls++; }
  if (/^mcp__/.test(name)) inc(s.mcpServers, name.split('__')[1]);
  const d = e.detail;
  if (d && isSensitive(d)) s.risk.sensitiveAccess++;
  if (d && bucket === 'shell' && isDestructive(d)) s.risk.destructiveCommands++;
  if (/^(Agent|Task)$/.test(name)) {
    s.subagents.runs++;
    if (d) { const type = d.split(':')[0]; inc(s.subagents.types, type); s._toolNames.push(type); }
  }
  if (bucket === 'shell' && d) {
    s._shellCmds.push(d);
    const head = commandHead(d);
    inc(s.tools.shell, head);
    if (!e.sidechain && head) s._shellHeads.push(head);
    if (TEST_CMD.test(d)) {
      s.signals.testRuns++;
      if (s._seenTest && s._editsSinceTest > 0) s.signals.fixLoops++;
      s._seenTest = true; s._editsSinceTest = 0;
    }
  } else if (bucket === 'edit' && d) {
    s._edited.add(d); s._editsSinceTest++;
  } else if (bucket === 'read' && d && !/[*?]/.test(d)) {
    s._read.add(d);
  }
  trackEdit(s, e, name, bucket, d);
}

/**
 * Edit habits, per thread (the main conversation and each subagent see different files):
 * an edit to a file the thread never read (by a read tool or a shell command) is blind; a full
 * write over a file it had read or edited is a rewrite; a file edited REWORK_EDITS+ times is rework.
 */
const PATHLIKE = /^[^\s]+$/;
const pathTokens = (cmd) => String(cmd).split(/[\s'"`|;&<>()=]+/).filter((t) => /[/.]/.test(t) && /\w/.test(t)).map((t) => t.replace(/^\.\//, ''));
function trackEdit(s, e, name, bucket, d) {
  if (!d) return;
  const known = (s._known[e.sidechain || 'main'] = s._known[e.sidechain || 'main'] || new Set());
  const seen = (p) => known.has(p) || [...known].some((k) => p.endsWith('/' + k));
  if (bucket === 'read' && PATHLIKE.test(d)) known.add(d);
  else if (bucket === 'shell') for (const t of pathTokens(d)) known.add(t);
  else if (bucket === 'edit' && PATHLIKE.test(d) && /[/.]/.test(d)) {
    const write = /^(write|create_?file)$/i.test(name);
    if (write) { if (seen(d)) s.editing.rewrites++; } // a write to a new file creates it; that is not blind
    else { s.editing.edits++; if (!seen(d)) s.editing.blind++; }
    known.add(d); inc(s._editsByFile, d);
  }
}

/** Per-subagent-type tallies; a run is one distinct subagent (agentId). */
function sub(s, e) {
  const type = e.agentType || 'subagent';
  const t = (s.subagents.byType[type] = s.subagents.byType[type] || { runs: 0, toolCalls: 0, errors: 0, tokens: 0, outputTokens: 0 });
  if (!s._subRuns.has(e.sidechain)) { s._subRuns.set(e.sidechain, type); t.runs++; }
  return t;
}

function addUsage(s, e) {
  if (e.cumulative) {
    // cumulative counters (Codex): keep the largest snapshot, peak context from per-turn ctx
    const size = (x) => (x.input || 0) + (x.output || 0) + (x.cacheRead || 0) + (x.cacheWrite || 0);
    if (!s._cum || size(e) >= size(s._cum)) s._cum = e;
    s.peakContext = Math.max(s.peakContext, e.ctx || 0);
    return;
  }
  s.tokens.input += e.input || 0; s.tokens.output += e.output || 0;
  s.tokens.cacheRead += e.cacheRead || 0; s.tokens.cacheWrite += e.cacheWrite || 0;
  const ctx = (e.input || 0) + (e.cacheRead || 0) + (e.cacheWrite || 0);
  s.peakContext = Math.max(s.peakContext, ctx);
  if (e.sidechain) { const t = sub(s, e); t.tokens += ctx + (e.output || 0); t.outputTokens += e.output || 0; }
  else if (ctx > HIGH_CONTEXT) s.context.highContextTurns++;
  if (e.cost != null) s._usageCost += e.cost;
}

const AGENT_ACTIVITY = new Set(['assistant', 'tool', 'tool_error', 'usage']);

/**
 * Open a turn at a human prompt. Agent time is the sum of gaps between the agent's consecutive
 * actions (each ≤ 30 min); the gap from its last action to your next prompt is waiting, or away
 * if longer than 30 min.
 */
function startTurn(s, ts) {
  if (s._turnStart != null) {
    const last = s._lastAgent;
    const gap = ts - (last || s._turnStart);
    if (last && gap >= 0) { if (gap <= AWAY_MS) { s._waitMs += gap; s._responses.push(gap); } else s._awayMs += gap; }
  }
  s._turnStart = ts; s._lastAgent = null;
}

/** Fold events into SessionRecords. Events are processed in stream order per session. */
export function buildSessions(events, o = {}) {
  const map = new Map();
  for (const e of events) {
    if (!e.sessionId) continue;
    const key = `${e.agent}:${e.sessionId}`;
    let s = map.get(key);
    if (!s) { s = newSession(e); map.set(key, s); }
    if (e.ts) { s.start = s.start == null ? e.ts : Math.min(s.start, e.ts); s.end = s.end == null ? e.ts : Math.max(s.end, e.ts); }
    if (e.branch && !s.branch && e.branch !== 'HEAD') s.branch = e.branch;
    if (e.ts && !e.sidechain && AGENT_ACTIVITY.has(e.role) && s._turnStart != null && e.ts >= (s._lastAgent || s._turnStart)) {
      const d = e.ts - (s._lastAgent || s._turnStart);
      if (d <= AWAY_MS) s._agentMs += d; else s._awayMs += d; // resumed days later, not working
      s._lastAgent = e.ts;
    }
    switch (e.role) {
      case 'user': {
        if (e.sidechain) { const c = classify(e.text); if (c) s._subPrompts.push(c.text); break; }
        if (e.src && !o.allSources && !HUMAN_SRC.includes(e.src)) break;
        const c = classify(e.text); if (!c) break;
        s.turns.human++; s._prompts.push(c.text); s._turnErrors = 0; s._lastTool = null;
        if (e.ts) startTurn(s, e.ts);
        if (c.text.length < 40 && ACK.test(c.text.trim())) s.turns.ack++;
        if (PUSHBACK.test(c.text.trim())) s.turns.pushback++;
        break;
      }
      case 'assistant': if (!e.sidechain) s.turns.assistant++; inc(s.models, e.model); break;
      case 'tool': addTool(s, e); break;
      case 'tool_error': {
        const cls = e.unfinished ? 'unfinished' : errorClass(e.text);
        if (NOT_FAILURES.has(cls)) { s.tools[cls]++; break; }
        s.tools.errors++;
        inc(s.tools.errorsByClass, cls); inc(s.tools.errorsByTool, e.toolName || 'tool');
        inc((s._toolErrClass[e.toolName || 'tool'] = s._toolErrClass[e.toolName || 'tool'] || {}), cls);
        if (e.sidechain) sub(s, e).errors++;
        if (!e.unfinished) s.risk.maxErrorsPerTurn = Math.max(s.risk.maxErrorsPerTurn, ++s._turnErrors); // found after the fact, not in its turn
        break;
      }
      case 'ctx': {
        if (e.sidechain) break; // subagents run in their own context window
        const c = s.context; c.estimated = true;
        if (e.max) s._ctxMax[e.cat] = Math.max(s._ctxMax[e.cat] || 0, e.chars);
        else inc(c.sources, e.cat, e.chars);
        if (e.cat === 'toolOutput') inc(c.toolOutputByTool, e.tool, e.chars);
        break;
      }
      case 'loaded': { const m = s._loaded[e.kind]; if (m) m[e.name] = Math.max(m[e.name] || 0, e.chars || 0); break; }
      case 'compact': s.context.compactions++; s.context.compactPreTokens = Math.max(s.context.compactPreTokens, e.preTokens || 0); break;
      case 'api_error': s.context.apiErrors++; break;
      case 'usage': addUsage(s, e); break;
      case 'cost': if (s._claudeCost == null || e.usd > s._claudeCost) s._claudeCost = e.usd; break;
      case 'skill': {
        const u = (s._skillUse[e.text] = s._skillUse[e.text] || { tool: 0, load: 0, chars: 0 });
        if (e.via === 'load') { u.load++; u.chars = Math.max(u.chars, e.chars || 0); } else u.tool++;
        break;
      }
      case 'hook': {
        const h = (s._hooks[e.name] = s._hooks[e.name] || { event: e.event, runs: 0, ms: [], failed: 0, chars: 0, commands: new Set() });
        if (e.chars) h.chars += e.chars; else { h.runs++; if (e.ms != null) h.ms.push(e.ms); if (e.failed) h.failed++; }
        if (e.command) h.commands.add(e.command);
        break;
      }
      case 'command': inc(s.commands, e.text); break;
      case 'interrupt': s.turns.interruptions++; inc(s.interruptedAfter, s._lastTool || '(reply)'); break;
      case 'title': if (e.custom || !s.title) s.title = e.text; break;
      default: break;
    }
  }
  const out = [];
  for (const s of map.values()) {
    if (!s.turns.human && !s.turns.assistant && !s.tools.total) continue; // metadata-only stubs
    finalize(s);
    const manual = o.labels && o.labels[s.id];
    if (manual && TASK_IDS.includes(manual) && manual !== s.task.primary) s.task = { ...s.task, primary: manual, secondary: [], confidence: 1, source: 'manual', rulePrimary: s.task.primary };
    else if (manual === s.task.primary) s.task.source = 'manual';
    out.push(s);
  }
  return out.sort((a, b) => (b.start || 0) - (a.start || 0));
}

function finalize(s) {
  if (s._cum) {
    s.tokens.input += s._cum.input || 0; s.tokens.output += s._cum.output || 0;
    s.tokens.cacheRead += s._cum.cacheRead || 0; s.tokens.cacheWrite += s._cum.cacheWrite || 0;
  }
  s.tokens.total = s.tokens.input + s.tokens.output + s.tokens.cacheRead + s.tokens.cacheWrite;
  s.costUsd = +((s._claudeCost != null ? s._claudeCost : s._usageCost) || 0).toFixed(4);
  s.durationMin = s.start && s.end ? Math.round((s.end - s.start) / 60000) : null;
  s.files.edited = s._edited.size; s.files.read = s._read.size;
  s.editing.reworkedFiles = Object.values(s._editsByFile).filter((n) => n >= REWORK_EDITS).length;
  for (const f of s._edited) { if (TEST_FILE.test(f)) s.files.testEdits++; if (DOC_FILE.test(f)) s.files.docEdits++; }
  const h = s.turns.human;
  s.signals.toolErrorRate = s.tools.total ? +(s.tools.errors / s.tools.total).toFixed(3) : 0;
  s.signals.correctionRate = h ? +(s.turns.pushback / h).toFixed(3) : 0;
  s.signals.ackRate = h ? +(s.turns.ack / h).toFixed(3) : 0;
  const c = s.context;
  for (const [k, v] of Object.entries(s._ctxMax)) c.sources[k] = (c.sources[k] || 0) + v;
  const toTokens = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Math.round(v / 4)]).sort((a, b) => b[1] - a[1]));
  c.sources = toTokens(c.sources); c.toolOutputByTool = toTokens(c.toolOutputByTool);
  const r = s._responses.sort((a, b) => a - b);
  s.time = { agentMinutes: Math.round(s._agentMs / 60000), waitMinutes: Math.round(s._waitMs / 60000), awayMinutes: Math.round(s._awayMs / 60000), medianResponseSec: r.length ? Math.round(r[r.length >> 1] / 1000) : null };
  // A Skill tool call and the load it triggers are one use; loads by basename resolve to the listed "plugin:skill".
  const listed = Object.keys(s._loaded.skill);
  const resolve = (n) => (n.includes(':') ? n : (listed.filter((l) => l.endsWith(':' + n)).length === 1 ? listed.find((l) => l.endsWith(':' + n)) : n));
  const uses = {};
  for (const [n, u] of Object.entries(s._skillUse)) {
    const k = resolve(n); const x = (uses[k] = uses[k] || { tool: 0, load: 0, chars: 0 });
    x.tool += u.tool; x.load += u.load; x.chars = Math.max(x.chars, u.chars);
  }
  s._skillUse = uses;
  s.skills = Object.fromEntries(Object.entries(uses).map(([k, u]) => [k, Math.max(u.tool, u.load)]));
  s.task = labelTask(s);
  delete s._turnStart; delete s._lastAgent; delete s._agentMs; delete s._waitMs; delete s._awayMs; delete s._responses;
  delete s._ctxMax; delete s._turnErrors; delete s._subRuns; delete s._known; delete s._editsByFile; delete s._lastTool; // _loaded stays (internal) for the inventory
  delete s._cum; delete s._editsSinceTest; delete s._seenTest; delete s._usageCost; delete s._claudeCost;
}

// ---------------------------------------------------------------------------
// Task labelling
// ---------------------------------------------------------------------------
const hits = (re, list) => (re ? list.reduce((n, x) => n + (re.test(x) ? 1 : 0), 0) : 0);

/** Score a session against TASKS. Returns { primary, secondary, confidence, scores }. */
export function labelTask(s) {
  // The first prompt and the session title (written by the agent) state the intent: count them twice.
  const prompts = [...(s._prompts.length ? [s._prompts[0], ...s._prompts] : []), ...(s.title ? [s.title, s.title] : [])];
  const skillNames = [...Object.keys(s.skills), ...Object.keys(s.commands)];
  const edited = [...s._edited];
  const scores = {};
  for (const t of TASKS) {
    const n = {
      p: hits(t.p, prompts) + 0.5 * hits(t.p, s._subPrompts),
      sh: hits(t.sh, s._shellCmds),
      sk: hits(t.sk, skillNames),
      t: hits(t.t, s._toolNames),
      f: hits(t.f, edited),
    };
    let score = 0;
    for (const [ch, c] of Object.entries(n)) if (c) score += CHANNEL_WEIGHT[ch] * Math.log2(1 + c);
    if (score > 0) scores[t.id] = +score.toFixed(2);
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { primary: 'other', secondary: [], confidence: 0, scores, source: 'rules' };
  const total = ranked.reduce((x, [, v]) => x + v, 0);
  const [primary, top] = ranked[0];
  return {
    primary,
    secondary: ranked.slice(1).filter(([, v]) => v >= top * 0.5).map(([k]) => k),
    confidence: +(top / total).toFixed(2),
    scores,
    source: 'rules',
  };
}

// ---------------------------------------------------------------------------
// Per-task rollup — what a recommendation engine reads
// ---------------------------------------------------------------------------
const median = (arr) => { const a = arr.filter((x) => x != null).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };
const topN = (m, n = 5) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n);

/** Normalized MCP server key: "claude.ai Claude Docs" and "claude_ai_Claude_Docs" are one server. */
export const mcpKey = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** Was a listed skill used in this session (Skill tool, injected skill, or slash command)? */
function skillUsed(s, name) {
  const short = name.includes(':') ? name.split(':').pop() : name;
  for (const k of [...Object.keys(s.skills), ...Object.keys(s.commands)]) {
    const key = k.replace(/^\//, '');
    if (key === name || key === short) return true;
  }
  return false;
}

/**
 * What was installed versus what was used, across sessions whose logs list their setup.
 * Tokens are the estimated per-session context cost of listing the item (chars / 4).
 */
export function summarizeInventory(sessions) {
  const skills = {}, mcp = {};
  let measured = 0;
  for (const s of sessions) {
    const L = s._loaded || { skill: {}, mcp: {} };
    if (!Object.keys(L.skill).length && !Object.keys(L.mcp).length) continue;
    measured++;
    for (const [name, chars] of Object.entries(L.skill)) {
      const x = (skills[name] = skills[name] || { plugin: name.includes(':') ? name.split(':')[0] : null, loadedSessions: 0, usedSessions: 0, tokens: 0, lastSeen: null });
      x.loadedSessions++; x.lastSeen = Math.max(x.lastSeen || 0, s.start || 0) || null; x.tokens = Math.max(x.tokens, Math.round(chars / 4));
      if (skillUsed(s, name)) x.usedSessions++;
    }
    const used = new Set(Object.keys(s.mcpServers).map(mcpKey));
    const seen = {};
    for (const [name, chars] of Object.entries(L.mcp)) {
      const k = mcpKey(name);
      seen[k] = (seen[k] || 0) + chars;
      const x = (mcp[k] = mcp[k] || { name, loadedSessions: 0, usedSessions: 0, calls: 0, tokens: 0, lastSeen: null });
      x.lastSeen = Math.max(x.lastSeen || 0, s.start || 0) || null;
      if (/[ .]/.test(name)) x.name = name; // prefer the human spelling
    }
    for (const [k, chars] of Object.entries(seen)) {
      const x = mcp[k];
      x.loadedSessions++; x.tokens = Math.max(x.tokens, Math.round(chars / 4));
      if (used.has(k)) x.usedSessions++;
    }
    for (const [srv, n] of Object.entries(s.mcpServers)) if (mcp[mcpKey(srv)]) mcp[mcpKey(srv)].calls += n;
  }
  const byTokens = (m) => Object.fromEntries(Object.entries(m).sort((a, b) => b[1].tokens - a[1].tokens)
    .map(([key, x]) => [key, { ...x, lastSeen: x.lastSeen ? new Date(x.lastSeen).toISOString() : null }]));
  const latest = sessions.reduce((t, s) => Math.max(t, s.start || 0), 0);
  return { sessionsMeasured: measured, latestSession: latest ? new Date(latest).toISOString() : null, skills: byTokens(skills), mcpServers: byTokens(mcp) };
}

// ---------------------------------------------------------------------------
// Repeated command sequences — candidates for a script, alias or command
// ---------------------------------------------------------------------------
const EXPLORE_ONLY = /^(grep|rg|cat|ls|find|head|tail|wc|tree|sed|awk|echo|pwd|which|file|stat|sort|uniq|jq|python|node|for|while|if|do|done|then|mkdir|chmod|cp|mv|curl|sleep|kill|pkill|open)$/;

/** A sequence is only a workflow if it runs a project tool (VCS, package manager, build, test, deploy). */
const PROJECT_CMD = /^(git|gh|npm|pnpm|yarn|bun|npx|cargo|go|docker|kubectl|make|uv|pip|poetry|deno|dotnet|mvn|gradle|vercel|netlify|wrangler|terraform|pytest|jest|vitest|playwright|astro|next|vite|tsc|eslint|prettier|ruff|mypy)\b/;

/**
 * Shell-command runs of 3–5 steps (consecutive repeats collapsed) that recur in at least
 * `minSessions` sessions. Runs made only of looking around (grep, cat, ls, …) are skipped, and a
 * run is dropped when a longer run covers it in as many sessions.
 */
export function mineWorkflows(sessions, { minSessions = 3, top = 8 } = {}) {
  const found = new Map();
  for (const s of sessions) {
    const seq = (s._shellHeads || []).filter((h, i, a) => i === 0 || h !== a[i - 1]);
    const inSession = new Map();
    for (let n = 3; n <= 5; n++) for (let i = 0; i + n <= seq.length; i++) {
      const steps = seq.slice(i, i + n);
      if (steps.every((h) => EXPLORE_ONLY.test(h)) || !steps.some((h) => PROJECT_CMD.test(h)) || new Set(steps).size < 2) continue;
      const key = steps.join(' → ');
      inSession.set(key, (inSession.get(key) || 0) + 1);
    }
    for (const [key, runs] of inSession) {
      const w = found.get(key) || { steps: key.split(' → '), sessions: 0, runs: 0 };
      w.sessions++; w.runs += runs; found.set(key, w);
    }
  }
  const list = [...found.values()].filter((w) => w.sessions >= minSessions);
  const covered = (w) => list.some((o) => o !== w && o.steps.length > w.steps.length && o.sessions >= w.sessions && o.steps.join(' → ').includes(w.steps.join(' → ')));
  return list.filter((w) => !covered(w)).sort((a, b) => b.sessions - a.sessions || b.steps.length - a.steps.length).slice(0, top);
}

// ---------------------------------------------------------------------------
// Before/after — the metrics recommendations try to move, per period
// ---------------------------------------------------------------------------
/** Each metric: how to compute it over a set of sessions, and whether lower is better. */
export const TREND_METRICS = {
  costPerSession: { label: 'Spend per session', lowerIsBetter: true, usd: true, of: (S) => avg(S, (s) => s.costUsd) },
  tokensPerSession: { label: 'Tokens per session', lowerIsBetter: true, of: (S) => avg(S, (s) => s.tokens.total) },
  listingTokensPerSession: { label: 'Skill & MCP listing tokens per session', lowerIsBetter: true, of: (S) => avg(S.filter((s) => s._loaded && (Object.keys(s._loaded.skill).length || Object.keys(s._loaded.mcp).length)), (s) => Math.round((sumOf(s._loaded.skill) + sumOf(s._loaded.mcp)) / 4)) },
  browserOutputShare: { label: 'Browser share of tool output', lowerIsBetter: true, share: true, of: (S) => ratio(S, (s) => sumOf(s.context.toolOutputByTool, (k) => toolBucket(k) === 'browser'), (s) => sumOf(s.context.toolOutputByTool)) },
  highContextShare: { label: 'Turns over 150k context', lowerIsBetter: true, share: true, of: (S) => ratio(S, (s) => s.context.highContextTurns, (s) => s.turns.assistant) },
  ackRate: { label: '“Continue” prompts', lowerIsBetter: true, share: true, of: (S) => ratio(S, (s) => s.turns.ack, (s) => s.turns.human) },
  correctionRate: { label: 'Corrections', lowerIsBetter: true, share: true, of: (S) => ratio(S, (s) => s.turns.pushback, (s) => s.turns.human) },
  toolErrorRate: { label: 'Failed tool calls', lowerIsBetter: true, share: true, of: (S) => ratio(S, (s) => s.tools.errors, (s) => s.tools.total) },
  blindEditShare: { label: 'Edits without a read first', lowerIsBetter: true, share: true, of: (S) => ratio(S, (s) => s.editing.blind, (s) => s.editing.edits) },
  interruptsPerSession: { label: 'Interruptions per session', lowerIsBetter: true, of: (S) => avg(S, (s) => s.turns.interruptions) },
  sensitivePerSession: { label: 'Secret/key touches per session', lowerIsBetter: true, of: (S) => avg(S, (s) => s.risk.sensitiveAccess) },
};
function sumOf(m, keep = () => true) { let n = 0; for (const [k, v] of Object.entries(m || {})) if (keep(k)) n += v; return n; }
function avg(S, f) { return S.length ? +(S.reduce((x, s) => x + f(s), 0) / S.length).toFixed(4) : null; }
function ratio(S, num, den) { const d = S.reduce((x, s) => x + den(s), 0); return d ? +(S.reduce((x, s) => x + num(s), 0) / d).toFixed(4) : null; }

/** One metric, before vs after: relative change and a verdict (a change under 10% is flat). */
export function compareMetric(key, before, after) {
  const m = TREND_METRICS[key];
  if (!m || before == null || after == null) return null;
  const change = before ? (after - before) / before : null;
  return { label: m.label, share: !!m.share, ...(m.usd && { usd: true }), before, after, change: change == null ? null : +change.toFixed(3),
    verdict: change == null || Math.abs(change) < 0.1 ? 'flat' : (change < 0) === m.lowerIsBetter ? 'better' : 'worse' };
}

// ---------------------------------------------------------------------------
// Review periods — calendar months by default, or a custom cycle; the retro and its trend follow them
// ---------------------------------------------------------------------------
const DAY = 864e5;
/** ms → "2026-09-16" in local time. (toLocaleDateString('en-CA') is not reliable: some Node builds print 9/16/2026.) */
export const localDate = (t) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
/** "2026-09-16" → local midnight of that day, in ms. */
export const localDay = (iso) => { const [y, m, d] = String(iso).split('-').map(Number); return new Date(y, m - 1, d).getTime(); };

/** Fewer sessions than this in a period is too little to judge it. */
export const MIN_PERIOD_SESSIONS = 5;

/**
 * Review periods [from, to), newest first; the first is the one in progress at `now`. Without a
 * cycle they are calendar months. With a cycle ({ start: 'YYYY-MM-DD', days }) they repeat every
 * `days` from `start` (any past cycle start will do). They reach back to the earliest session
 * (at least `count` periods, at most two years), and each counts its sessions.
 * Boundaries step in calendar days (new Date(y, m, d + n)), so they stay at local midnight across DST.
 */
export function periodWindows(sessions, cycle, { now = Date.now(), count = 6 } = {}) {
  const starts = sessions.filter((s) => s.start).map((s) => s.start);
  const countIn = (from, to) => starts.filter((t) => t >= from && t < to).length;
  const earliest = starts.length ? Math.min(...starts) : now;
  const today = new Date(now);
  let edge;
  if (!cycle) {
    edge = (i) => new Date(today.getFullYear(), today.getMonth() - i, 1).getTime(); // start of the i-th month back
  } else {
    const [y, m, d] = String(cycle.start).split('-').map(Number);
    const todayIdx = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()) - new Date(y, m - 1, d)) / DAY);
    const k = Math.floor(todayIdx / cycle.days);
    edge = (i) => new Date(y, m - 1, d + (k - i) * cycle.days).getTime();
  }
  const out = [];
  for (let i = 0; i < (cycle ? Math.ceil(730 / cycle.days) : 24); i++) {
    const from = edge(i), to = edge(i - 1);
    if (i >= count && to <= earliest) break;
    out.push({ from, to, current: i === 0, sessions: countIn(from, to) });
  }
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** A period's name: "September 2026" for a month, "2026-09-16 → 2026-09-29" for a cycle. */
export function periodName(w, cycle) {
  if (!w) return 'all sessions';
  if (!cycle) { const d = new Date(w.from); return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`; }
  return `${localDate(w.from)} → ${localDate(w.to - 1)}`;
}

/** The period a retro reviews by default: the last completed one with sessions, or the current one. */
export function defaultPeriod(windows) {
  return windows.find((w) => !w.current && w.sessions) || windows[0] || null;
}

/**
 * Compare two periods and return per-metric verdicts, or null unless both hold `minSessions`.
 *  - split (ms): before = sessions starting earlier, after = the rest;
 *  - window + previous ({ from, to } each): the period against the one before it.
 */
/** Fewer sessions than this on either side and one odd session decides the verdict, so no comparison. */
export const TREND_MIN_SESSIONS = 3;
export function comparePeriods(sessions, { split = null, window = null, previous = null, minSessions = TREND_MIN_SESSIONS } = {}) {
  const dated = sessions.filter((s) => s.start);
  if (!dated.length || (!split && !(window && previous))) return null;
  const inside = (w) => (s) => s.start >= w.from && s.start < w.to;
  const before = split ? dated.filter((s) => s.start < split) : dated.filter(inside(previous));
  const after = split ? dated.filter((s) => s.start >= split) : dated.filter(inside(window));
  if (before.length < minSessions || after.length < minSessions) return null;
  const metrics = {};
  for (const key of Object.keys(TREND_METRICS)) {
    const c = compareMetric(key, TREND_METRICS[key].of(before), TREND_METRICS[key].of(after));
    if (c) metrics[key] = c;
  }
  return { boundary: new Date(split || window.from).toISOString(), mode: split ? 'split' : 'period', sessions: { before: before.length, after: after.length }, metrics };
}

// ---------------------------------------------------------------------------
// Extensions — plugins, skills, MCP servers, hooks and slash commands, one table each
// ---------------------------------------------------------------------------
const EXT_RECENT_DAYS = 14;
/** used / rarely used (in < 10% of the sessions it was loaded in) / unused. */
function verdict(sessionsUsed, sessionsLoaded) {
  if (!sessionsUsed) return 'unused';
  return sessionsLoaded && sessionsUsed / sessionsLoaded < 0.1 ? 'rarely used' : 'used';
}
const pctile = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : null; };

/**
 * Per-extension usage from the session records and the inventory. `config` (from
 * readClaudeConfig) says where MCP servers and plugins are configured; it only labels, never counts.
 */
export function summarizeExtensions(sessions, inventory, config = {}) {
  const latest = inventory.latestSession ? Date.parse(inventory.latestSession) : 0;
  const recent = (iso) => !latest || (iso && latest - Date.parse(iso) <= EXT_RECENT_DAYS * 864e5);
  const lastUse = {}; const note = (k, t) => { if (t && (!lastUse[k] || t > lastUse[k])) lastUse[k] = t; };
  const iso = (t) => (t ? new Date(t).toISOString() : null);

  // Skills
  const skills = {};
  const skill = (name) => (skills[name] = skills[name] || { name, plugin: name.includes(':') ? name.split(':')[0] : null, uses: 0, sessionsUsed: 0, sessionsLoaded: 0, listingTokens: 0, tokensPerLoad: null, lastSeen: null });
  for (const [name, x] of Object.entries(inventory.skills)) Object.assign(skill(name), { sessionsLoaded: x.loadedSessions, listingTokens: x.tokens, lastSeen: x.lastSeen });
  for (const s of sessions) for (const [name, u] of Object.entries(s._skillUse || {})) {
    const k = skill(name); k.uses += Math.max(u.tool, u.load); k.sessionsUsed++;
    if (u.chars) k.tokensPerLoad = Math.max(k.tokensPerLoad || 0, Math.round(u.chars / 4));
    note('skill:' + name, s.start);
  }
  const skillList = Object.values(skills).map((k) => ({ ...k, lastUsed: iso(lastUse['skill:' + k.name]), current: recent(k.lastSeen) || !!lastUse['skill:' + k.name], verdict: verdict(k.sessionsUsed, k.sessionsLoaded) }))
    .sort((a, b) => b.uses - a.uses || b.listingTokens - a.listingTokens);

  // MCP servers
  const servers = {};
  const server = (key, name) => (servers[key] = servers[key] || { key, name: name || key, source: null, calls: 0, sessionsUsed: 0, sessionsLoaded: 0, errors: 0, errorClasses: {}, outputTokens: 0, listingTokens: 0, tools: {}, lastSeen: null });
  for (const [key, m] of Object.entries(inventory.mcpServers)) Object.assign(server(key, m.name), { sessionsLoaded: m.loadedSessions, listingTokens: m.tokens, lastSeen: m.lastSeen });
  const srvOf = (tool) => { const m = /^mcp__(.+?)__(.+)$/.exec(tool); return m && [mcpKey(m[1]), m[1], m[2]]; };
  for (const s of sessions) {
    const used = new Set();
    for (const [tool, n] of Object.entries(s.tools.byName)) { const k = srvOf(tool); if (!k) continue; const x = server(k[0], k[1]); x.calls += n; x.tools[k[2]] = (x.tools[k[2]] || 0) + n; used.add(k[0]); }
    for (const [tool, n] of Object.entries(s.tools.errorsByTool)) { const k = srvOf(tool); if (k) server(k[0], k[1]).errors += n; }
    for (const [tool, cls] of Object.entries(s._toolErrClass || {})) { const k = srvOf(tool); if (k) for (const [c, n] of Object.entries(cls)) inc(server(k[0], k[1]).errorClasses, c, n); }
    for (const [tool, tok] of Object.entries(s.context.toolOutputByTool)) { const k = srvOf(tool); if (k) server(k[0], k[1]).outputTokens += tok; }
    for (const k of used) { servers[k].sessionsUsed++; note('mcp:' + k, s.start); }
  }
  const sourceOf = (key) => (config.userMcp && config.userMcp[key] ? 'user' : config.projectMcp && config.projectMcp[key] ? 'project'
    : /^plugin_/.test(key) ? 'plugin' : /^claude_ai_/.test(key) ? 'claude.ai' : 'built-in');
  const mcpList = Object.values(servers).map((x) => {
    const top = Object.entries(x.errorClasses).sort((a, b) => b[1] - a[1])[0];
    return { key: x.key, name: x.name, source: sourceOf(x.key), calls: x.calls, sessionsUsed: x.sessionsUsed, sessionsLoaded: Math.max(x.sessionsLoaded, x.sessionsUsed),
      errors: x.errors, errorRate: x.calls ? +(x.errors / x.calls).toFixed(3) : 0, topError: top ? top[0] : null, outputTokens: x.outputTokens, listingTokens: x.listingTokens,
      topTools: Object.entries(x.tools).sort((a, b) => b[1] - a[1]).slice(0, 3), lastSeen: x.lastSeen, lastUsed: iso(lastUse['mcp:' + x.key]),
      current: recent(x.lastSeen) || !!lastUse['mcp:' + x.key], verdict: verdict(x.sessionsUsed, x.sessionsLoaded) };
  }).sort((a, b) => b.calls - a.calls || b.listingTokens - a.listingTokens);

  // Plugins: grouped from their skills, MCP servers and commands; enabled state from settings
  const plugins = {};
  const plugin = (name) => (plugins[name] = plugins[name] || { name, enabledKey: null, disabled: false, skillsListed: 0, skillsUsed: 0, uses: 0, mcpServers: [], commandsUsed: 0, listingTokens: 0, sessionsLoaded: 0, current: false, lastUsed: null });
  for (const k of skillList) if (k.plugin) {
    const p = plugin(k.plugin); p.skillsListed += k.sessionsLoaded ? 1 : 0; p.skillsUsed += k.uses ? 1 : 0; p.uses += k.uses; p.listingTokens += k.listingTokens;
    p.sessionsLoaded = Math.max(p.sessionsLoaded, k.sessionsLoaded); p.current = p.current || k.current; if (k.lastUsed && (!p.lastUsed || k.lastUsed > p.lastUsed)) p.lastUsed = k.lastUsed;
  }
  // enabledPlugins maps "name@marketplace" to true/false: only true is enabled
  for (const [key, on] of Object.entries(config.enabledPlugins || {})) { const p = plugin(key.split('@')[0]); if (on === false) p.disabled = true; else p.enabledKey = key; }
  for (const m of mcpList) {
    const p = Object.values(plugins).find((x) => m.key.startsWith(`plugin_${mcpKey(x.name)}_`));
    if (p) { p.mcpServers.push(m.name); p.uses += m.calls; p.sessionsLoaded = Math.max(p.sessionsLoaded, m.sessionsLoaded); p.current = p.current || m.current; }
  }
  const commands = {};
  for (const s of sessions) for (const [c, n] of Object.entries(s.commands)) {
    const x = (commands[c] = commands[c] || { name: c, uses: 0, sessions: 0, lastUsed: null }); x.uses += n; x.sessions++;
    if (s.start && (!x.lastUsed || s.start > Date.parse(x.lastUsed))) x.lastUsed = iso(s.start);
    const p = /^\/?([^:\s]+):/.exec(c); if (p && plugins[p[1]]) { plugins[p[1]].commandsUsed += n; plugins[p[1]].uses += n; }
  }
  const pluginList = Object.values(plugins).map((p) => ({ ...p, verdict: p.disabled ? 'disabled' : p.uses ? (p.skillsListed && p.skillsUsed / p.skillsListed < 0.1 ? 'rarely used' : 'used') : p.sessionsLoaded ? 'unused' : 'no activity' }))
    .sort((a, b) => b.uses - a.uses || b.listingTokens - a.listingTokens);

  // Hooks
  const hooks = {};
  for (const s of sessions) for (const [name, h] of Object.entries(s._hooks || {})) {
    const x = (hooks[name] = hooks[name] || { name, event: h.event, runs: 0, sessions: 0, ms: [], failures: 0, injectedTokens: 0, commands: new Set() });
    x.runs += h.runs; x.sessions++; x.ms.push(...h.ms); x.failures += h.failed; x.injectedTokens += Math.round(h.chars / 4);
    for (const c of h.commands) x.commands.add(c);
  }
  const hookList = Object.values(hooks).map((h) => ({ name: h.name, event: h.event, runs: h.runs, sessions: h.sessions, medianMs: pctile(h.ms, 0.5), p90Ms: pctile(h.ms, 0.9), failures: h.failures,
    injectedTokens: h.injectedTokens, tokensPerSession: h.sessions ? Math.round(h.injectedTokens / h.sessions) : 0, commands: [...h.commands].slice(0, 5) }))
    .sort((a, b) => b.injectedTokens - a.injectedTokens || b.runs - a.runs);

  return {
    sessionsMeasured: inventory.sessionsMeasured,
    plugins: pluginList, skills: skillList, mcpServers: mcpList, hooks: hookList,
    commands: Object.values(commands).sort((a, b) => b.uses - a.uses),
  };
}

/** Session-level context, subagent and risk totals for the rollup. */
export function summarizeSessions(sessions) {
  const sources = {}, toolOutput = {}, subagents = {};
  const risk = { sensitiveAccess: 0, destructiveCommands: 0, sessionsWithErrorBursts: 0 };
  const errors = { total: 0, rejected: 0, blocked: 0, byClass: {}, byTool: {} };
  const time = { agentMinutes: 0, waitMinutes: 0, awayMinutes: 0, responses: [] };
  let compactions = 0, compactedSessions = 0, highContextTurns = 0, apiErrors = 0, measured = 0;
  for (const s of sessions) {
    const c = s.context;
    if (c.estimated) measured++;
    for (const [k, v] of Object.entries(c.sources)) inc(sources, k, v);
    for (const [k, v] of Object.entries(c.toolOutputByTool)) inc(toolOutput, k, v);
    compactions += c.compactions; if (c.compactions) compactedSessions++;
    highContextTurns += c.highContextTurns; apiErrors += c.apiErrors;
    risk.sensitiveAccess += s.risk.sensitiveAccess; risk.destructiveCommands += s.risk.destructiveCommands;
    if (s.risk.maxErrorsPerTurn >= 3) risk.sessionsWithErrorBursts++;
    errors.total += s.tools.errors; errors.rejected += s.tools.rejected; errors.blocked += s.tools.blocked;
    for (const [k, v] of Object.entries(s.tools.errorsByClass)) inc(errors.byClass, k, v);
    for (const [k, v] of Object.entries(s.tools.errorsByTool)) inc(errors.byTool, k, v);
    time.agentMinutes += s.time.agentMinutes; time.waitMinutes += s.time.waitMinutes; time.awayMinutes += s.time.awayMinutes;
    if (s.time.medianResponseSec != null) time.responses.push(s.time.medianResponseSec);
    for (const [type, t] of Object.entries(s.subagents.byType)) {
      const a = (subagents[type] = subagents[type] || { runs: 0, sessions: 0, toolCalls: 0, errors: 0, tokens: 0, outputTokens: 0 });
      a.sessions++;
      for (const k of ['runs', 'toolCalls', 'errors', 'tokens', 'outputTokens']) a[k] += t[k];
    }
  }
  return {
    context: { sessionsMeasured: measured, sources: Object.fromEntries(topN(sources, 20)), toolOutputByTool: Object.fromEntries(topN(toolOutput, 12)), compactions, compactedSessions, highContextTurns, apiErrors },
    subagents: Object.fromEntries(Object.entries(subagents).sort((a, b) => b[1].tokens - a[1].tokens)),
    risk,
    toolErrors: { ...errors, byClass: Object.fromEntries(topN(errors.byClass, 12)), byTool: Object.fromEntries(topN(errors.byTool, 12)) },
    time: { agentMinutes: time.agentMinutes, waitMinutes: time.waitMinutes, awayMinutes: time.awayMinutes, medianResponseSec: median(time.responses) || null },
    workflows: mineWorkflows(sessions),
    editing: summarizeEditing(sessions),
  };
}

/** How the agent edits, and when you stop it: totals across sessions. */
function summarizeEditing(sessions) {
  const e = { edits: 0, blind: 0, rewrites: 0, reworkedFiles: 0, reworkSessions: 0, editSessions: 0, reads: 0, interruptions: 0, interruptedSessions: 0, interruptedAfter: {} };
  for (const s of sessions) {
    e.edits += s.editing.edits; e.blind += s.editing.blind; e.rewrites += s.editing.rewrites; e.reworkedFiles += s.editing.reworkedFiles;
    if (s.editing.edits) e.editSessions++;
    if (s.editing.reworkedFiles) e.reworkSessions++;
    e.reads += s.tools.buckets.read || 0;
    e.interruptions += s.turns.interruptions; if (s.turns.interruptions) e.interruptedSessions++;
    for (const [k, v] of Object.entries(s.interruptedAfter)) inc(e.interruptedAfter, k, v);
  }
  e.readsPerEdit = e.edits ? +(e.reads / e.edits).toFixed(1) : null;
  e.blindShare = e.edits ? +(e.blind / e.edits).toFixed(3) : null;
  e.interruptedAfter = Object.fromEntries(topN(e.interruptedAfter, 8));
  return e;
}

export function summarizeTasks(sessions) {
  const groups = {};
  for (const s of sessions) (groups[s.task.primary] = groups[s.task.primary] || []).push(s);
  const out = {};
  for (const [task, list] of Object.entries(groups)) {
    const tools = {}, shell = {}, skills = {};
    let calls = 0, errors = 0, human = 0, pushback = 0, cost = 0;
    const ctxSources = {}; let compactions = 0, highCtx = 0, sensitive = 0, destructive = 0;
    for (const s of list) {
      for (const [k, v] of Object.entries(s.context.sources)) inc(ctxSources, k, v);
      compactions += s.context.compactions; highCtx += s.context.highContextTurns;
      sensitive += s.risk.sensitiveAccess; destructive += s.risk.destructiveCommands;
      for (const [k, v] of Object.entries(s.tools.byName)) inc(tools, k, v);
      for (const [k, v] of Object.entries(s.tools.shell)) inc(shell, k, v);
      for (const [k, v] of Object.entries(s.skills)) inc(skills, k, v);
      calls += s.tools.total; errors += s.tools.errors; human += s.turns.human; pushback += s.turns.pushback; cost += s.costUsd;
    }
    out[task] = {
      label: (TASKS.find((t) => t.id === task) || { label: 'Other' }).label,
      sessions: list.length,
      share: +(list.length / sessions.length).toFixed(3),
      medianTurns: median(list.map((s) => s.turns.human)),
      medianMinutes: median(list.map((s) => s.durationMin)),
      medianToolCalls: median(list.map((s) => s.tools.total)),
      totalCost: +cost.toFixed(2),
      medianCost: +median(list.map((s) => s.costUsd)).toFixed(4),
      toolErrorRate: calls ? +(errors / calls).toFixed(3) : 0,
      correctionRate: human ? +(pushback / human).toFixed(3) : 0,
      fixLoops: list.reduce((n, s) => n + s.signals.fixLoops, 0),
      topTools: topN(tools), topShell: topN(shell), topSkills: topN(skills),
      compactions, highContextTurns: highCtx, sensitiveAccess: sensitive, destructiveCommands: destructive,
      contextSources: Object.fromEntries(topN(ctxSources, 12)),
    };
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1].sessions - a[1].sessions));
}
