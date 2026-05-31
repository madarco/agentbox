import { describe, expect, it } from 'vitest';
import { buildCloudAttachInnerCommand } from '../src/commands/_cloud-attach.js';
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
  it('preserves the no-args fast path', () => {
    // Identical to the pre-args behaviour so an unchanged contract stays
    // wire-compatible with any caller that relied on the literal shape.
    expect(buildCloudAttachInnerCommand('claude')).toBe('bash -lc exec\\ claude');
    expect(buildCloudAttachInnerCommand('codex', [])).toBe('bash -lc exec\\ codex');
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
