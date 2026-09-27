# Contributing

Thanks for helping. The project has no dependencies and no build step. You need Node >= 18 and
`npm test`.

## Layout

| File | Owns |
| --- | --- |
| `agents.mjs` | Store discovery, per-agent adapters → normalized events, `loadEvents`, `eventsToData` |
| `sessions.mjs` | `buildSessions` (events → SessionRecords), the `TASKS` table, `labelTask`, `summarizeTasks` |
| `agent-retro.mjs` | CLI, `loadTelemetry`, `analyze` (rollup), text/markdown reports |
| `prompts.mjs` | Prompt-practice detection (`analyzePrompt`) and the per-practice outcome summary |
| `retro.mjs` | The retro: arranges trend, findings, prompting and recommendations into columns, action items and Kaizen |
| `recommend.mjs` | Recommendation rules (one function each) and the Claude Code config reader |
| `telemetry.mjs` | Schema version, redaction, text levels, export bundle |
| `mcp.mjs` | stdio MCP server over the telemetry views |
| `ui.mjs`, `ui/index.html` | Local dashboard |
| `fixtures.mjs` | Test fixtures (`writeFixtures`) and the `--demo` history (`writeDemo`) |
| `schema/telemetry.schema.json` | The public contract for the export and MCP records |

## Adding or fixing an agent adapter

1. Write a `collectX(o)` in `agents.mjs` that returns normalized events. The event shape is
   documented at the top of that file. Every event needs `agent`, `sessionId`, `project` and `ts`.
   Include `detail` on `tool` events when the store records arguments, and emit `tool_error` for
   failed tool results. These feed the command and error telemetry.
2. Register it in `ADAPTERS` and `STORES`.
3. Add a small real-shaped fixture and a test to `tests.mjs`. **Never commit real transcripts.**
   Build fixtures by hand, like the existing ones.
4. Check your own machine with `node agent-retro.mjs --doctor`.

## Improving task labels

Task rules live in the `TASKS` table in `sessions.mjs`. A row has an `id`, a `label`, and optional
regexes per channel:

- `p`: human prompts
- `sh`: shell commands
- `sk`: skills and slash commands
- `t`: tool names and subagent types
- `f`: edited file paths

To add a task:

1. Add a row.
2. Add the id to the `taskId` enum in `schema/telemetry.schema.json`. A test checks that the two
   stay in sync.
3. Add a fixture session that the new row should win, in `tests.mjs`.

When you tune a regex, check the effect on your own history before and after:

```bash
node agent-retro.mjs --sessions --text excerpts | jq -r '[.task.primary, .task.confidence, .title] | @tsv'
```

## Adding a recommendation rule

A rule is a function `({ analysis, sessions, config }) => recommendation | null` in
`recommend.mjs`, registered in `RULES`. Follow these conventions:

- **Threshold:** fire only above an evidence threshold, and return `null` otherwise.
- **Evidence:** state it with the user's own numbers.
- **Fixes:** give a `fix` only when the change is mechanical, and build it from the user's real
  config (see `readClaudeConfig`). Never guess setting keys.
- **Privacy:** set `personal: true` if the evidence or fix quotes prompt text or project paths.
  Level `none` exports then drop those fields.
- **Tests:** add a fixture where the rule fires, and make sure the empty-history test still
  returns nothing.

## Adding a task playbook

`PLAYBOOKS` in `recommend.mjs` holds one row per task. A row has:
- `practices`: pairs of label and check, where each check tests one session record.
- `tools`: suggestions to recommend.
- `steps`: the workflow written into `~/.claude/commands/<task>.md`.

The rule reports every practice that fewer than half of the task's sessions followed. Keep each
check to what the logs actually show: commands run, skills and subagents used, tests run, files
edited, and the order of the first run versus the first edit.

## Schema changes

Additive fields are fine within `schemaVersion: 1`. Update the schema file, and the test suite
validates real output against it. Renaming or removing a field, or changing its meaning, requires
bumping `SCHEMA_VERSION` in `telemetry.mjs` and noting it in the README.

## Privacy rules

- Anything that leaves the process goes through `telemetry.mjs` views. Those views redact, and
  they respect `--text`.
- Never add prompt text, file contents or tool output to `--text none` output.
- New free-text fields must pass through `redact()`.
