# cc-habits

A zero-dependency dashboard for local coding-agent conversation logs. By default it reads Claude
Code's `~/.claude/projects/**/*.jsonl` (plus optional `~/.claude/transcripts` and
`~/.claude/history.jsonl`); with `--all-agents` it merges every other coding agent it can find on the
machine into one normalized report: cadence, prompt style, themes, tone, workflow loops, tools,
sessions, and per-agent breakdowns.

Nothing is uploaded. Raw transcript bytes are streamed line-by-line and never printed in full.

## Multiple agents

```bash
node habits.mjs --scan          # discover every agent store on this machine, with sizes
node habits.mjs --all-agents    # merge all detected agents into one report
node habits.mjs --agent codex   # restrict to one agent
node habits.mjs --list-agents   # print the parseable agent ids
```

Discovered and parsed today (verified against on-disk schemas):

| Agent | Store | Format |
| --- | --- | --- |
| Claude Code | `~/.claude/projects` | JSONL |
| pi | `~/.pi/agent/sessions` | JSONL |
| Codex CLI | `~/.codex/sessions` | JSONL rollout |
| opencode | `~/.local/share/opencode/storage` | JSON graph |
| Continue | `~/.continue/sessions` | JSON |
| Zed | `~/Library/Application Support/Zed/threads` | SQLite + zstd |
| Cursor | `~/Library/Application Support/Cursor/.../state.vscdb` | SQLite KV |

Antigravity/Gemini, Windsurf, Copilot, Amp, and Factory are **discovered** by `--scan` but their
conversation bytes are not parsed yet (SQLite/protobuf blobs). Adapters live in `agents.mjs`; each
exposes `collectX(o)` returning normalized events `{ agent, sessionId, project, ts, role, text,
 toolName?, model? }`.

## Adapter resilience (anti-rot)

Vendor formats change constantly. Four layers of defense:

1. **Shape-based fallback** — `harvestEvents` / `collectGeneric` re-parse records by field *shape*
   (find a role, a timestamp, text by any key name) rather than exact names. If a precise adapter
   yields zero events, the fallback degrades gracefully instead of returning nothing.
2. **Health reporting** — `cc-habits --doctor` prints per-adapter file/event yield and flags
   `STALE` (files exist, zero events) or `ERROR`, so drift is visible immediately.
3. **Fixture tests** — `node --test tests.mjs` runs every adapter against a small real-shaped
   fixture (plus a deliberately renamed schema). A format change fails CI, not silently.
4. **Adapter spec** — one `collectX(o)` per agent returning normalized events; add agents without
   touching the analysis engine.

```bash
cc-habits --doctor          # per-adapter yield + stale detection
node --test tests.mjs       # fixture suite
```

## Web UI

```bash
node habits.mjs --ui              # http://127.0.0.1:4173
node habits.mjs --ui --open       # launch + open in browser
node habits.mjs --ui --port 5000
```

A self-contained dark dashboard (`ui/index.html`, no external assets, localhost only). It includes
live filters (project, time window, all-agents, single-agent, transcripts, all-sources) served by
`ui.mjs` via `/api/data` and `/api/meta`. Responses are cached per filter combination; the raw logs
are parsed once per distinct query.

Built for spotting patterns, not just reading totals:
- **Insight strip** — auto-derived patterns: peak hour, rhythm, prompting style, focus, primary agent,
  session shape, busiest day, go-to prompt.
- **Activity heatmap** — weekday × hour grid, so routine and deep-work blocks jump out.
- **Activity over time** — daily prompts with a 7-day moving average.
- **Distributions** — prompt-length and session-length histograms.
- **Agent comparison** — prompts / tools / sessions / active days / median length per agent.
- **Tokens & cost** — total tokens split into new input / cache read / cache write / output, plus
  recorded per-agent and per-model cost, and a daily token trend.
- **Context window** — median/p90/peak input tokens seen per turn, cache-hit rate, and how many turns
  exceeded 150k. This is your real context-pressure and compaction signal.
- **Prompt phases** — planning / implementation / debugging / review / code review / ack, with
  example prompts.
- **Skills & plugins** — skill invocations and MCP-server / plugin-command usage.

### Where the numbers come from

| Signal | Source |
| --- | --- |
| Claude cost | `cost-state.totalCostUSD` + `modelUsage` (authoritative, per session) |
| Claude tokens | `assistant.message.usage` (input, cache read/write, output, thinking) |
| pi cost/tokens | `message.usage` (includes recorded `cost.total`) |
| opencode cost/tokens | `message.cost` + `message.tokens` |
| Codex tokens | `token_count.info.total_token_usage` (cumulative, collapsed per session; per-turn context from `last_token_usage`) |
| Continue tokens | `dev_data` telemetry (`promptTokens`/`generatedTokens`) |
| Skills | `Skill` tool calls + `Base directory for this skill:` injections |
| Plugins / MCP | `mcp__<server>__<tool>` calls + plugin slash commands |
| Phases | regex classification over human prompts |

## Usage

```bash
node habits.mjs                       # human-readable report
node habits.mjs --md                  # markdown report
node habits.mjs --json                # machine-readable JSON
node habits.mjs --ui                   # local web dashboard
node habits.mjs --days 30             # only the last 30 days
node habits.mjs --project myportfolio # filter to one project
node habits.mjs --tz 5.5              # force a UTC offset (hours)
node habits.mjs --include-transcripts # also read ~/.claude/transcripts
node habits.mjs --top 20              # rows per ranked list (default 15)
node habits.mjs --no-history          # skip ~/.claude/history.jsonl
node habits.mjs --all-sources         # include SDK/system-injected prompts
node habits.mjs --scan                # list detected agent stores and exit
node habits.mjs --errors              # print parse warnings to stderr
```

Requires Node >= 18. No install step.

## What the sections mean

| Section | Signal |
| --- | --- |
| Volume | human prompt turns vs agent turns — logs are mostly agent output |
| Cadence | hour-of-day and weekday rhythm |
| Prompt style | median length + terse/long share (communication density) |
| Themes | regex buckets over prompts (design, motion, git, deploy, …) |
| Tone | agreement/pushback/blunt/question markers |
| Tools | shell / edit / read / browse mix, plus per-tool counts |
| Sessions | turns and wall-clock duration per session |
| CLI history | slash commands and typed entries from `history.jsonl` |

The web UI renders the same analysis as clickable charts: hour/weekday rhythm, theme and tone bars,
tool-bucket donut, model split, session stats, repeated prompts, and CLI commands.

## Tuning

Edit the `THEMES`, `TONE`, and `NOISE` constants at the top of `habits.mjs` to change what gets
bucketed or filtered. Theme buckets are plain regexes, so adding your own is a one-line change.

## Notes

- Prompt classification drops tool results, meta messages, images, command wrappers, and known
  injection blobs. Add patterns to `NOISE` if new wrappers appear.
- "Human" prompts default to `promptSource` in `typed / queued / suggestion_accepted / sdk`.
  Use `--all-sources` to include everything.
- Timestamps use your machine's local timezone unless `--tz` is passed.
