/**
 * Boundary tests for the six review findings on the CreateOS provider.
 *
 * These deliberately assert the FINAL create request, the list output that
 * feeds `agentbox prune`, and the exact exec script — not the `--size` parser.
 * Every one of these bugs parsed correctly and then lost the value downstream,
 * so a parser-level test cannot catch any of them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CreateOsCreateSandboxRequest, CreateOsSandboxView } from '../src/client.js';

const calls = {
  created: [] as CreateOsCreateSandboxRequest[],
  destroyed: [] as string[],
  execScripts: [] as string[],
  execAttempts: 0,
};

let listResponse: CreateOsSandboxView[] = [];
let sandboxStatus = 'running';
let execImpl: () => Promise<unknown> = () => Promise.resolve({ result: { exit_code: 0 } });
let assetsImpl: () => unknown[] = () => [];

vi.mock('../src/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/client.js')>();
  return {
    ...actual,
    makeCreateOsClient: () => ({
      createSandbox: (req: CreateOsCreateSandboxRequest) => {
        calls.created.push(req);
        return Promise.resolve({ id: 'sb_test' });
      },
      getSandbox: () => Promise.resolve({ id: 'sb_test', status: sandboxStatus }),
      listSandboxes: () => Promise.resolve(listResponse),
      destroySandbox: (id: string) => {
        calls.destroyed.push(id);
        return Promise.resolve();
      },
      exec: (_id: string, _cmd: string, args: string[]) => {
        calls.execAttempts += 1;
        calls.execScripts.push(args.at(-1) ?? '');
        return execImpl();
      },
      uploadFile: () => Promise.resolve(),
    }),
  };
});

vi.mock('../src/runtime-assets.js', () => ({
  findStagedCliRuntimeRoot: () => undefined,
  resolveRuntimeAssets: () => assetsImpl(),
}));

const { createosBackend, CREATEOS_DEFAULT_RESOURCES, CREATEOS_DEFAULT_BOX_IMAGE_REF } =
  await import('../src/backend.js');

beforeEach(() => {
  calls.created = [];
  calls.destroyed = [];
  calls.execScripts = [];
  calls.execAttempts = 0;
  listResponse = [];
  sandboxStatus = 'running';
  execImpl = () => Promise.resolve({ result: { exit_code: 0 } });
  assetsImpl = () => [];
});

// Finding 4 — the disk component of `--size` was dropped because the shared
// scaffold always supplies `resources`, which took precedence.
describe('provision: explicit --size disk', () => {
  it('sends the requested disk, not the provider default', async () => {
    await createosBackend.provision({
      name: 'review',
      image: CREATEOS_DEFAULT_BOX_IMAGE_REF,
      size: '4-8-50',
      resources: { ...CREATEOS_DEFAULT_RESOURCES },
    });
    expect(calls.created.at(-1)?.disk_mib).toBe(50 * 1024);
  });

  it('falls back to the scaffold default for a bare shape name', async () => {
    await createosBackend.provision({
      name: 'review',
      image: CREATEOS_DEFAULT_BOX_IMAGE_REF,
      size: 's-4vcpu-8gb',
      resources: { ...CREATEOS_DEFAULT_RESOURCES, disk: 30 },
    });
    expect(calls.created.at(-1)?.disk_mib).toBe(30 * 1024);
  });
});

// Finding 1 — `list()` admitted every named sandbox, so prune offered the
// user's own unrelated CreateOS sandboxes as deletion candidates.
describe('list: ownership', () => {
  it('stamps an ownership marker at create time', async () => {
    await createosBackend.provision({ name: 'review', image: CREATEOS_DEFAULT_BOX_IMAGE_REF, resources: CREATEOS_DEFAULT_RESOURCES });
    expect(calls.created.at(-1)?.envs).toHaveProperty('AGENTBOX_OWNED');
  });

  it('excludes sandboxes AgentBox did not create', async () => {
    listResponse = [
      { id: 'sb_unrelated', name: 'production-worker', status: 'running' },
      { id: 'sb_owned', name: 'review', status: 'running', envs: ['AGENTBOX_OWNED'] },
    ];
    const ids = (await createosBackend.list()).map((s) => s.sandboxId);
    expect(ids).toEqual(['sb_owned']);
  });

  it('preserves caller env alongside the marker', async () => {
    await createosBackend.provision({
      name: 'review',
      image: CREATEOS_DEFAULT_BOX_IMAGE_REF,
      resources: CREATEOS_DEFAULT_RESOURCES,
      env: { FOO: 'bar' },
    });
    expect(calls.created.at(-1)?.envs).toMatchObject({ FOO: 'bar', AGENTBOX_OWNED: '1' });
  });
});

// Finding 2 — a failure after create left a billable sandbox behind, because
// the scaffold's cleanup only sees a handle `provision` actually returned.
describe('provision: cleanup on post-create failure', () => {
  it('destroys the sandbox when the runtime install fails', async () => {
    execImpl = () => Promise.resolve({ result: { exit_code: 1, stderr: 'boom' } });
    assetsImpl = () => [];
    await expect(
      createosBackend.provision({ name: 'review', image: CREATEOS_DEFAULT_BOX_IMAGE_REF, resources: CREATEOS_DEFAULT_RESOURCES }),
    ).rejects.toThrow(/runtime install failed/);
    expect(calls.destroyed).toEqual(['sb_test']);
  });

  it('never allocates compute when local assets are missing', async () => {
    assetsImpl = () => {
      throw new Error('missing runtime asset');
    };
    await expect(
      createosBackend.provision({ name: 'review', image: CREATEOS_DEFAULT_BOX_IMAGE_REF, resources: CREATEOS_DEFAULT_RESOURCES }),
    ).rejects.toThrow(/missing runtime asset/);
    expect(calls.created).toEqual([]);
    expect(calls.destroyed).toEqual([]);
  });
});

// Finding 6 — env overrides were exported in the outer root shell, where
// sudo's default env_reset dropped them before the command ran.
describe('exec: environment across the privilege drop', () => {
  it('exports the override inside the target-user shell', async () => {
    await createosBackend.exec({ sandboxId: 'sb_test' }, 'printenv REVIEW_VALUE', {
      env: { REVIEW_VALUE: 'present' },
    });
    const script = calls.execScripts.at(-1) ?? '';
    expect(script.indexOf('sudo')).toBeLessThan(script.indexOf('export REVIEW_VALUE'));
  });

  it('still exports directly when running as root', async () => {
    await createosBackend.exec({ sandboxId: 'sb_test' }, 'printenv REVIEW_VALUE', {
      user: 'root',
      env: { REVIEW_VALUE: 'present' },
    });
    const script = calls.execScripts.at(-1) ?? '';
    expect(script).toContain('export REVIEW_VALUE');
    expect(script).not.toContain('sudo');
  });
});

// Finding 3 — an ambiguous per-attempt timeout retried the command while the
// first execution was potentially still running in the guest.
describe('exec: ambiguous timeouts', () => {
  it('does not run the command a second time after a timeout', async () => {
    execImpl = () => new Promise((resolve) => setTimeout(resolve, 200));
    await expect(
      createosBackend.exec({ sandboxId: 'sb_test' }, 'migrate --apply', {
        attemptTimeoutMs: 20,
      }),
    ).rejects.toThrow(/timeout/);
    expect(calls.execAttempts).toBe(1);
  });
});

// mapState collapsed CreateOS's recoverable `error` into `missing`, presenting
// a resumable box as deleted.
describe('state mapping', () => {
  it('reports a recoverable error state as paused, not missing', async () => {
    sandboxStatus = 'error';
    expect(await createosBackend.state({ sandboxId: 'sb_test' })).toBe('paused');
  });

  it('still reports a destroyed sandbox as missing', async () => {
    sandboxStatus = 'destroyed';
    expect(await createosBackend.state({ sandboxId: 'sb_test' })).toBe('missing');
  });
});
