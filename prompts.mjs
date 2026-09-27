/**
 * prompts.mjs — prompt-engineering practices, detected from the text of your prompts.
 *
 * analyzePrompt(text) finds the visible marks of each practice (a file path, "for example",
 * "as a table", a numbered list, "must not"). It detects whether a practice is present, not how
 * well it was done — judging that needs a model, and is out of scope here.
 * summarizePrompts(sessions) adds how often you use each practice and, from your own sessions,
 * whether openings with it needed fewer follow-ups and corrections.
 */

const ACK = /^(yes|yep|yeah|ok|okay|continue|contiue|go ahead|go on|do it|sure|proceed|lgtm|looks good|great|nice|thanks?|\d+|[a-d])\b/i;
const MIN_TASK_CHARS = 15;

// Examples: each marker or input→output pair is one example, so 1 → one-shot, 2+ → few-shot.
const EXAMPLE_MARKERS = /\b(for example|for instance|e\.g\.|such as|like this:|here'?s an example|example:|sample:)/gi;
const IO_PAIR = /\b(input|before)\s*[:=][\s\S]{1,200}?\b(output|after)\s*[:=]/gi;

const TECHNIQUES = {
  role: /\b(you are an?|act as|as an? (expert|senior|experienced|top)|pretend (to be|you are)|your role)\b/i,
  'step-by-step': /\b(step[- ]by[- ]step|think (it )?through|first\b[^.?!]{3,120}\bthen\b|walk me through|reason about)/i,
  'output-format': /\b(return|respond|reply|output|format|give me|write it)\b[^.?!]{0,60}\b(as|in|with)\b[^.?!]{0,40}\b(table|json|list|bullets?|markdown|csv|yaml|diff|code block|one line|paragraph|sections?)\b|\bin (a )?(table|json|bullet(ed)? list)\b/i,
  constraints: /\b(must|must not|do not|don'?t|never|only|avoid|keep\b|without|no more than|at most|at least|limit(ed)? to|stay within)\b/i,
  context: /(?:^|[\s(`'"])(?:\.{0,2}\/|~\/)?[\w.-]+\/[\w./-]+\.\w{1,6}\b|@[\w./-]+|\b[\w-]+\.(tsx?|jsx?|py|go|rs|java|rb|css|scss|html|md|json|ya?ml|toml|sql|sh)\b|https?:\/\/\S+|\[Image #\d+\]|\b(traceback|stack ?trace|error:|exception|exit code \d|line \d+)\b|```/i,
  goal: /\b(so that|in order to|the goal|my goal|goal is|done when|success (is|means|criteria)|should (result|end up|look|be able)|acceptance|expected (result|behaviou?r|output))\b/i,
  why: /\b(because|since (it|we|i|the)|the reason|so that|this matters|otherwise)\b/i,
};
const STRUCTURED = /(^|\n)\s*([-*•]|\d+[.)]|#{1,4} )\s+\S|<\/?[a-z_]+>/i;
const VAGUE_VERB = /^(please )?(fix|improve|make|update|change|clean|redo|do|help|check|review|optimi[sz]e|refactor)\b[^.?!]{0,30}\b(it|this|that|these|things?|stuff|better|nicer|work|good|everything|the (issue|bug|problem|code|page|ui))\b/i;

/** Practices checked on opening prompts, with a plain-words reason (from Anthropic's prompt guidance). */
export const PRACTICES = [
  ['context', 'Give context', 'Point at the files, errors, links or screenshots involved, so the agent does not have to search or guess.'],
  ['goal', 'State the goal and when it is done', 'A clear outcome and success criteria let the agent stop at the right place instead of asking or over-building.'],
  ['constraints', 'Say what to keep or avoid', 'Constraints (what must not change, what to use or avoid) prevent the rework that shows up as corrections.'],
  ['output-format', 'Say what you want back', 'Naming the output (a diff, a table, a short list) gets it in one go instead of a follow-up.'],
  ['examples', 'Show an example', 'One or two examples communicate style and edge cases faster than a description.'],
  ['structure', 'Structure long requests', 'Lists, headings or tags in a long prompt keep separate requirements from blurring together.'],
  ['why', 'Explain why', 'The reason behind a request lets the agent make the right trade-offs on details you did not spell out.'],
];

/** Whether a prompt is a task prompt at all (not an acknowledgement or a one-word reply). */
export const isTaskPrompt = (text) => {
  const t = String(text || '').trim();
  return t.length >= MIN_TASK_CHARS && !(t.length < 40 && ACK.test(t));
};

/** The practices and techniques visible in one prompt; null for acknowledgements and short replies. */
export function analyzePrompt(text) {
  const t = String(text || '').trim();
  if (!isTaskPrompt(t)) return null;
  // A fenced block is usually pasted code or output (context), so only explicit markers count as examples.
  const examples = (t.match(EXAMPLE_MARKERS) || []).length + (t.match(IO_PAIR) || []).length;
  const techniques = new Set(Object.entries(TECHNIQUES).filter(([, re]) => re.test(t)).map(([k]) => k));
  if (t.length >= 200 && STRUCTURED.test(t)) techniques.add('structured');
  const concrete = techniques.has('context') || /["'`“][^"'`”]{3,}["'`”]|\b[A-Z][a-z]+[A-Z]\w*\b/.test(t);
  return {
    length: t.length,
    shots: examples === 0 ? 'zero-shot' : examples === 1 ? 'one-shot' : 'few-shot',
    examples,
    techniques,
    question: /\?\s*$/.test(t) || /^(how|what|why|where|when|which|can|could|should|is|are|does|do)\b/i.test(t),
    vague: t.length < 90 && VAGUE_VERB.test(t) && !concrete,
    has: (p) => (p === 'examples' ? examples > 0 : p === 'structure' ? techniques.has('structured') : techniques.has(p)),
  };
}

const median = (arr) => { const a = [...arr].sort((x, y) => x - y); return a.length ? a[a.length >> 1] : null; };
const share = (n, d) => (d ? +(n / d).toFixed(3) : 0);

/**
 * Prompt types, practice adoption, and — on opening prompts — how sessions went with and without
 * each practice. Outcomes need at least `minGroup` sessions on each side, otherwise they are null.
 */
export function summarizePrompts(sessions, { minGroup = 3 } = {}) {
  const all = [];
  const openings = [];
  for (const s of sessions) {
    const prompts = s._prompts || [];
    prompts.forEach((text, i) => { const a = analyzePrompt(text); if (a) all.push(a); });
    const first = prompts.findIndex((p) => isTaskPrompt(p));
    if (first < 0) continue;
    const a = analyzePrompt(prompts[first]);
    openings.push({ a, text: prompts[first], followUps: Math.max(0, s.turns.human - 1 - first), corrected: s.turns.pushback > 0 });
  }
  const n = all.length;
  const count = (f) => all.filter(f).length;
  const types = {
    prompts: n,
    shots: { 'zero-shot': share(count((a) => a.shots === 'zero-shot'), n), 'one-shot': share(count((a) => a.shots === 'one-shot'), n), 'few-shot': share(count((a) => a.shots === 'few-shot'), n) },
    techniques: Object.fromEntries(['role', 'step-by-step', 'structured', 'output-format', 'constraints', 'context', 'goal', 'why'].map((k) => [k, share(count((a) => a.techniques.has(k)), n)])),
    questions: share(count((a) => a.question), n),
  };

  const long = openings.filter((o) => o.a.length >= 200);
  const practices = PRACTICES.map(([id, label, why]) => {
    const pool = id === 'structure' ? long : openings;
    const withIt = pool.filter((o) => o.a.has(id)); const without = pool.filter((o) => !o.a.has(id));
    const outcome = withIt.length >= minGroup && without.length >= minGroup ? {
      with: { sessions: withIt.length, medianFollowUps: median(withIt.map((o) => o.followUps)), correctionRate: share(withIt.filter((o) => o.corrected).length, withIt.length) },
      without: { sessions: without.length, medianFollowUps: median(without.map((o) => o.followUps)), correctionRate: share(without.filter((o) => o.corrected).length, without.length) },
    } : null;
    // helps: better on one measure and no worse on the other
    if (outcome) { const [w, wo] = [outcome.with, outcome.without]; outcome.helps = (w.medianFollowUps < wo.medianFollowUps && w.correctionRate <= wo.correctionRate) || (w.medianFollowUps === wo.medianFollowUps && w.correctionRate < wo.correctionRate); }
    return { id, label, why, share: share(withIt.length, pool.length), sessions: pool.length, outcome };
  });

  const medLen = median(all.map((a) => a.length)) || 0;
  const S = { terse: count((a) => a.length < 60), brief: count((a) => a.length >= 300 && (a.techniques.has('structured') || a.techniques.has('goal'))), pasted: count((a) => a.techniques.has('context') && a.length >= 200), question: count((a) => a.question) };
  const style = !n ? null : S.brief / n >= 0.3 ? 'detailed briefs' : S.pasted / n >= 0.3 ? 'pasted-context driven' : S.question / n >= 0.35 ? 'question-led' : S.terse / n >= 0.5 ? 'terse commands' : 'conversational';
  const top = practices.filter((p) => p.id !== 'structure').sort((a, b) => b.share - a.share);
  const summary = !n ? [] : [
    `Your prompts are mostly ${style}: median ${medLen} characters, ${Math.round(types.shots['zero-shot'] * 100)}% zero-shot (instructions without examples).`,
    `In opening prompts you most often ${top[0].label.toLowerCase()} (${Math.round(top[0].share * 100)}%) and least often ${top[top.length - 1].label.toLowerCase()} (${Math.round(top[top.length - 1].share * 100)}%).`,
    ...(openings.length ? [`${Math.round(share(openings.filter((o) => o.followUps >= 3).length, openings.length) * 100)}% of sessions needed 3 or more follow-up prompts after the opening.`] : []),
  ];

  const vague = openings.filter((o) => o.a.vague);
  const vagueExamples = vague.sort((x, y) => y.followUps - x.followUps).slice(0, 5).map((o) => ({
    text: o.text.length > 140 ? o.text.slice(0, 139) + '…' : o.text,
    missing: PRACTICES.filter(([id]) => ['context', 'goal', 'constraints', 'output-format'].includes(id) && !o.a.has(id)).map(([, label]) => label),
    followUps: o.followUps,
  }));

  return { openings: openings.length, types, practices, style, summary, vagueShare: share(vague.length, openings.length), vagueExamples };
}
