import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { BoxRecord, ExecResult, Provider } from '@agentbox/core';
import {
  buildCloudAttachInnerCommand,
  verifyDetachedSession,
} from '../src/commands/_cloud-attach.js';
import { buildPromptArgs } from '../src/lib/queue/build-prompt-args.js';
import { resolveAgentSpec } from '@agentbox/sandbox-core';

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
  // Two layers: the outer blob decodes to newline-joined per-arg base64 tokens;
  // each token decodes to one argv element (so a newline inside an arg is never
  // mistaken for an argv separator). Mirrors the in-box read-loop launcher.
  const payload = Buffer.from(m[1]!, 'base64').toString('utf8');
  if (payload.length === 0) return [];
  return payload.split('\n').map((t) => Buffer.from(t, 'base64').toString('utf8'));
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
    // banner must precede the read-loop launcher so it paints during cold-start.
    expect(cmd.indexOf('agentbox: starting')).toBeLessThan(cmd.indexOf('while IFS= read -r t'));
  });

  it('encodes a single simple arg', () => {
    const cmd = buildCloudAttachInnerCommand('claude', ['--model', 'sonnet']);
    expect(cmd).toContain('while IFS= read -r t');
    expect(cmd).toContain('exec claude');
    expect(decodeArgs(cmd)).toEqual(['--model', 'sonnet']);
  });

  it('decodes via a here-string, not process substitution', () => {
    // Process substitution (`< <(…)`) needs /dev/fd, which the Vercel Sandbox
    // lacks — the launcher must use a here-string so the args survive there.
    const cmd = buildCloudAttachInnerCommand('claude', ['--model', 'sonnet']);
    expect(cmd).toContain('done <<< "$(');
    expect(cmd).not.toContain('< <(');
  });

  it('preserves a multi-line seed prompt as a single argv element', () => {
    // The `-i` queue's common case: a multi-paragraph prompt. The earlier
    // newline-join + `mapfile -t` scheme shredded it into one positional per
    // line, so claude/codex got N positionals and the detached session died at
    // launch (verifyDetachedSession then failed the job). Per-arg encoding keeps
    // the whole prompt as one argv element.
    const prompt = 'Build a kanban board.\n\nRequirements:\n- drag and drop\n- columns';
    const args = buildPromptArgs('claude-code', prompt, ['--permission-mode=plan']);
    const cmd = buildCloudAttachInnerCommand('claude', args);
    expect(decodeArgs(cmd)).toEqual([prompt, '--permission-mode=plan']);
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
    const cmd = buildCloudAttachInnerCommand('claude', args);
    expect(decodeArgs(cmd)).toEqual(args);
  });

  it("prepends the agent's declared launchFlags, before its own args", () => {
    // Codex will not load the hooks.json its `seeds` declaration places without
    // these. The cloud launcher used to run the bare binary, so a cloud codex
    // box could not have loaded them even once the file was seeded.
    //
    // Order matters and is not cosmetic: codex's `resume` is a SUBCOMMAND, so a
    // global flag appended after it is rejected.
    const flags = resolveAgentSpec('codex').launchFlags ?? [];
    expect(flags.length).toBeGreaterThan(0);
    expect(decodeArgs(buildCloudAttachInnerCommand('codex', ['resume', '--last']))).toEqual([
      ...flags,
      'resume',
      '--last',
    ]);
    // Declared per agent, so the ones that need nothing get nothing.
    expect(decodeArgs(buildCloudAttachInnerCommand('claude', ['-p', 'hi']))).toEqual(['-p', 'hi']);
    expect(decodeArgs(buildCloudAttachInnerCommand('opencode', ['-m', 'x']))).toEqual(['-m', 'x']);
  });

  it('launches an agent with launchFlags but no args through the argv path', () => {
    // The no-args shortcut is `exec <binary>` with nothing appended — which
    // would silently drop the flags. Codex has to take the encoded-argv branch.
    const cmd = buildCloudAttachInnerCommand('codex', []);
    expect(decodeArgs(cmd)).toEqual(resolveAgentSpec('codex').launchFlags);
    // …while an agent with no launchFlags keeps the cheap shortcut.
    expect(buildCloudAttachInnerCommand('claude', [])).toContain('exec claude');
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
  /**
   * The renderer pin (`box.claudeTui`) rides the launch command on every
   * provider, rather than /etc/agentbox/box.env. box.env only reaches processes
   * that go through a login shell — true for THIS launcher, false for the
   * docker path's `tmux new-session 'claude …'` — so carrying it two different
   * ways was how the docker agent silently kept the old renderer.
   */
  it('exports the renderer env before exec, on the no-args path', () => {
    const cmd = buildCloudAttachInnerCommand('claude', undefined, {
      CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
    });
    expect(cmd).toContain('export CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN="1"; ');
    // Must be set before the agent replaces the shell, and after the banner.
    expect(cmd.indexOf('export CLAUDE_CODE_')).toBeLessThan(cmd.indexOf('exec claude'));
    expect(cmd.indexOf('agentbox: starting')).toBeLessThan(cmd.indexOf('export CLAUDE_CODE_'));
  });

  it('exports the renderer env on the args path too', () => {
    const cmd = buildCloudAttachInnerCommand('claude', ['--model', 'sonnet'], {
      CLAUDE_CODE_NO_FLICKER: '1',
    });
    expect(cmd).toContain('export CLAUDE_CODE_NO_FLICKER="1"; ');
    expect(cmd.indexOf('export CLAUDE_CODE_')).toBeLessThan(cmd.indexOf('while IFS= read -r t'));
    // …and the args still survive the base64 round-trip unchanged.
    expect(decodeArgs(cmd)).toEqual(['--model', 'sonnet']);
  });

  it('adds nothing when no env is given (auto, or a non-claude agent)', () => {
    expect(buildCloudAttachInnerCommand('codex', [], {})).not.toContain('export ');
    expect(buildCloudAttachInnerCommand('claude')).not.toContain('export ');
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
    ({
      exec: (_b: BoxRecord, argv: string[]) => Promise.resolve(exec(argv)),
    }) as unknown as Provider;

  it('throws "exited immediately" when the session is gone (probe exits 7)', async () => {
    const provider = fakeProvider(() => ({ exitCode: 7, stdout: '', stderr: '' }));
    await expect(
      verifyDetachedSession(provider, box, 'claude', 'claude', { windowMs: 0 }),
    ).rejects.toThrow(/exited immediately after launch/);
  });

  it('throws an actionable login hint when the pane shows an auth rejection', async () => {
    const provider = fakeProvider(() => ({
      exitCode: 0,
      stdout:
        '❯ build a kanban board\n● Please run /login · API Error: 401 Invalid authentication credentials',
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

/**
 * The attach-time resume gate. It was a literal `mode === 'claude' || mode ===
 * 'codex'`, so a later resumable agent came back from a stop or a cloud idle
 * timeout with a FRESH session instead of its conversation — while the detached
 * start path in the same file already gated on `caps.resume`. One declaration,
 * both paths.
 */
describe('the resume gate is caps.resume, not a name list', () => {
  it('agrees with the registry for every agent, including a fourth', () => {
    const src = readFileSync(new URL('../src/commands/_cloud-attach.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/args\.mode === 'claude' \|\| args\.mode === 'codex'/);
    expect(src).toContain('resolveAgentSpec(args.mode).caps.resume');
  });

  it('and the registry still says which agents those are', () => {
    expect(resolveAgentSpec('claude').caps.resume).toBe(true);
    expect(resolveAgentSpec('codex').caps.resume).toBe(true);
    expect(resolveAgentSpec('opencode').caps.resume).toBe(false);
  });
});
