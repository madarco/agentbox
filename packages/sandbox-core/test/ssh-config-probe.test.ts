import { describe, expect, it, vi } from 'vitest';

const calls: string[][] = [];
vi.mock('execa', () => ({
  execa: (_cmd: string, args: string[]) => {
    calls.push(args);
    return Promise.resolve({ exitCode: 0, stdout: 'hostname github.com\nuser git\nport 22\n' });
  },
}));

const { resolveSshConfigTarget } = await import('../src/ssh-config-probe.js');

describe('resolveSshConfigTarget', () => {
  it('ends ssh option parsing before the destination', async () => {
    const t = await resolveSshConfigTarget('-oProxyCommand=touch /tmp/x');
    // `--` makes a hostile destination a hostname, never an ssh option.
    expect(calls[0]).toEqual(['-G', '--', '-oProxyCommand=touch /tmp/x']);
    expect(t?.host).toBe('github.com');
  });
});
