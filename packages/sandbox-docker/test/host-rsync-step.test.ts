import { describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { hostRsyncStep } from '../src/sync/agents/shared.js';

/**
 * Runs `step && echo after` under `sh` with `rsync` stubbed by a shell function
 * that exits `rc`, so the test exercises the real shell logic without rsync.
 */
async function runWithRsyncExit(rc: number): Promise<{ exitCode: number; stdout: string }> {
  const script = `rsync() { echo "rsync $*"; return ${String(rc)}; }; ${hostRsyncStep('--exclude=x /src/ /dst/')} && echo after`;
  const r = await execa('sh', ['-c', script], { reject: false });
  return { exitCode: r.exitCode ?? -1, stdout: String(r.stdout) };
}

describe('hostRsyncStep', () => {
  it('puts --no-specials after -a, which would otherwise re-enable it', () => {
    expect(hostRsyncStep('/src/ /dst/')).toMatch(
      /^\{ rsync -a --no-specials \/src\/ \/dst\/ \|\| /,
    );
  });

  it('continues the chain on success', async () => {
    const r = await runWithRsyncExit(0);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('rsync -a --no-specials --exclude=x /src/ /dst/');
    expect(r.stdout).toContain('after');
  });

  it('treats exit 24 (source files vanished) as success and runs the later steps', async () => {
    const r = await runWithRsyncExit(24);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('after');
  });

  it('aborts with rsync own exit code on any other failure', async () => {
    const r = await runWithRsyncExit(23);
    expect(r.exitCode).toBe(23);
    expect(r.stdout).not.toContain('after');
  });
});
