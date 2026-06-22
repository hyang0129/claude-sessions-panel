import * as path from 'path';
import * as vscode from 'vscode';
import { getProjectsDir, listSessions, Session } from './sessions';

type Status = 'active' | 'recent' | 'idle';

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('claudeSessions');
  return {
    clickAction: cfg.get<'openInClaude' | 'resumeInTerminal'>('clickAction', 'openInClaude'),
    claudeBinary: cfg.get<string>('claudeBinary', 'claude'),
    projectsDir: getProjectsDir(cfg.get<string>('projectsDir', '')),
    activeThresholdSeconds: cfg.get<number>('activeThresholdSeconds', 60),
    recentThresholdSeconds: cfg.get<number>('recentThresholdSeconds', 3600),
    autoRefreshSeconds: cfg.get<number>('autoRefreshSeconds', 15),
    groupSessions: cfg.get<boolean>('groupSessions', true),
    recentCount: cfg.get<number>('recentCount', 5),
    archiveAfterDays: cfg.get<number>('archiveAfterDays', 0),
  };
}

function statusOf(s: Session, now: number, activeSec: number, recentSec: number): Status {
  const ageSec = (now - s.lastActivityMs) / 1000;
  if (ageSec <= activeSec) {
    return 'active';
  }
  if (ageSec <= recentSec) {
    return 'recent';
  }
  return 'idle';
}

function iconFor(status: Status): vscode.ThemeIcon {
  switch (status) {
    case 'active':
      return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
    case 'recent':
      return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.yellow'));
    default:
      return new vscode.ThemeIcon('circle-outline');
  }
}

function relativeTime(ms: number, now: number): string {
  const sec = Math.max(0, Math.round((now - ms) / 1000));
  if (sec < 60) {
    return `${sec}s ago`;
  }
  const min = Math.round(sec / 60);
  if (min < 60) {
    return `${min}m ago`;
  }
  const hr = Math.round(min / 60);
  if (hr < 24) {
    return `${hr}h ago`;
  }
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

/** A prompt snippet that adds information beyond the headline (Warp-style detail). */
function pickDetail(s: Session): string | undefined {
  const headline = s.title.trim();
  for (const cand of [s.lastPrompt, s.firstPrompt]) {
    const c = cand?.trim();
    if (c && c !== headline) {
      return c;
    }
  }
  return undefined;
}

class SessionItem extends vscode.TreeItem {
  constructor(
    public readonly session: Session,
    status: Status,
    now: number,
    showFolder: boolean,
  ) {
    super(truncate(session.title, 72), vscode.TreeItemCollapsibleState.None);
    this.id = session.file;
    this.contextValue = 'claudeSession';
    this.iconPath = iconFor(status);

    const rel = relativeTime(session.lastActivityMs, now);
    const folderTag = showFolder ? ` · ${path.basename(session.folderPath)}` : '';
    // Warp-style: prominent headline (label) + dimmed trailing detail (description).
    const detail = pickDetail(session);
    const detailPart = detail ? `${truncate(detail, 64)}  ·  ` : '';
    this.description = `${detailPart}${rel}${folderTag}`;

    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${escapeMd(session.title)}**\n\n`);
    if (session.aiTitle && session.firstPrompt) {
      md.appendMarkdown(`- First prompt: ${escapeMd(truncate(session.firstPrompt, 160))}\n`);
    }
    if (session.lastPrompt && session.lastPrompt.trim() !== session.title.trim()) {
      md.appendMarkdown(`- Last prompt: ${escapeMd(truncate(session.lastPrompt, 160))}\n`);
    }
    md.appendMarkdown(`- Status: ${status}\n`);
    md.appendMarkdown(`- Last active: ${rel}\n`);
    md.appendMarkdown(`- Messages: ${session.messageCount}\n`);
    md.appendMarkdown(`- Session: \`${session.id}\`\n`);
    if (session.cwd) {
      md.appendMarkdown(`- cwd: \`${session.cwd}\`\n`);
    }
    this.tooltip = md;

    this.command = {
      command: 'claudeSessions._click',
      title: 'Open',
      arguments: [this],
    };
  }
}

function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!]/g, (c) => `\\${c}`);
}

class GroupItem extends vscode.TreeItem {
  constructor(
    label: string,
    public readonly sessions: Session[],
    public readonly kind: 'recent' | 'archived',
    expanded: boolean,
    public readonly showFolder: boolean,
  ) {
    super(
      label,
      expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.id = `group:${kind}`;
    this.description = `${sessions.length}`;
    this.contextValue = 'claudeGroup';
    this.iconPath = new vscode.ThemeIcon(kind === 'recent' ? 'pulse' : 'archive');
  }
}

type TreeNode = GroupItem | SessionItem;

class SessionsProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    const cfg = getConfig();
    const now = Date.now();

    // Expanding a group → its sessions. Archived rows get a muted (idle) dot;
    // Recent rows keep the fine-grained active/recent/idle status.
    if (element instanceof GroupItem) {
      return element.sessions.map(
        (s) =>
          new SessionItem(
            s,
            element.kind === 'archived'
              ? 'idle'
              : statusOf(s, now, cfg.activeThresholdSeconds, cfg.recentThresholdSeconds),
            now,
            element.showFolder,
          ),
      );
    }
    if (element instanceof SessionItem) {
      return [];
    }

    // Root.
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    if (folders.length === 0) {
      return [];
    }
    const sessions = await listSessions(folders, cfg.projectsDir);
    if (sessions.length === 0) {
      return [];
    }
    const showFolder = folders.length > 1;

    // Rank-based split: the most-recently-active `recentCount` form the working set;
    // anything past that is archived (you've probably moved on). See issue #1.
    const n = Math.max(0, cfg.recentCount);
    let recent = sessions.slice(0, n);
    let archived = sessions.slice(n);

