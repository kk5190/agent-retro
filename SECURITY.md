# Security and privacy

agent-retro reads coding-agent logs on your machine. It sends nothing anywhere: no telemetry, no
network calls. The dashboard listens on `127.0.0.1` only, and accepts writes (label corrections,
reload) only from its own page.

- **What it reads:**
  - agent log folders (`~/.claude/projects`, `~/.codex/sessions`, …)
  - `~/.claude/settings.json` and `~/.claude.json`, to name the plugins and MCP servers
    correctly in fixes
  - `~/.claude/history.jsonl`
- **What it writes:**
  - `~/.agent-retro/labels.json`, only when you correct a task label
  - `~/.agent-retro/config.json`, only when you set a sprint calendar
  - `~/.agent-retro/retros/<date>.json`, only when you save a retro (action ids and metric
    baselines only)
  - export files, only when you pass `--export`
- **Before exported text leaves the process,** these are masked: API keys and tokens, emails and
  home-directory paths. `--text none` removes prompt text entirely and replaces project names,
  branches and uncommon command names with stable codes.

Redaction is pattern-based, so review an export before sharing it. If you find a secret that gets
through redaction, or any other security issue, please open a private security advisory on the
GitHub repository rather than a public issue.
