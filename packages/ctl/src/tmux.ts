import { spawn } from 'node:child_process';
import type { ClaudeSessionStatus } from './types.js';

interface ToolResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runTool(cmd: string, args: string[]): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => (stdout += b.toString('utf8')));
    child.stderr.on('data', (b: Buffer) => (stderr += b.toString('utf8')));
    child.on('error', () => resolve({ exitCode: 127, stdout, stderr }));
    child.on('close', (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
}

/**
 * Probe the in-box tmux session running Claude Code. The daemon runs as
 * `vscode` inside the box, the same user that owns the tmux server socket
 * under /tmp/tmux-1000/. A missing tmux server, missing session, or
 * tmux-not-installed all surface uniformly as `running: false`.
 *
 * Shared by the `claude-session` wire op (socket.ts) and the status reporter
 * so both report the same thing.
 */
export async function probeClaudeSession(sessionName: string): Promise<ClaudeSessionStatus> {
  const has = await runTool('tmux', ['has-session', '-t', sessionName]);
  if (has.exitCode !== 0) return { running: false, sessionName, startedAt: null };
  const ts = await runTool('tmux', [
    'display-message',
    '-p',
    '-t',
    sessionName,
    '#{session_created}',
  ]);
  let startedAt: string | null = null;
  if (ts.exitCode === 0) {
    const secs = Number.parseInt(ts.stdout.trim(), 10);
    if (Number.isFinite(secs) && secs > 0) startedAt = new Date(secs * 1000).toISOString();
  }
  return { running: true, sessionName, startedAt };
}
