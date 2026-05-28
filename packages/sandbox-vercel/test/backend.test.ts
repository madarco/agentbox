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
  Sandbox: {
    get: mocks.get,
    create: mocks.create,
    list: mocks.list,
  },
  Snapshot: {
    get: mocks.snapshotGet,
  },
}));

import { vercelBackend } from '../src/backend.js';

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

  it('is idempotent when the sandbox is already gone', async () => {
    mocks.get.mockRejectedValue(new Error('not_found'));
    await expect(vercelBackend.destroy({ sandboxId: 'gone' })).resolves.toBeUndefined();
  });
});
