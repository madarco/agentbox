import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the SDK loader so the backend never touches the real @vercel/sandbox.
const mocks = vi.hoisted(() => {
  return {
    get: vi.fn(),
    create: vi.fn(),
    list: vi.fn(),
    snapshotGet: vi.fn(),
  };
});

vi.mock('../src/sdk.js', () => ({
  resolveCredentials: () => ({}),
  ensureFreshCredentials: () => Promise.resolve(),
  Sandbox: {
    get: mocks.get,
    create: mocks.create,
    list: mocks.list,
  },
  Snapshot: {
    get: mocks.snapshotGet,
  },
}));

import { vercelBackend, buildExposedPorts, VERCEL_MAX_PORTS, parseNetworkPolicy } from '../src/backend.js';

function fakeSandbox(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'box-1',
    status: 'running',
    currentSnapshotId: undefined,
    runCommand: vi.fn(),
    stop: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => ({ snapshotId: 'snap_new' })),
    ...over,
  };
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
});

describe('vercelBackend.state', () => {
  it('maps running → running', async () => {
    mocks.get.mockResolvedValue(fakeSandbox({ status: 'running' }));
    expect(await vercelBackend.state({ sandboxId: 'box-1' })).toBe('running');
  });

  it('maps stopped → paused (persistent auto-snapshot is resumable)', async () => {
    mocks.get.mockResolvedValue(fakeSandbox({ status: 'stopped' }));
    expect(await vercelBackend.state({ sandboxId: 'box-1' })).toBe('paused');
  });

  it('maps transitional snapshotting → running', async () => {
    mocks.get.mockResolvedValue(fakeSandbox({ status: 'snapshotting' }));
    expect(await vercelBackend.state({ sandboxId: 'box-1' })).toBe('running');
  });

  it('maps failed → missing', async () => {
    mocks.get.mockResolvedValue(fakeSandbox({ status: 'failed' }));
    expect(await vercelBackend.state({ sandboxId: 'box-1' })).toBe('missing');
  });

  it('returns missing when the sandbox is not found', async () => {
    mocks.get.mockRejectedValue(new Error('not_found'));
    expect(await vercelBackend.state({ sandboxId: 'gone' })).toBe('missing');
  });
});

describe('vercelBackend.exec', () => {
  type RunArg = { args: string[]; sudo: boolean };
  const firstRunArg = (fn: ReturnType<typeof vi.fn>): RunArg =>
    (fn.mock.calls[0] as unknown as [RunArg])[0];

  it('runs as vscode by default and returns split streams', async () => {
    const runCommand = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stdout: async () => 'hello\n', stderr: async () => '' }),
    );
    mocks.get.mockResolvedValue(fakeSandbox({ runCommand }));

    const r = await vercelBackend.exec({ sandboxId: 'box-1' }, 'echo hello');
    expect(r).toEqual({ exitCode: 0, stdout: 'hello\n', stderr: '' });
    // The command should be wrapped to drop privileges to vscode.
    const arg = firstRunArg(runCommand);
    expect(arg.sudo).toBe(true);
    expect(arg.args.join(' ')).toMatch(/sudo -u vscode -H bash -lc/);
  });

  it('runs directly as root when user=root (no privilege drop)', async () => {
    const runCommand = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stdout: async () => '', stderr: async () => '' }),
    );
    mocks.get.mockResolvedValue(fakeSandbox({ runCommand }));

    await vercelBackend.exec({ sandboxId: 'box-1' }, 'whoami', { user: 'root' });
    const arg = firstRunArg(runCommand);
    expect(arg.sudo).toBe(true);
    expect(arg.args.join(' ')).not.toMatch(/sudo -u vscode/);
  });

  it('exports a valid env var with a shell-quoted value', async () => {
    const runCommand = vi.fn(() =>
      Promise.resolve({ exitCode: 0, stdout: async () => '', stderr: async () => '' }),
    );
    mocks.get.mockResolvedValue(fakeSandbox({ runCommand }));

    await vercelBackend.exec({ sandboxId: 'box-1' }, 'env', { user: 'root', env: { FOO: "a'b; rm -rf /" } });
    const arg = firstRunArg(runCommand);
    // Key bare, value quoted — the injection lives in the value and is neutralised.
    expect(arg.args.join(' ')).toContain("export FOO='a'\\''b; rm -rf /'");
  });

  it('rejects an env var name with shell metacharacters (injection guard)', async () => {
    mocks.get.mockResolvedValue(fakeSandbox({ runCommand: vi.fn() }));
    await expect(
      vercelBackend.exec({ sandboxId: 'box-1' }, 'echo hi', { env: { 'x;rm -rf /': '1' } }),
    ).rejects.toThrow(/invalid env var name/);
  });
});

