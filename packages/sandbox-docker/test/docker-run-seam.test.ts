import { describe, expect, it, vi } from 'vitest';
import type { DockerRun } from '../src/docker-run.js';
import { derivedAgentDockerfile } from '../src/image.js';
import { readDockerVolumeFiles } from '../src/sync/account-login.js';
import { volumeClaudeCredentials } from '../src/sync/claude-credentials.js';

const b64 = (s: string): string => Buffer.from(s).toString('base64');

describe('the DockerRun seam (a hub sign-in on a remote engine)', () => {
  it('reads volume files through the injected runner, never the local CLI', async () => {
    const run = vi.fn<DockerRun>().mockResolvedValue({
      exitCode: 0,
      stdout: `.credentials.json\t${b64('{"a":1}')}\n_claude.json\t-\n`,
      stderr: '',
    });
    const out = await readDockerVolumeFiles(
      'vol-signin-0123456789abcdef',
      'img',
      ['.credentials.json', '_claude.json'],
      run,
    );
    expect(out).toEqual({ '.credentials.json': '{"a":1}', '_claude.json': null });
    const argv = run.mock.calls[0]![0];
    expect(argv.slice(0, 2)).toEqual(['run', '--rm']);
    expect(argv).toContain('vol-signin-0123456789abcdef:/dst:ro');
  });

  it("throws the runner's stderr when the volume cannot be read", async () => {
    const run: DockerRun = () =>
      Promise.resolve({ exitCode: 125, stdout: '', stderr: 'no such image' });
    await expect(readDockerVolumeFiles('v', 'img', ['x'], run)).rejects.toThrow(/no such image/);
  });

  it('reads a claude volume credential probe through the runner, a failed run as absent', async () => {
    const ok: DockerRun = () =>
      Promise.resolve({ exitCode: 0, stdout: 'PRESENT=yes REFRESH=yes\n', stderr: '' });
    await expect(volumeClaudeCredentials('v', 'img', ok)).resolves.toEqual({
      present: true,
      hasRefreshToken: true,
    });
    const failed: DockerRun = () => Promise.resolve({ exitCode: 255, stdout: '', stderr: 'ssh' });
    await expect(volumeClaudeCredentials('v', 'img', failed)).resolves.toEqual({
      present: false,
      hasRefreshToken: false,
    });
  });
});

describe('derivedAgentDockerfile', () => {
  it('is FROM the base plus the agent, context-free, ending as the box user', () => {
    const lines = derivedAgentDockerfile('agentbox/box:0123456789abcdef', ['codex']);
    expect(lines[0]).toBe('FROM agentbox/box:0123456789abcdef');
    expect(lines.some((l) => l.startsWith('COPY') || l.startsWith('ADD'))).toBe(false);
    expect(lines.some((l) => l.includes('command -v codex'))).toBe(true);
    expect(lines.slice(-2)).toEqual(['USER vscode', 'WORKDIR /workspace']);
  });
});
