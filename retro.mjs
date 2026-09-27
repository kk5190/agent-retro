/**
 * retro.mjs — the analysis as a personal retrospective of one review period (a month by default).
 *
 * buildRetro(analysis, sessions, previous) arranges what the rest of the pipeline already found
 * into the retro format: a period card, then Went well / Didn't go well / Start / Stop, Action
 * items, and a Kaizen block — one measured experiment, plus a review of the last saved retro's
 * action items (baseline → now). No new analysis happens here; every item points at the section
 * holding its numbers.
 */
import { TREND_METRICS, compareMetric, localDate, periodName, MIN_PERIOD_SESSIONS } from './sessions.mjs';
import { REC_METRIC, PLAYBOOKS } from './recommend.mjs';

const MAX = 4;

/** Short phrases for the one-line verdict: what went better, and what hurt. */
const WIN = { costPerSession: 'Cheaper sessions', tokensPerSession: 'Leaner sessions', toolErrorRate: 'Fewer tool failures', highContextShare: 'Lighter context', browserOutputShare: 'Fewer screenshots', ackRate: 'Fewer check-ins', correctionRate: 'Fewer corrections', listingTokensPerSession: 'A leaner setup', sensitivePerSession: 'Safer tool use' };
const DRAG = { costPerSession: 'spend per session went up', tokensPerSession: 'sessions got heavier', toolErrorRate: 'more tool calls failed', highContextShare: 'your context ran hot', browserOutputShare: 'screenshots crowded the context', ackRate: 'more “continue?” check-ins', correctionRate: 'more corrections', listingTokensPerSession: 'your setup got heavier', sensitivePerSession: 'more secret-file access',
  'context-source': 'tool output crowds your context', 'context-pressure': 'your context ran hot', corrections: 'you corrected the agent often', 'error-bursts': 'tools failed in bursts', risk: 'a few risky operations' };

/** Recommendations that add a habit go under Start; ones that remove something under Stop. */
const STOP = new Set(['unused-plugins', 'unused-skills', 'unused-mcp', 'check-ins', 'heavy-hooks', 'heavy-skills']);

const pct = (x) => Math.round(x * 100) + '%';
const compact = (v) => (v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'k' : String(+(+v).toFixed(2)));
export function formatMetric(key, v) {
  const m = TREND_METRICS[key];
  if (v == null || !m) return '—';
  return m.usd ? '$' + v.toFixed(2) : m.share ? pct(v) : compact(v);
}
const firstSentence = (t) => { const m = /^[\s\S]*?[.!?](\s|$)/.exec(t || ''); return (m ? m[0] : t || '').trim(); };

/** Sessions that started inside the period [from, to). */
function periodSessions(sessions, window) {
  if (!window) return { list: sessions, from: null, to: null };
  return { list: sessions.filter((s) => s.start && s.start >= window.from && s.start < window.to), from: window.from, to: window.to };
}

/**
 * `window` is the period under review ({ from, to, current }, from periodWindows);
 * `cycle` is the configured review cycle, or null for calendar months.
 */
