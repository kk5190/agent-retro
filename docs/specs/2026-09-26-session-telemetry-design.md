# Session telemetry — design (sub-project 1)

## Goal

agent-retro becomes a **session-transcript analysis tool**. It turns local coding-agent logs into
structured, versioned telemetry. Two kinds of consumer read the same data:

- **Humans**: the CLI report and the localhost dashboard.
- **Agents**: an exported file bundle (the contract) and an MCP server (a thin read layer over it).

Out of scope for this sub-project, and built on top of the telemetry later:

- **Sub-project 2:** recommendations (tools, CLIs, skills, agents, prompts).
- **Sub-project 3:** generators (write `SKILL.md` files, hooks, commands).

## Decisions

| Question | Decision |
| --- | --- |
| Agent access | Versioned file export (`telemetry.json` + `sessions.jsonl`), plus a zero-dependency stdio MCP server over the same records |
| Task labelling | Offline heuristic scoring (prompt text + tool fingerprints + skills/commands), with a confidence value |
| Text in export | `--text none \| excerpts \| full`, default `excerpts`, always redacted |
| Dependencies | None. Node >= 18. SQLite is used only through the optional `sqlite3` CLI (unchanged) |

## Pipeline

```
adapters (agents.mjs)  → normalized events, sessionId on every event
sessions.mjs           → SessionRecord[]  (per-session metrics + task label)
agent-retro.mjs analyze()   → rollup (existing aggregates + per-task profile)
telemetry.mjs          → schema v1 bundle, redaction, text levels
consumers              → CLI text/md/json · UI /api/* · --export dir · mcp.mjs
```

The Claude loader moves out of `agent-retro.mjs` and becomes an ordinary adapter
(`collectClaude`) that emits the same event stream as every other agent. All agents then feed
one `eventsToData` rollup path and one `buildSessions` path, so the rollup and the per-session
numbers cannot disagree.

### Event (internal, normalized)

`{ agent, sessionId, project, ts, role, ... }`, where `role` is one of:

- `user`: `text`, `src?`, `sidechain?`
- `assistant`: `model?`, `sidechain?`
- `tool`: `toolName`, `detail?` (shell command, skill name, subagent type, file path), `sidechain?`
- `tool_error`: a tool result flagged as an error
- `usage`: token counts, `cost?`, `cumulative?`, `ctx?`
- `cost`: `usd`, `modelUsage` (Claude `cost-state`)
- `title`, `skill`, `command`, `interrupt`

Claude subagent transcripts (`isSidechain`) are attributed to the parent session as subagent
work. They are **never** counted as human prompts. This fixes a baseline bug.

### SessionRecord (exported, schema v1)

- **Identity:** `id`, `agent`, `project`, `branch?`, `start`, `end`, `durationMin`, `title?`
- **`turns`:** `{ human, assistant, ack, pushback, interruptions }`
- **`tools`:**
  - `{ total, errors, byName, buckets, shell }`
  - `shell` holds normalized command heads, e.g. `git diff`, `npm test`
- **`files`:** `{ edited, read, testEdits, docEdits }`
- **`skills`, `mcpServers`, `commands`:** count maps
- **`subagents`:** `{ runs, toolCalls, types }`
- **`tokens`:** `{ input, output, cacheRead, cacheWrite, total }`
- **`costUsd`**, **`peakContext`**, **`models`**
- **`task`:**
  - `{ primary, secondary[], confidence, scores }`
  - `confidence` is 0–1: the primary task's share of the total score
- **`signals`:**
  - `{ testRuns, fixLoops, toolErrorRate, correctionRate, ackRate }`
  - These are efficiency inputs for sub-project 2
- **`text`:**
  - `{ excerpts[] }` at the `excerpts` level; every human prompt at the `full` level
  - Always redacted

### Task taxonomy

`code-review`, `debugging`, `feature`, `refactor`, `testing`, `planning`, `ui-design`, `docs`,
`git-ops`, `deploy-ops`, `research`, `agent-setup`, `other`.

Each task is one row in the `TASKS` table in `sessions.mjs`. A row has weighted regexes over:

- **prompts:** human prompts; subagent prompts count at half weight
- **shell:** command heads
- **skills:** skill and slash-command names
- **tools:** tool names and subagent types
- **files:** edited file paths

