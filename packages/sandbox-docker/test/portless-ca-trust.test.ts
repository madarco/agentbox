import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const { execaMock } = vi.hoisted(() => ({
  execaMock: vi.fn<
    (...args: unknown[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  >(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
}));
vi.mock('execa', () => ({ execa: execaMock }));

import { trustInBoxPortlessCa } from '../src/create.js';
import { BOX_PORTLESS_CA_PATH } from '../src/portless.js';

describe('trustInBoxPortlessCa', () => {
  it('copies the host CA into the box over stdin and trusts it there (no mount)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'portless-ca-trust-'));
    await writeFile(join(dir, 'ca.pem'), '-----BEGIN CERTIFICATE-----\nabc\n');
    await writeFile(join(dir, 'ca-key.pem'), 'PRIVATE');
    const log = vi.fn();
    await trustInBoxPortlessCa('agentbox-x', dir, log);
    const call = execaMock.mock.calls.find((c) => c[0] === 'docker');
    expect(call).toBeDefined();
    const [, args, opts] = call as [string, string[], { input?: string }];
    expect(args.slice(0, 5)).toEqual(['exec', '-i', '--user', 'root', 'agentbox-x']);
    const script = args[args.length - 1] ?? '';
    expect(script).toContain(`cat > ${BOX_PORTLESS_CA_PATH}`);
    expect(script).toContain(`agentbox-portless-trust ${BOX_PORTLESS_CA_PATH}`);
    // The public cert only; the CA's private key never leaves the host.
    expect(opts.input).toBe('-----BEGIN CERTIFICATE-----\nabc\n');
    expect(log).toHaveBeenCalledWith('portless: trusted host CA in box (system store + NSS)');
  });

  it('does nothing in the box when the host has no CA', async () => {
    execaMock.mockClear();
    const dir = await mkdtemp(join(tmpdir(), 'portless-noca-trust-'));
    const log = vi.fn();
    await trustInBoxPortlessCa('agentbox-x', dir, log);
    expect(execaMock.mock.calls.some((c) => c[0] === 'docker')).toBe(false);
  });
});
