/**
 * Integration test for the PTY drive harness — spawns `pnpm drive` against a
 * simple stdin-echoing Node program, sends keystrokes, reads back the
 * rendered screen, and asserts. Validates the harness as the automated
 * test surface for interactive flows (9.4); future tests for
 * `agentbox dashboard` / `claude attach` / etc. layer on this pattern.
 *
 * Skipped when `@homebridge/node-pty-prebuilt-multiarch` isn't installed
 * (CI without the prebuilt binary). Skipped on platforms where spawning
 * pnpm subprocesses isn't supported.
 */
import { execa } from 'execa';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

async function hasNodePty(): Promise<boolean> {
  try {
    await import('@homebridge/node-pty-prebuilt-multiarch');
    return true;
  } catch {
    return false;
  }
}

const hasPty = await hasNodePty();

describe.skipIf(!hasPty)('drive harness integration', () => {
  const sessionLabel = `harness-test-${Math.random().toString(36).slice(2, 8)}`;
  let sessionId: string | undefined;

  beforeAll(async () => {
    // Spawn a session running a tiny node program that echoes its stdin
    // line-by-line. Drive's `screen` then captures the rendered output.
    const inner = `process.stdin.on('data', (b) => process.stdout.write('echo: ' + b.toString()));`;
    const start = await execa(
      'pnpm',
      [
        'drive',
        'start',
        '--cols',
        '80',
        '--rows',
        '24',
        '--name',
        sessionLabel,
        '--',
        'node',
        '-e',
        inner,
      ],
      { cwd: REPO_ROOT, reject: false, timeout: 30_000 },
    );
    if (start.exitCode === 0) {
      sessionId = (start.stdout ?? '').trim().split('\n').pop()?.trim();
    }
  }, 35_000);

  afterAll(async () => {
    if (sessionId) {
      await execa('pnpm', ['drive', 'stop', sessionId], {
        cwd: REPO_ROOT,
        reject: false,
        timeout: 15_000,
      }).catch(() => {
        /* ignore */
      });
    }
  }, 20_000);

  it('start emits a usable session id', () => {
    expect(sessionId).toBeDefined();
    expect(sessionId).toMatch(new RegExp(sessionLabel));
  });

  it('send + screen round-trips a keystroke through the PTY', async () => {
    if (!sessionId) {
      throw new Error('no session id — beforeAll failed?');
    }
    await execa('pnpm', ['drive', 'send', sessionId, 'hello<Enter>'], {
      cwd: REPO_ROOT,
      reject: false,
      timeout: 10_000,
    });
    // Wait briefly for the echo to land in the terminal buffer, then snap
    // the screen and assert it contains the expected echo.
    const wait = await execa(
      'pnpm',
      ['drive', 'wait', sessionId, '--text', 'echo: hello', '--timeout', '5000'],
      { cwd: REPO_ROOT, reject: false, timeout: 10_000 },
    );
    expect(wait.exitCode, `wait stderr: ${wait.stderr}`).toBe(0);
    const screen = await execa('pnpm', ['drive', 'screen', sessionId], {
      cwd: REPO_ROOT,
      reject: false,
      timeout: 5_000,
    });
    expect(screen.exitCode).toBe(0);
    expect(screen.stdout).toMatch(/echo: hello/);
  });
});