A session is scored against every row. The session's primary task is the highest score, and
confidence is the primary task's share of the total. Contributors add a task by adding one row.

### Rollup additions

`analyze()` gains `tasks`, keyed by task. Each entry has:

- `sessions`, `share`
- `medianTurns`, `medianMinutes`
- `totalCost`, `medianCost`
- `toolErrorRate`, `correctionRate`
- `topTools`, `topShell`, `topSkills`

This per-task profile is what the recommendation engine will read.

### Export bundle

`agent-retro --export <dir> [--text excerpts]` writes two files:

- `telemetry.json`: `{ schemaVersion: 1, generator, generatedAt, filters, textLevel, rollup }`
- `sessions.jsonl`: one SessionRecord per line

The shape is described by `schema/telemetry.schema.json` (JSON Schema 2020-12) and validated in
the tests.

### Redaction (every level)

Redaction applies to all exported text: excerpts, titles, and shell command heads. It masks or
replaces:

- **Secrets:**
  - provider keys: `sk-…`, `ghp_…`/`github_pat_…`, `AKIA…`, `xox…`
  - bearer tokens and JWTs
  - `key=value` style secrets
  - long hex/base64 runs
- **Personal details:**
  - email addresses
  - home-directory paths, which become `~`

The `none` level also drops titles and all prompt text.

### MCP server

`agent-retro --mcp [--all-agents] [--text …]` speaks JSON-RPC 2.0 over stdio, newline-delimited.
It supports `initialize`, `ping`, `tools/list` and `tools/call`.

| Tool | Returns |
| --- | --- |
| `get_overview` | Compact rollup: volume, tasks table, cost, context, top tools and skills |
| `list_sessions` | Session records, filterable by task, project, agent and days; sortable by cost, turns or recency; limited |
| `get_session` | One record by id |
| `get_task_profile` | Task stats plus the ids of its costliest and longest sessions |

Results are cached per filter combination for the life of the process.

### UI

- New **Tasks** card: a per-task table.
- New **Sessions** explorer: filter by task, click a row to see its details.
- Both are served from `/api/data` (the `tasks` section) and a new `/api/sessions` endpoint.

### Packaging

- `package.json` (`bin: agent-retro`, `files`, `engines`, `test` script)
- `LICENSE` (MIT), `CONTRIBUTING.md`, `.gitignore`
- The README is rewritten around telemetry, the export, MCP and privacy.

## Testing

Fixture tests (`node --test`) cover:

- **Claude adapter:** session ids, sidechain attribution, tool detail, and error results.
- **Session builder:** turn, tool and cost aggregation.
- **Task labelling:** a review session, a debugging session and a feature session each get the expected primary label.
- **Redaction and text levels.**
- **Schema:** the export bundle validates against it.
- **MCP:** an initialize → `tools/list` → `tools/call` round-trip over a child process.
- **Regression:** the existing adapter tests stay green.

## Addendum: context, subagent and risk telemetry

These ideas were borrowed from claude-devtools. It is a single-session viewer, so its per-session
views became cross-session metrics here.

- **Context sources.** The Claude adapter emits `ctx` events (source category plus character count)
  for:
  - attachments: system prompt snapshot, CLAUDE.md instructions, skill, agent and MCP listings,
    hook context, files, reminders;
  - tool input and output, attributed to tools by `tool_use_id`;
  - thinking, assistant text, and user text.

  Sessions sum the character counts and convert at about 4 characters per token. The system prompt
  and memory are snapshots, so the largest one counts; everything else accumulates. Only the main
  thread is counted.
- **Compaction.** `compact_boundary` system records give the trigger and `preTokens`.
  `api_error` records are counted too.
- **Subagents.** The type is read from `agent-*.meta.json`. Tokens, tool calls and errors are
  tallied per type. Cost is not, because it is only logged per session.
- **Risk.**
  - Sensitive-path access and destructive commands are both tested against the command text with
    heredoc bodies and long inline scripts removed.
  - `rm -rf` of build, cache and temp paths is routine and not counted.
  - `maxErrorsPerTurn` is the most tool errors between two human prompts.
- **Rollup.** `contextBreakdown`, `subagentTypes` and `risk` are added, and each task profile gains
  compaction, high-context, risk and `contextSources` fields.
