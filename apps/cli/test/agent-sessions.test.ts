import type { BoxRecord, ExecResult, Provider } from '@agentbox/core';
import { describe, expect, it, vi } from 'vitest';
import { agentResumeArgs } from '../src/agent-sessions.js';

/**
 * Pure unit test: `agentResumeArgs` only calls `provider.exec` to read the
 * box's session pointers, so a stub provider that maps a command substring to
 * canned stdout exercises the contract without docker. The real in-box capture
 * (hooks -> pointer files) is covered by the e2e smoke.
 */
function fakeProvider(reads: Array<{ match: string; stdout: string }>): Provider {
  const exec = vi.fn(async (_box, argv: string[]): Promise<ExecResult> => {
    const script = argv.join(' ');
    const hit = reads.find((r) => script.includes(r.match));
    return { exitCode: 0, stdout: hit?.stdout ?? '', stderr: '' };
  });
  return { name: 'docker', exec } as unknown as Provider;
}

const box = {
  id: 'b1',
  name: 'smoke',
  container: 'agentbox-smoke',
  provider: 'docker',
} as BoxRecord;
const CLAUDE_ID = '11111111-2222-4333-8444-555555555555';

describe('agentResumeArgs', () => {
  it('resumes the exact claude session id from the pointer', async () => {
    const p = fakeProvider([{ match: 'claude-session', stdout: `${CLAUDE_ID}\n` }]);
    expect(await agentResumeArgs(p, box, 'claude')).toEqual(['--resume', CLAUDE_ID]);
  });

  it('returns null for claude when the pointer is empty or junk', async () => {
    expect(await agentResumeArgs(fakeProvider([]), box, 'claude')).toBeNull();
    const junk = fakeProvider([{ match: 'claude-session', stdout: 'not-a-uuid\n' }]);
    expect(await agentResumeArgs(junk, box, 'claude')).toBeNull();
  });

  it('resumes codex with --last only when the box has the active marker', async () => {
    const present = fakeProvider([{ match: 'codex-active', stdout: 'y' }]);
    expect(await agentResumeArgs(present, box, 'codex')).toEqual(['resume', '--last']);
    expect(await agentResumeArgs(fakeProvider([]), box, 'codex')).toBeNull();
  });

  it('treats an exec failure as nothing-to-resume (best-effort)', async () => {
    const p = {
      name: 'docker',
      exec: vi.fn(async () => {
        throw new Error('container not running');
      }),
    } as unknown as Provider;
    expect(await agentResumeArgs(p, box, 'claude')).toBeNull();
    expect(await agentResumeArgs(p, box, 'codex')).toBeNull();
  });
});
