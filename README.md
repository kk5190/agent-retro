# agent-retro

**A monthly retrospective for your coding-agent sessions.** agent-retro reads the logs your agents
already write (Claude Code, Codex CLI, pi, opencode, Continue, Zed, Cursor) and shows what you work
on, where tokens, money and time go, what fills your context window, and what to change next.

Local only, zero dependencies (Node >= 18). Nothing is uploaded.

![Home: this month's verdict, the numbers, five areas with a status, and your next step](https://raw.githubusercontent.com/kk5190/agent-retro/main/docs/images/home.jpg)

## Quick start

```bash
npx agent-retro --demo --ui --open    # try it on synthetic sessions (never reads your logs)
npx agent-retro --ui --open           # your own Claude Code logs, in the browser
npx agent-retro                       # the same analysis as a terminal report
```

## What you get

- **Home:** a one-line verdict for the period, the numbers that matter, five areas (cost, context,
  reliability, prompting, setup) marked good, watch or act, and your next step with a fix to paste.
- **Review:** a monthly retrospective: went well, didn't go well, did last month's changes work,
  and one list of what to change, each change with evidence, a fix to paste and a metric to watch.
- **Context:** what fills your context window each session, item by item (tool results, MCP
  servers, skills, plugins, hooks, CLAUDE.md), and the biggest thing you can change.
- **Output:** what the agent writes, and your model, skills, MCP servers and plugins against how
  sessions went.
- **Cost:** spend per day, by task, model and project, and the costliest sessions.
- **Work, Setup, Habits, Sessions:** tasks, tool failures, edit habits, extensions loaded versus
  used, when you work, how you prompt, and every session to search.

Pick any period on the calendar: a week, a month, or any range. Each period is compared with the one
just before it.

![Context: where a session starts and grows, and every item that fills the window](https://raw.githubusercontent.com/kk5190/agent-retro/main/docs/images/context.jpg)

![Review: the numbered changes to make next, each with the metric to watch and a fix to paste](https://raw.githubusercontent.com/kk5190/agent-retro/main/docs/images/review-actions.jpg)

## For your agents

The same analysis is available to agents, so one can read how you work and suggest changes:

```bash
claude mcp add agent-retro -- npx -y agent-retro --mcp --all-agents   # MCP server (stdio)
npx agent-retro --export telemetry/                                    # redacted, versioned bundle
```

The MCP server offers `get_overview`, `get_retro`, `get_recommendations`, `get_context`,
`get_agent_output`, `get_extensions`, `list_sessions`, `get_session` and `get_task_profile`. Prompt
text is redacted by default; `--text none` exports numbers and labels only.

## Common flags

```bash
npx agent-retro --retro --md                      # this month's review as markdown
npx agent-retro --from 2026-09-01 --to 2026-09-14 # any range
npx agent-retro --all-agents                      # every agent on this machine
npx agent-retro --scan                            # which agent logs exist here
```

## More

- [The full guide](https://github.com/kk5190/agent-retro/blob/main/docs/guide.md): what each
  section measures, every recommendation, the review, privacy levels, supported agents and every flag.
- [Changelog](https://github.com/kk5190/agent-retro/blob/main/CHANGELOG.md) ·
  [Security](https://github.com/kk5190/agent-retro/blob/main/SECURITY.md) ·
  [Contributing](https://github.com/kk5190/agent-retro/blob/main/CONTRIBUTING.md)

**Status: 0.1, beta.** Task labels and thresholds were first tuned on one person's history; run
`--label-accuracy` after correcting a few labels to see how well they fit you.

MIT licensed.
