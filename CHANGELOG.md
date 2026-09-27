# Changelog

## 0.1.0 — first public release

- **Session telemetry:** every coding-agent session becomes one record (schema v1). Each record
  holds:
  - the task label
  - turns, acks and corrections
  - tools, failures and their causes, shell commands
  - files edited
  - skills, subagents and MCP servers used
  - tokens and cost
  - estimated context sources and compactions
  - working and waiting time
  - risk signals
- **Review periods:** calendar months by default, or fixed cycles (a start day plus a length).
  The review covers the last completed period against the one before; fewer than 5 sessions is
  reported as too few to judge.
- **Monthly review:** a period card; Went well / Didn't go well; Change, one list of things to
  start or stop, led by the top three with fixes, the metric to watch and one experiment; and Did
  it work?, for the last saved review. Each fact appears in one place.
  Available in the dashboard, as `--retro [--md]`, as `--save-retro`, and through the MCP tool
  `get_retro`.
- **Recommendations:** evidence-backed rules, each with a fix you can paste:
  - unused plugins, skills and MCP servers
  - screenshots versus page text
  - context pressure
  - secrets
  - failing tools
  - edits without a read, and edit loops on one file
  - check-ins
  - repeated prompts and command sequences
  - heavy hooks and skills
  - opening-prompt practices
  - per-task workflow playbooks
- **How the agent edits:** reads per edit, edits without a read, files patched 5+ times, full
  rewrites; your interruptions by the tool running when you stopped it; and tool calls that never
  finished, as their own failure cause.
- **Extensions analysis:** plugins, skills, MCP servers, hooks, subagents and slash commands,
  loaded versus used.
- **Prompt practices:** zero-, one- and few-shot shares, techniques, and practices compared with
  your own session outcomes.
- **Before/after trends:** the reviewed period against the one before, or around a date with
  `--split <date>`.
- **Local dashboard, reports and exports:**
  - a dashboard with a Home page (verdict, five areas with a status and a peek, what to do next,
    whether last month's changes worked), focused pages for the review, work, cost, setup, habits
    and sessions, one period picker (any month with sessions, or all time; weeks and days too when your sessions fill them), and a summary page
  - a quiet visual language: warm grey with one blue accent, charts that grey out everything but
    the value that matters, half-circle gauges per area, a 24-hour clock of when you prompt, and
    light and dark themes
  - `--scope current|last|all` to limit the whole analysis to one period
  - terminal and markdown reports
  - a redacted, versioned export (`--export`, `--sessions`, `--text none|excerpts|full`)
  - an MCP server (`--mcp`)
- **Agents:** Claude Code (primary), plus Codex CLI, pi, opencode, Continue, Zed and Cursor.
- **Setup-free:** `--demo` for trying it without logs. Zero dependencies, Node ≥ 18.