describe('vercelBackend.destroy', () => {
  it('deletes the sandbox and purges its current snapshot', async () => {
    const snapDelete = vi.fn(async () => undefined);
    const sb = fakeSandbox({ currentSnapshotId: 'snap_live' });
    mocks.get.mockResolvedValue(sb);
    mocks.snapshotGet.mockResolvedValue({ delete: snapDelete });

    await vercelBackend.destroy({ sandboxId: 'box-1' });
    expect((sb.delete as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect(snapDelete).toHaveBeenCalled();
  });

  it('does NOT delete the source snapshot a box still sits on (protects the base)', async () => {
    const snapDelete = vi.fn(async () => undefined);
    // currentSnapshotId === sourceSnapshotId → the box never made its own
    // snapshot; deleting it would nuke the shared base/checkpoint.
    const sb = fakeSandbox({ currentSnapshotId: 'snap_base', sourceSnapshotId: 'snap_base' });
    mocks.get.mockResolvedValue(sb);
    mocks.snapshotGet.mockResolvedValue({ delete: snapDelete });

    await vercelBackend.destroy({ sandboxId: 'box-1' });
    expect((sb.delete as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect(snapDelete).not.toHaveBeenCalled();
  });

  it('is idempotent when the sandbox is already gone', async () => {
    mocks.get.mockRejectedValue(new Error('not_found'));
    await expect(vercelBackend.destroy({ sandboxId: 'gone' })).resolves.toBeUndefined();
  });
});

describe('buildExposedPorts', () => {
  it('returns just the base ports when no expose ports are given', () => {
    expect(buildExposedPorts(undefined)).toEqual([6080, 8788]);
    expect(buildExposedPorts([])).toEqual([6080, 8788]);
  });

  it('appends non-privileged expose ports after the base set', () => {
    expect(buildExposedPorts([3000])).toEqual([6080, 8788, 3000]);
  });

  it('drops privileged ports (<1024, which Vercel 400s) and out-of-range', () => {
    expect(buildExposedPorts([80, 443, 3000, 70000])).toEqual([6080, 8788, 3000]);
  });

  it('dedupes against the base set and itself', () => {
    expect(buildExposedPorts([6080, 3000, 3000])).toEqual([6080, 8788, 3000]);
  });

  it('never exceeds the Vercel 4-port cap', () => {
    const out = buildExposedPorts([3000, 3001, 3002, 3003]);
    expect(out.length).toBe(VERCEL_MAX_PORTS);
    expect(out).toEqual([6080, 8788, 3000, 3001]);
  });
});

describe('parseNetworkPolicy', () => {
  it('returns undefined for empty/unset (SDK default allow-all)', () => {
    expect(parseNetworkPolicy(undefined)).toBeUndefined();
    expect(parseNetworkPolicy('')).toBeUndefined();
    expect(parseNetworkPolicy('   ')).toBeUndefined();
  });

  it('passes through the allow-all / deny-all literals', () => {
    expect(parseNetworkPolicy('allow-all')).toBe('allow-all');
    expect(parseNetworkPolicy('deny-all')).toBe('deny-all');
    expect(parseNetworkPolicy(' deny-all ')).toBe('deny-all');
  });

  it('treats anything else as a comma-separated domain allowlist', () => {
    expect(parseNetworkPolicy('github.com')).toEqual({ allow: ['github.com'] });
    expect(parseNetworkPolicy('github.com, *.npmjs.org ,')).toEqual({
      allow: ['github.com', '*.npmjs.org'],
    });
  });
});
