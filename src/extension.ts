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
  };
}

function statusOf(s: Session, now: number, activeSec: number, recentSec: number): Status {
  const ageSec = (now - s.mtimeMs) / 1000;
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

class SessionItem extends vscode.TreeItem {
  constructor(
    public readonly session: Session,
    status: Status,
    now: number,
    showFolder: boolean,
  ) {
    super(session.title, vscode.TreeItemCollapsibleState.None);
    this.id = session.file;
    this.contextValue = 'claudeSession';
    this.iconPath = iconFor(status);

    const rel = relativeTime(session.mtimeMs, now);
    const folderTag = showFolder ? ` · ${path.basename(session.folderPath)}` : '';
    this.description = `${rel}${folderTag}`;

    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${escapeMd(session.title)}**\n\n`);
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

class SessionsProvider implements vscode.TreeDataProvider<SessionItem> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(element: SessionItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: SessionItem): Promise<SessionItem[]> {
    if (element) {
      return [];
    }
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    if (folders.length === 0) {
      return [];
    }

    const cfg = getConfig();
    const sessions = await listSessions(folders, cfg.projectsDir);
    const now = Date.now();
    const showFolder = folders.length > 1;

    return sessions.map(
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

function resolveTarget(provider: SessionsProvider, view: vscode.TreeView<SessionItem>, arg?: SessionItem): SessionItem | undefined {
  if (arg instanceof SessionItem) {
    return arg;
  }
  return view.selection[0];
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
}

export function deactivate(): void {
  // Subscriptions are disposed by VS Code.
}
