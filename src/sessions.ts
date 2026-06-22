import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface Session {
  /** Session UUID (the .jsonl basename). */
  id: string;
  /** Absolute path to the transcript .jsonl. */
  file: string;
  /** Absolute path of the workspace folder this session was scoped under. */
  folderPath: string;
  /** cwd recorded inside the transcript, if any (may be a subfolder of folderPath). */
  cwd?: string;
  /** Headline shown as the row label: the AI-generated title if present, else the first prompt. */
  title: string;
  /** Claude Code's generated session title (`ai-title` record), if any. */
  aiTitle?: string;
  /** First real user prompt of the session. */
  firstPrompt?: string;
  /** Most recent user prompt (`last-prompt` record, else last user message). */
  lastPrompt?: string;
  /** Count of user + assistant turns. */
  messageCount: number;
  /** Last-modified time of the transcript (ms since epoch). */
  mtimeMs: number;
}

/**
 * Claude Code stores per-project session transcripts under
 * ~/.claude/projects/<encoded-cwd>/. The directory name is the project's
 * absolute path with every non-alphanumeric character replaced by '-'
 * (so '/' and '.' both become '-'). Encoding the workspace folder the same
 * way reproduces exactly the directory the official extension reads from.
 */
export function encodeProjectPath(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9]/g, '-');
}

export function getProjectsDir(override?: string): string {
  if (override && override.trim()) {
    return override.replace(/^~(?=$|\/)/, os.homedir());
  }
  return path.join(os.homedir(), '.claude', 'projects');
}

export function sessionDirForFolder(folderPath: string, projectsDir: string): string {
  return path.join(projectsDir, encodeProjectPath(folderPath));
}

function extractText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && (b as any).type === 'text' && typeof (b as any).text === 'string')
      .map((b) => (b as any).text as string)
      .join(' ');
  }
  return '';
}

/**
 * Parse a transcript for display metadata. Reads the file once and scans
 * line-by-line — records are not positionally fixed (line 0 may be a
 * queue-operation with no cwd/message), so we look for the first genuine
 * user prompt and the first recorded cwd.
 */
async function parseTranscript(
  file: string,
  folderPath: string,
  mtimeMs: number,
): Promise<Session> {
  const id = path.basename(file, '.jsonl');
  let firstPrompt = '';
  let aiTitle: string | undefined;
  let lastPrompt: string | undefined;
  let cwd: string | undefined;
  let messageCount = 0;

  let raw = '';
  try {
    raw = await fs.promises.readFile(file, 'utf8');
  } catch {
    // Unreadable transcript: fall back to id as title.
    return { id, file, folderPath, title: id.slice(0, 8), messageCount: 0, mtimeMs };
  }

  for (const line of raw.split('\n')) {
    if (!line) {
      continue;
    }
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (!cwd && typeof obj.cwd === 'string') {
      cwd = obj.cwd;
    }

    // Claude Code's generated title — multiple records may exist; the last wins.
    if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string' && obj.aiTitle.trim()) {
      aiTitle = obj.aiTitle.trim();
    }

    // Most recent prompt — last record wins.
    if (obj.type === 'last-prompt' && typeof obj.lastPrompt === 'string') {
      const t = obj.lastPrompt.trim();
      if (t && !t.startsWith('<')) {
        lastPrompt = t.replace(/\s+/g, ' ');
      }
    }

    if (obj.type === 'user' || obj.type === 'assistant') {
      messageCount++;
    }

    if (!firstPrompt && obj.type === 'user' && obj.message && obj.message.role === 'user' && !obj.isMeta) {
      const content = obj.message.content;
      // Skip tool results — those are user-role records carrying tool output.
      const isToolResult =
        Array.isArray(content) && content.some((b: any) => b && b.type === 'tool_result');
      if (!isToolResult) {
        const text = extractText(content).trim();
        // Skip system-reminder / command wrapper messages, which start with '<'.
        if (text && !text.startsWith('<')) {
          firstPrompt = text.replace(/\s+/g, ' ').slice(0, 200);
        }
      }
    }
  }

  const title = aiTitle || firstPrompt || `(no prompt) ${id.slice(0, 8)}`;

  return {
    id,
    file,
    folderPath,
    cwd,
    title,
    aiTitle,
    firstPrompt: firstPrompt || undefined,
    lastPrompt,
    messageCount,
    mtimeMs,
  };
}

/**
 * List all Claude Code sessions scoped to the given workspace folders,
 * newest first. Folders with no session directory contribute nothing.
 */
export async function listSessions(
  folderPaths: string[],
  projectsDir: string,
): Promise<Session[]> {
  const sessions: Session[] = [];

  for (const folderPath of folderPaths) {
    const dir = sessionDirForFolder(folderPath, projectsDir);
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // No sessions recorded for this folder.
    }

    const parsed = await Promise.all(
      entries
        .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
        .map(async (e) => {
          const file = path.join(dir, e.name);
          let mtimeMs = 0;
          try {
            mtimeMs = (await fs.promises.stat(file)).mtimeMs;
          } catch {
            return null;
          }
          return parseTranscript(file, folderPath, mtimeMs);
        }),
    );

    for (const s of parsed) {
      if (s) {
        sessions.push(s);
      }
    }
  }

  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sessions;
}
