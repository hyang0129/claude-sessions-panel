# Claude Sessions Panel

A small VS Code extension that adds a **Claude Sessions** panel to the **secondary side bar**
(the right pane, where Copilot Chat normally lives), listing the Claude Code sessions for the
**current project** — with a live status dot, clickable to resume.

> Requires VS Code ≥ 1.106 (for the `secondarySidebar` view-container location). You can drag
> the container to any side bar; the right pane is just its default home.

It does **not** modify or fork the official Claude Code extension. It sits alongside it
as an independent companion view in the same window.

## What it shows

- One row per session **scoped to the open workspace folder(s)** — the same scoping the
  official extension uses. Claude Code stores transcripts under
  `~/.claude/projects/<encoded-cwd>/`, where the directory name is the project's absolute
  path with every non-alphanumeric character replaced by `-`. This extension encodes the
  workspace folder the same way and reads that directory.
- **Warp-style row**: a **headline** (Claude Code's generated `ai-title`, falling back to the
  first prompt) as the label, with a dimmed **trailing detail** snippet (most recent prompt)
  and relative time after it.
- **Recent / Archived groups** — sessions are ranked by last activity; the most-recently-active
  `recentCount` (default 5) sit in an expanded **Recent** group, the rest collapse into
  **Archived**. Grouping only appears once there's a backlog (more than `recentCount` sessions).
- **Status dot** (within Recent) based on last activity — the newest user/assistant message
  timestamp, not raw file mtime:
  - 🟢 active — last activity < 60s ago
  - 🟡 recent — last activity < 1h ago
  - ⚪ idle — older (and all Archived rows)
- **Description** = relative last-active time (and folder name in multi-root workspaces).
- **Tooltip** = session id, cwd, message count, last-active time.

## Actions

- **Click a row** → opens the session **in the official Claude Code extension panel**
  (via its `claude-vscode.editor.open` command, passing the session id). If that extension
  isn't installed, it falls back to a terminal `claude --resume`.
- **Resume in Terminal** (inline ▶ / right-click) → opens an integrated terminal and runs
  `claude --resume <id>` in the session's folder.
- **Right-click** → Open in Claude Code, Resume in Terminal, Open Transcript (JSONL),
  Reveal in Finder, Copy Session ID.
- **Refresh** button in the view title bar. The panel also auto-refreshes on transcript
  file changes and on a timer.

Set `claudeSessions.clickAction` to `resumeInTerminal` if you'd rather a click drop
straight into a terminal instead of the Claude panel.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `claudeSessions.clickAction` | `openInClaude` | Click behavior: `openInClaude` or `resumeInTerminal`. |
| `claudeSessions.claudeBinary` | `claude` | CLI used to resume a session in a terminal. |
| `claudeSessions.projectsDir` | `~/.claude/projects` | Override the Claude projects directory. |
| `claudeSessions.activeThresholdSeconds` | `60` | Age under which a session is "active". |
| `claudeSessions.recentThresholdSeconds` | `3600` | Age under which a session is "recent". |
| `claudeSessions.autoRefreshSeconds` | `15` | Status refresh interval (0 disables the timer). |
| `claudeSessions.groupSessions` | `true` | Split into Recent/Archived groups (once past `recentCount`). |
| `claudeSessions.recentCount` | `5` | How many most-recently-active sessions stay in Recent. |
| `claudeSessions.archiveAfterDays` | `0` | Also archive sessions older than N days (0 = off). |

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

- v0.1 — project-scoped session list, recency status, resume/open/reveal.
- v0.2 — click opens the session in the official Claude Code extension panel.
- v0.3 — panel defaults to the secondary side bar (right pane).
- v0.4 — Warp-style rows (headline + trailing detail).
- v0.5 — rank-based recency status with Recent/Archived grouping ([#1](https://github.com/hyang0129/claude-sessions-panel/issues/1)).

Possible next steps: live process-attached status (is a `claude` process bound to this
session right now), session search/filter, rename, and a "new session" launcher.

## License

MIT
