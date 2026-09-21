import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './env.js';
import { run } from './exec.js';

const TSX = join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const DRIVE = join(REPO_ROOT, 'apps', 'cli', 'test', '_harness', 'drive.ts');

/** The PTY harness needs the monorepo checkout (tsx + node-pty), so Mac targets only. */
export function driveAvailable(): boolean {
  return existsSync(TSX) && existsSync(DRIVE);
}

function drive(args: string[], log: string, allowFail = false) {
  return run(TSX, [DRIVE, ...args], { log, allowFail, timeoutMs: 120_000 });
}

/** A command running in a real PTY, rendered by a headless xterm. */
export class PtySession {
  private constructor(
    readonly id: string,
    private readonly log: string,
  ) {}

  static async start(opts: {
    name: string;
    cmd: string;
    args: string[];
    cwd: string;
    log: string;
    cols?: number;
    rows?: number;
  }): Promise<PtySession> {
    const r = await drive(
      [
        'start',
        '--json',
        '--name',
        opts.name,
        '--cwd',
        opts.cwd,
        '--cols',
        String(opts.cols ?? 140),
        '--rows',
        String(opts.rows ?? 45),
        '--',
        opts.cmd,
        ...opts.args,
      ],
      opts.log,
    );
    const { id } = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') as { id?: string };
    if (!id) throw new Error(`drive start returned no id: ${r.stdout}`);
    return new PtySession(id, opts.log);
  }

  async screen(): Promise<string> {
    return (await drive(['screen', this.id], this.log)).stdout;
  }

  /** Save the current screen for the report / judge. */
  async capture(path: string): Promise<string> {
    const text = await this.screen();
    writeFileSync(path, text);
    return text;
  }

  async send(keys: string): Promise<void> {
    await drive(['send', this.id, keys], this.log);
  }

  async waitFor(text: string, timeoutMs = 30_000): Promise<void> {
    const r = await drive(
      ['wait', this.id, '--text', text, '--timeout', String(timeoutMs)],
      this.log,
      true,
    );
    if (r.exitCode !== 0) {
      const screen = await this.screen().catch(() => '(session gone)');
      throw new Error(
        `"${text}" never appeared on screen within ${String(timeoutMs / 1000)}s. Screen:\n${screen}`,
      );
    }
  }

  async stop(): Promise<void> {
    await drive(['stop', this.id], this.log, true);
  }
}