    // Optional absolute-age cap: demote stale sessions out of Recent regardless of rank.
    if (cfg.archiveAfterDays > 0) {
      const cutoff = now - cfg.archiveAfterDays * 86_400_000;
      const keep: Session[] = [];
      const demote: Session[] = [];
      for (const s of recent) {
        (s.lastActivityMs >= cutoff ? keep : demote).push(s);
      }
      recent = keep;
      archived = [...demote, ...archived]; // demoted are newer than the rest → preserves desc order
    }

    // Only introduce group headers when there's actually a backlog to archive.
    if (cfg.groupSessions && archived.length > 0) {
      const groups: TreeNode[] = [];
      if (recent.length > 0) {
        groups.push(new GroupItem('Recent', recent, 'recent', true, showFolder));
      }
      groups.push(new GroupItem('Archived', archived, 'archived', false, showFolder));
      return groups;
    }

    // Flat list (small project, or grouping disabled).
    const flat = cfg.groupSessions ? [...recent, ...archived] : sessions;
    return flat.map(
      (s) =>
        new SessionItem(
          s,
          statusOf(s, now, cfg.activeThresholdSeconds, cfg.recentThresholdSeconds),
          now,
          showFolder,
        ),
    );
  }
}

function resolveTarget(provider: SessionsProvider, view: vscode.TreeView<TreeNode>, arg?: TreeNode): SessionItem | undefined {
  if (arg instanceof SessionItem) {
    return arg;
  }
  const sel = view.selection[0];
  return sel instanceof SessionItem ? sel : undefined;
}

/**
 * The official Claude Code extension registers this command as
 * editor.open(sessionId, initialPrompt?, viewColumn?). Passing an existing
 * session id routes through its createPanel(), which reveals an already-open
 * panel or builds the webview for that id — i.e. resumes the conversation.
 */
const CLAUDE_OPEN_COMMAND = 'claude-vscode.editor.open';

function resumeInTerminal(item: SessionItem): void {
  const cfg = getConfig();
  const cwd = item.session.cwd || item.session.folderPath;
  const term = vscode.window.createTerminal({
    name: `Claude: ${item.session.title.slice(0, 24)}`,
    cwd,
  });
  term.show();
  term.sendText(`${cfg.claudeBinary} --resume ${item.session.id}`);
}

async function openInClaude(item: SessionItem): Promise<void> {
  const available = await vscode.commands.getCommands(true);
  if (available.includes(CLAUDE_OPEN_COMMAND)) {
    await vscode.commands.executeCommand(CLAUDE_OPEN_COMMAND, item.session.id);
  } else {
    vscode.window.showWarningMessage(
      `Claude Code extension command "${CLAUDE_OPEN_COMMAND}" not found — resuming in a terminal instead.`,
    );
    resumeInTerminal(item);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new SessionsProvider();
  const view = vscode.window.createTreeView('claudeSessions.list', {
    treeDataProvider: provider,
    showCollapseAll: false,
  });
  context.subscriptions.push(view);

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeSessions.refresh', () => provider.refresh()),

    vscode.commands.registerCommand('claudeSessions._click', (arg?: SessionItem) => {
      const item = resolveTarget(provider, view, arg);
      if (!item) {
        return;
      }
      if (getConfig().clickAction === 'resumeInTerminal') {
        resumeInTerminal(item);
      } else {
        void openInClaude(item);
      }
    }),

    vscode.commands.registerCommand('claudeSessions.open', (arg?: SessionItem) => {
      const item = resolveTarget(provider, view, arg);
      if (item) {
        void openInClaude(item);
      } else {
        vscode.window.showInformationMessage('No Claude session selected.');
      }
    }),

    vscode.commands.registerCommand('claudeSessions.resumeInTerminal', (arg?: SessionItem) => {
      const item = resolveTarget(provider, view, arg);
      if (item) {
        resumeInTerminal(item);
      } else {
        vscode.window.showInformationMessage('No Claude session selected.');
      }
    }),

    vscode.commands.registerCommand('claudeSessions.openTranscript', (arg?: SessionItem) => {
      const item = resolveTarget(provider, view, arg);
      if (item) {
        vscode.window.showTextDocument(vscode.Uri.file(item.session.file));
      }
    }),

    vscode.commands.registerCommand('claudeSessions.revealInFinder', (arg?: SessionItem) => {
      const item = resolveTarget(provider, view, arg);
      if (item) {
        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(item.session.file));
      }
    }),

    vscode.commands.registerCommand('claudeSessions.copySessionId', async (arg?: SessionItem) => {
      const item = resolveTarget(provider, view, arg);
      if (item) {
        await vscode.env.clipboard.writeText(item.session.id);
        vscode.window.showInformationMessage(`Copied session id: ${item.session.id}`);
      }
    }),
  );

  // Refresh when transcripts for the open folders change.
  const cfg = getConfig();
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(cfg.projectsDir), '**/*.jsonl'),
    );
    watcher.onDidChange(() => provider.refresh());
    watcher.onDidCreate(() => provider.refresh());
    watcher.onDidDelete(() => provider.refresh());
    context.subscriptions.push(watcher);
    break; // One watcher covers the whole projects dir.
  }

  // Periodic refresh so recency status (active → recent → idle) stays current.
  if (cfg.autoRefreshSeconds > 0) {
    const timer = setInterval(() => provider.refresh(), cfg.autoRefreshSeconds * 1000);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
  }

  // Re-list when folders change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refresh()),
  );

  // Re-render when our settings change (grouping, recentCount, thresholds, …).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeSessions')) {
        provider.refresh();
      }
    }),
  );
}

export function deactivate(): void {
  // Subscriptions are disposed by VS Code.
}
