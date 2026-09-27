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
- **Sprint calendar** (start day plus length, e.g. two-week sprints starting Wednesdays): the
  retro reviews the last completed sprint against the one before, with a picker for earlier
  sprints. An *All sessions* overview covers everything in view.
- **Sprint retro:** a sprint card; Went well / Didn't go well / Start / Stop; action items with
  fixes and the metric to watch; and Kaizen, with a review of the last saved retro. Available in
  the dashboard, as `--retro [--md]`, as `--save-retro`, and through the MCP tool `get_retro`.
- **Recommendations:** evidence-backed rules, each with a fix you can paste:
  - unused plugins, skills and MCP servers
  - screenshots versus page text
  - context pressure
  - secrets
  - failing tools
  - check-ins
  - repeated prompts and command sequences
  - heavy hooks and skills
  - opening-prompt practices
  - per-task workflow playbooks
- **Extensions analysis:** plugins, skills, MCP servers, hooks, subagents and slash commands,
  loaded versus used.
- **Prompt practices:** zero-, one- and few-shot shares, techniques, and practices compared with
  your own session outcomes.
- **Before/after trends:** the last 14 days against the 14 before, or around a date with
  `--split <date>`.
- **Local dashboard, reports and exports:**
  - a dashboard with findings, charts, sortable tables and a session explorer
  - terminal and markdown reports
  - a redacted, versioned export (`--export`, `--sessions`, `--text none|excerpts|full`)
  - an MCP server (`--mcp`)
- **Agents:** Claude Code (primary), plus Codex CLI, pi, opencode, Continue, Zed and Cursor.
- **Setup-free:** `--demo` for trying it without logs. Zero dependencies, Node ≥ 18.
