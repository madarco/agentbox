import { describe, expect, it } from 'vitest';
import type { BoxRecord, ExecResult, Provider } from '@agentbox/core';
import {
  buildCloudAttachInnerCommand,
  verifyDetachedSession,
} from '../src/commands/_cloud-attach.js';
import { buildPromptArgs } from '../src/lib/queue/build-prompt-args.js';

/**
 * The launcher embeds args as base64. To verify the round-trip we extract the
 * blob from the command string and `Buffer.from(blob, 'base64')` it back.
 *
 * This *doesn't* run the launcher in a real shell — it only checks the
 * encoding/decoding contract. The actual SSH→tmux→bash plumbing is exercised
 * by the e2e tests against a Daytona sandbox.
 */
function decodeArgs(cmd: string): string[] {
  const m = /echo ([A-Za-z0-9+/=]+) \| base64 -d/.exec(cmd);
  if (!m) throw new Error(`launcher did not embed a base64 blob: ${cmd}`);
  const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
  return decoded.length === 0 ? [] : decoded.split('\n');
}

describe('buildCloudAttachInnerCommand', () => {
  it('runs the start banner then execs the agent on the no-args path', () => {
    // The pane prints a "starting" line before the agent paints (so a cold
    // cloud attach is never blank), then `exec`s the binary so it keeps PID 2.
    const cmd = buildCloudAttachInnerCommand('claude');
    expect(cmd).toBe(
      `bash -lc 'printf "  agentbox: starting claude (first paint may take a few seconds)...\\r\\n"; exec claude'`,
    );
    expect(buildCloudAttachInnerCommand('codex', [])).toContain('exec codex');
  });

  it('prints the start banner before the agent on the args path too', () => {
    const cmd = buildCloudAttachInnerCommand('claude', ['--model', 'sonnet']);
    expect(cmd).toContain('agentbox: starting claude');
    // banner must precede the mapfile launcher so it paints during cold-start.
    expect(cmd.indexOf('agentbox: starting')).toBeLessThan(cmd.indexOf('mapfile -t A'));
  });

  it('encodes a single simple arg', () => {
    const cmd = buildCloudAttachInnerCommand('claude', ['--model', 'sonnet']);
    expect(cmd).toContain('mapfile -t A');
    expect(cmd).toContain('exec claude');
    expect(decodeArgs(cmd)).toEqual(['--model', 'sonnet']);
  });

  it('decodes via a here-string, not process substitution', () => {
    // Process substitution (`< <(…)`) needs /dev/fd, which the Vercel Sandbox
    // lacks — the launcher must use a here-string so the args survive there.
    const cmd = buildCloudAttachInnerCommand('claude', ['--model', 'sonnet']);
    expect(cmd).toContain('mapfile -t A <<< "$(');
    expect(cmd).not.toContain('< <(');
  });

  it('preserves args with spaces as a single element', () => {
    // `-p "hello world"` — the user wants `hello world` to reach claude as a
    // single argv element, not split into two by intermediate shells. Base64
    // is opaque to every shell-quote layer so this works without escaping.
    const args = ['-p', 'hello world'];
    const cmd = buildCloudAttachInnerCommand('claude', args);
    expect(decodeArgs(cmd)).toEqual(args);
  });

  it('preserves args with embedded single-quotes', () => {
    // `it's` would be the classic 3-layer-quoting pain point; base64 makes
    // it a non-issue.
    const args = ['-p', "it's working"];
    const cmd = buildCloudAttachInnerCommand('claude', args);
    expect(decodeArgs(cmd)).toEqual(args);
  });

  it('preserves args with double-quotes and dollar signs', () => {
    const args = ['-p', 'say "$HOME"', '--dry-run'];
    const cmd = buildCloudAttachInnerCommand('codex', args);
    expect(decodeArgs(cmd)).toEqual(args);
  });

  it('uses the same binary name in the exec line', () => {
    expect(buildCloudAttachInnerCommand('opencode', ['-m', 'gpt-5'])).toContain('exec opencode');
    expect(buildCloudAttachInnerCommand('codex', ['-m', 'gpt-5'])).toContain('exec codex');
  });

  // Contract the cloud `-i` queue worker (runCloudJob) depends on: it builds
  // the launcher args via `buildPromptArgs(prompt, userArgs)` and hands them to
  // `cloudAgentStartDetached` → `buildCloudAttachInnerCommand`. The seed prompt
  // must land as the first positional and post-`--` args (e.g.
  // `--permission-mode=plan`) must be forwarded verbatim.
  it('forwards a seeded prompt + custom args through the launcher in order', () => {
    const args = buildPromptArgs('claude-code', 'fix the failing test', ['--permission-mode=plan']);
    const cmd = buildCloudAttachInnerCommand('claude', args);
    expect(decodeArgs(cmd)).toEqual(['fix the failing test', '--permission-mode=plan']);
  });
});

/**
 * `verifyDetachedSession` is what turns a silent cloud `-i` failure (box created,
 * job reports "done", but the seeded agent session never came up) into a thrown,
 * surfaced error. A fake provider drives the `tmux has-session`/`capture-pane`
 * probe so we exercise the three outcomes without a real sandbox.
 */
describe('verifyDetachedSession', () => {
  const box = { name: 'kanban-buttons' } as BoxRecord;
  const fakeProvider = (exec: (argv: string[]) => ExecResult): Provider =>
    ({ exec: (_b: BoxRecord, argv: string[]) => Promise.resolve(exec(argv)) }) as unknown as Provider;

  it('throws "exited immediately" when the session is gone (probe exits 7)', async () => {
    const provider = fakeProvider(() => ({ exitCode: 7, stdout: '', stderr: '' }));
    await expect(
      verifyDetachedSession(provider, box, 'claude', 'claude', { windowMs: 0 }),
    ).rejects.toThrow(/exited immediately after launch/);
  });

  it('throws an actionable login hint when the pane shows an auth rejection', async () => {
    const provider = fakeProvider(() => ({
      exitCode: 0,
      stdout: '❯ build a kanban board\n● Please run /login · API Error: 401 Invalid authentication credentials',
      stderr: '',
    }));
    await expect(
      verifyDetachedSession(provider, box, 'claude', 'claude', { windowMs: 0 }),
    ).rejects.toThrow(/credentials were rejected.*agentbox claude login/s);
  });

  it('resolves for a live, authenticated session', async () => {
    const provider = fakeProvider(() => ({
      exitCode: 0,
      stdout: '❯ build a kanban board\n● Working on it...',
      stderr: '',
    }));
    await expect(
      verifyDetachedSession(provider, box, 'claude', 'claude', { windowMs: 0 }),
    ).resolves.toBeUndefined();
  });

  it('does not false-fail on a transient probe error (keeps polling)', async () => {
    let calls = 0;
    const provider = fakeProvider(() => {
      calls++;
      if (calls === 1) throw new Error('transport blip');
      return { exitCode: 0, stdout: 'all good', stderr: '' };
    });
    // windowMs large enough for a second tick; pollMs tiny so the test is fast.
    await expect(
      verifyDetachedSession(provider, box, 'claude', 'claude', { windowMs: 30, pollMs: 1 }),
    ).resolves.toBeUndefined();
    expect(calls).toBeGreaterThan(1);
  });
});
