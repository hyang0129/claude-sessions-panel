# Claude Sessions Panel

A small VS Code extension that adds a **Claude Sessions** panel to the activity bar,
listing the Claude Code sessions for the **current project** — with a live status dot,
clickable to resume.

It does **not** modify or fork the official Claude Code extension. It sits alongside it
as an independent companion view in the same window.

## What it shows

- One row per session **scoped to the open workspace folder(s)** — the same scoping the
  official extension uses. Claude Code stores transcripts under
  `~/.claude/projects/<encoded-cwd>/`, where the directory name is the project's absolute
  path with every non-alphanumeric character replaced by `-`. This extension encodes the
  workspace folder the same way and reads that directory.
- **Title** = the session's first real user prompt.
- **Status dot** based on transcript activity:
  - 🟢 active — modified in the last 60s
  - 🟡 recent — modified in the last hour
  - ⚪ idle — older
- **Description** = relative last-active time (and folder name in multi-root workspaces).
- **Tooltip** = session id, cwd, message count, last-active time.

## Actions

- **Click a row** → opens an integrated terminal and runs `claude --resume <id>` in the
  session's folder.
- **Right-click** → Open Transcript (JSONL), Reveal in Finder, Copy Session ID.
- **Refresh** button in the view title bar. The panel also auto-refreshes on transcript
  file changes and on a timer.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `claudeSessions.claudeBinary` | `claude` | CLI used to resume a session. |
| `claudeSessions.projectsDir` | `~/.claude/projects` | Override the Claude projects directory. |
| `claudeSessions.activeThresholdSeconds` | `60` | Age under which a session is "active". |
| `claudeSessions.recentThresholdSeconds` | `3600` | Age under which a session is "recent". |
| `claudeSessions.autoRefreshSeconds` | `15` | Status refresh interval (0 disables the timer). |

## Develop

```bash
npm install
npm run build      # one-shot bundle to dist/
npm run watch      # rebuild on change
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host with the panel loaded.

## Package / install

```bash
npm run package                       # produces claude-sessions-panel-<version>.vsix
code --install-extension claude-sessions-panel-*.vsix
```

## Status / roadmap

v0.1 — project-scoped session list, recency status, resume/open/reveal.

Possible next steps: live process-attached status (is a `claude` process bound to this
session right now), session search/filter, rename, and a "new session" launcher.

## License

MIT
