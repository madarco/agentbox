import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// `hub.ts` resolves ~/.agentbox at module load, so HOME has to be redirected
// before the import — hence the hoisted temp dir. Without it this file would
// read and REWRITE the real user's hub state (this suite has no HOME isolation
// of its own).
const { homeDir } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: j } = await import('node:path');
  return { homeDir: mkdtempSync(j(tmpdir(), 'agentbox-hub-env-test-')) };
});
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => homeDir };
});

const { hubRuntimeEnv } = await import('../src/hub.js');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('hubRuntimeEnv', () => {
  it('hands the child both roots the CLI resolved', () => {
    expect(
      hubRuntimeEnv({ dockerContext: '/cli/runtime/docker', runtimeRoot: '/cli/runtime' }),
    ).toEqual({
      AGENTBOX_DOCKER_CONTEXT: '/cli/runtime/docker',
      AGENTBOX_RUNTIME_ROOT: '/cli/runtime',
    });
  });

  it('omits the runtime root when there is no staged tree beside this module', () => {
    // Workspace-dev layout (packages/sandbox-docker/src, no sibling runtime/):
    // never plant a root that doesn't resolve — it is candidate 0 in the child's
    // own lookup and would shadow its correct self-resolution.
    vi.stubEnv('AGENTBOX_RUNTIME_ROOT', '');
    const env = hubRuntimeEnv({ dockerContext: '/repo' });
    expect(env.AGENTBOX_RUNTIME_ROOT).toBeUndefined();
    expect(env.AGENTBOX_DOCKER_CONTEXT).toBe('/repo');
  });

  it('propagates an operator AGENTBOX_RUNTIME_ROOT override to the child', () => {
    const staged = join(homeDir, 'staged-runtime');
    mkdirSync(join(staged, 'docker'), { recursive: true });
    writeFileSync(join(staged, 'docker', 'Dockerfile.box'), 'FROM scratch\n');
    vi.stubEnv('AGENTBOX_RUNTIME_ROOT', staged);
    expect(hubRuntimeEnv({ dockerContext: '/repo' }).AGENTBOX_RUNTIME_ROOT).toBe(staged);
  });
});