export function buildRetro(analysis, sessions, previous = null, window = null, cycle = null) {
  const a = analysis;
  const { list, from, to } = periodSessions(sessions, window);
  const iso = (t) => (t ? localDate(t) : null); // local calendar day, like the period boundaries
  const unit = cycle ? 'cycle' : 'month';
  const recs = a.recommendations || [];

  // Period card
  const byTask = {};
  for (const s of list) byTask[s.task.primary] = (byTask[s.task.primary] || 0) + 1;
  const [topTask, topN] = Object.entries(byTask).sort((x, y) => y[1] - x[1])[0] || ['other', 0];
  const taskLabel = ((a.tasks || {})[topTask] || {}).label || topTask;
  const spend = list.reduce((x, s) => x + (s.costUsd || 0), 0);
  const agentHours = list.reduce((x, s) => x + ((s.time && s.time.agentMinutes) || 0), 0) / 60;
  const card = {
    sessions: list.length, spend: +spend.toFixed(2), agentHours: +agentHours.toFixed(1),
    prompts: list.reduce((x, s) => x + s.turns.human, 0), topTask: list.length ? { id: topTask, label: taskLabel, share: +(topN / list.length).toFixed(2) } : null,
  };

  // Went well
  const trendNote = !a.trend ? '' : a.trend.mode === 'period' ? `${a.trend.period || 'This period'} against the ${unit} before.` : a.trend.mode === 'split' ? `Before and after ${a.trend.boundary.slice(0, 10)}.` : `Last ${a.trend.days} days against the ${a.trend.days} before.`;
  const wentWell = [];
  const trend = a.trend ? Object.entries(a.trend.metrics) : [];
  for (const [key, m] of trend) if (m.verdict === 'better') wentWell.push({ text: `${m.label}: ${formatMetric(key, m.before)} → ${formatMetric(key, m.after)}`, detail: trendNote, section: 'changes' });
  for (const p of ((a.prompting || {}).practices || [])) if (p.outcome && p.outcome.helps && p.share >= 0.3) {
    wentWell.push({ text: `You ${p.label.charAt(0).toLowerCase() + p.label.slice(1)} in ${pct(p.share)} of openings`, detail: `Those sessions needed ${p.outcome.with.medianFollowUps} follow-ups; without it, ${p.outcome.without.medianFollowUps}.`, section: 'prompting' });
  }
  for (const [task, t] of Object.entries(a.tasks || {})) if (PLAYBOOKS[task] && t.sessions >= 3 && !recs.some((r) => r.task === task)) {
    wentWell.push({ text: `${t.label} follows the playbook`, detail: `${t.sessions} sessions, and none skip its key practices in most sessions.`, section: 'tasks' });
  }
  if ((a.context || {}).cacheHitRate >= 80) wentWell.push({ text: `${a.context.cacheHitRate}% of input served from cache`, detail: 'Cached input costs a fraction of fresh input.', section: 'tokens' });
  if (a.risk && !a.risk.sensitiveAccess && !a.risk.destructiveCommands) wentWell.push({ text: 'No secret access or destructive commands', detail: 'Nothing touched .env files, keys or ~/.ssh; no force-pushes or risky deletes.', section: 'risk' });

  // Didn't go well
  const didntGoWell = [];
  for (const f of (a.findings || [])) if (f.level === 'attention') didntGoWell.push({ text: f.title, detail: f.detail, section: f.section });
  for (const [key, m] of trend) if (m.verdict === 'worse' && !didntGoWell.some((x) => x.text.startsWith(m.label))) didntGoWell.push({ text: `${m.label}: ${formatMetric(key, m.before)} → ${formatMetric(key, m.after)}`, detail: trendNote, section: 'changes' });

  // Start / Stop
  const toItem = (r) => ({ text: r.title, detail: firstSentence(r.action), section: 'changes', recId: r.id });
  const start = recs.filter((r) => !STOP.has(r.id)).map(toItem);
  const stop = recs.filter((r) => STOP.has(r.id)).map(toItem);

  // Action items: the top three with a fix, each with the metric that will show whether it worked
  const metricNow = (key) => (TREND_METRICS[key] ? TREND_METRICS[key].of(list) : null);
  const actions = recs.filter((r) => r.fix).slice(0, 3).map((r) => {
    const key = REC_METRIC[r.id];
    const now = key ? metricNow(key) : null;
    return { id: r.id, title: r.title, level: r.level, fix: r.fix, ...(key && now != null && { metric: { key, label: TREND_METRICS[key].label, now, display: formatMetric(key, now) } }) };
  });

  // Kaizen: one experiment, and the review of the last saved retro
  const exp = actions.find((x) => x.metric);
  const kaizen = {
    experiment: exp ? { title: exp.title, metric: exp.metric, span: cycle ? `${cycle.days} days` : 'month',
      check: `agent-retro --retro at the end of next ${unit}` } : null,
    review: previous ? {
      savedAt: previous.savedAt,
      items: (previous.actions || []).map((p) => {
        const now = p.metric ? metricNow(p.metric) : null;
        const c = p.metric ? compareMetric(p.metric, p.baseline, now) : null;
        return { title: p.title, metric: p.metric ? TREND_METRICS[p.metric].label : null, baseline: p.metric ? formatMetric(p.metric, p.baseline) : null, now: p.metric ? formatMetric(p.metric, now) : null, verdict: c ? c.verdict : 'unmeasured', stillOpen: recs.some((r) => r.id === p.id) };
      }),
    } : null,
  };

  const win = wentWell[0], drag = didntGoWell[0];
  const better = trend.find(([k, m]) => m.verdict === 'better' && WIN[k]);
  const hurt = (a.findings || []).find((f) => f.level === 'attention' && DRAG[f.id]) || null;
  const worse = trend.find(([k, m]) => m.verdict === 'worse' && DRAG[k]);
  const good = better ? WIN[better[0]] : null;
  const bad = hurt ? (hurt.id === 'context-source' && hurt.source ? `${hurt.source} crowds your context` : DRAG[hurt.id]) : worse ? DRAG[worse[0]] : null;
  const thin = list.length < MIN_PERIOD_SESSIONS;
  const verdict = !list.length ? `No sessions this ${unit} yet`
    : thin ? `${list.length} session${list.length === 1 ? '' : 's'} so far: too few to judge this ${unit}`
    : good && bad ? `${good}, but ${bad}` : good || (bad ? bad.charAt(0).toUpperCase() + bad.slice(1) : `A steady ${unit}`);
  const headline = !list.length ? 'No sessions in this period yet.'
    : `${list.length} session${list.length === 1 ? '' : 's'}${card.spend ? `, $${card.spend.toFixed(0)}` : ''} and ${card.agentHours.toFixed(0)} h of agent work, mostly ${/^[A-Z][a-z]/.test(taskLabel) ? taskLabel.charAt(0).toLowerCase() + taskLabel.slice(1) : taskLabel}.`
      + (win ? ` Biggest win: ${win.text.charAt(0).toLowerCase() + win.text.slice(1)}.` : '') + (drag ? ` Biggest drag: ${drag.text.charAt(0).toLowerCase() + drag.text.slice(1).replace(/\.$/, '')}.` : '');

  return {
    period: { name: periodName(window, cycle), unit, from: iso(from), to: iso(to ? to - 1 : null), days: from ? Math.round((to - from) / 864e5) : null, current: !!(window && window.current) },
    card, headline, verdict, thin,
    wentWell: wentWell.slice(0, MAX), didntGoWell: didntGoWell.slice(0, MAX), start: start.slice(0, MAX), stop: stop.slice(0, MAX),
    actions, kaizen,
  };
}

/** What a saved retro keeps: its action items and their metric baselines — no prompt text. */
export function retroSnapshot(retro) {
  return {
    version: 1, savedAt: new Date().toISOString(), period: retro.period,
    actions: retro.actions.map((x) => ({ id: x.id, title: x.title, metric: x.metric ? x.metric.key : null, baseline: x.metric ? x.metric.now : null })),
  };
}
