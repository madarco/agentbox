import type { CloudBackend, CloudExecResult, CloudHandle, CloudState } from '@agentbox/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_SYNC_SPECS } from '@agentbox/sandbox-core';
import { ensureAgentVolumesForCloud } from '../src/sync/agent-credentials.js';

/** Minimal backend WITH a volume primitive, so mounts are actually built. */
function volumeBackend(): CloudBackend {
  return {
    name: 'mock',
    async provision(): Promise<CloudHandle> {
      return { sandboxId: 's' };
    },
    async get(): Promise<CloudHandle | null> {
      return { sandboxId: 's' };
    },
    async start() {},
    async stop() {},
    async pause() {},
    async resume() {},
    async destroy() {},
    async state(): Promise<CloudState> {
      return 'running';
    },
    async exec(): Promise<CloudExecResult> {
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    async uploadFile() {},
    async downloadFile() {},
    async listFiles() {
      return [];
    },
    async previewUrl() {
      return { url: 'https://x' };
    },
    async ensureVolume(name: string) {
      return { volumeId: `vol-${name}` };
    },
  } as unknown as CloudBackend;
}

describe('cloud agent selection', () => {
  it("mounts only the selected agent's credential subpath", async () => {
    // The bug this closes: a `agentbox claude` cloud box used to get all three
    // subpath mounts, so real codex and opencode tokens were live-mounted in a
    // box that would never use them.
    const res = await ensureAgentVolumesForCloud(volumeBackend(), { agents: ['claude'] });
    expect(res.agents).toEqual(['claude']);
    expect(res.mounts.map((m) => m.subpath)).toEqual(['claude/']);
    expect(res.mounts.map((m) => m.mountPath)).toEqual(['/home/vscode/.agentbox-creds/claude']);
  });

  it('mounts every agent the registry has, not a hardcoded three', async () => {
    // Absent = historical behaviour, so an un-migrated caller keeps working.
    // Derived rather than listed: this table used to name three agents, so a
    // fourth got no credentials mount and no static mount at all — silently,
    // since `CloudAgentKind` is an open string. Hardcoding the expectation here
    // is what let that ship.
    const expected = AGENT_SYNC_SPECS.filter((a) => a.staticPaths[0]?.boxDir).map((a) => a.id);
    const res = await ensureAgentVolumesForCloud(volumeBackend(), {});
    expect(res.agents).toEqual(expected);
    expect(res.mounts).toHaveLength(expected.length);
    // The canary specifically: a hidden agent is still a real one here.
    expect(res.agents).toContain('example');
  });

  it('narrows the agent list on the no-volume path too', async () => {
    // hetzner/vercel/e2b have no volume primitive and seed per-create instead —
    // the returned agent list is what drives that seed, so it must narrow here
    // as well or the isolation only holds on volume-capable backends.
    const backend = volumeBackend() as unknown as Record<string, unknown>;
    delete backend.ensureVolume;
    const res = await ensureAgentVolumesForCloud(backend as unknown as CloudBackend, {
      agents: ['codex'],
    });
    expect(res.agents).toEqual(['codex']);
    expect(res.mounts).toEqual([]);
  });

  it('narrows when the sandbox class cannot use volumes (daytona linux-vm)', async () => {
    const res = await ensureAgentVolumesForCloud(volumeBackend(), {
      agents: ['opencode'],
      volumesUsable: false,
    });
    expect(res.agents).toEqual(['opencode']);
    expect(res.mounts).toEqual([]);
  });

  it("forwards only the selected agent's env keys", async () => {
    const claude = await ensureAgentVolumesForCloud(volumeBackend(), { agents: ['claude'] });
    // OPENCODE_CONFIG_DIR is set only when opencode is in the set.
    expect(Object.keys(claude.env)).not.toContain('OPENCODE_CONFIG_DIR');
    const oc = await ensureAgentVolumesForCloud(volumeBackend(), { agents: ['opencode'] });
    expect(Object.keys(oc.env)).toContain('OPENCODE_CONFIG_DIR');
  });
});

describe('cloud agent selection — the resume path', () => {
  it('reconciles only the selected agent, so a resume cannot re-add the others', async () => {
    // reconcileAgentCredentials runs on EVERY start. Unfiltered it re-pushes
    // every agent's host backup, which would quietly undo the create-time
    // isolation the first time the box is paused and resumed.
    const { reconcileAgentCredentialsViaTransport } =
      await import('../src/sync/agent-credentials.js');
    const { makeRecordingTransport } = await import('@agentbox/sandbox-core');

    const seen: string[] = [];
    const transport = makeRecordingTransport({
      readText: (boxPath: string) => {
        seen.push(boxPath);
        return null;
      },
    });
    await reconcileAgentCredentialsViaTransport(transport, { agents: ['claude'] });
    expect(seen.some((p) => p.includes('.claude'))).toBe(true);
    expect(seen.some((p) => p.includes('.codex'))).toBe(false);
    expect(seen.some((p) => p.includes('opencode'))).toBe(false);
  });

  it('reconciles every agent when the box predates the selection', async () => {
    const { reconcileAgentCredentialsViaTransport } =
      await import('../src/sync/agent-credentials.js');
    const { makeRecordingTransport } = await import('@agentbox/sandbox-core');
    const seen: string[] = [];
    const transport = makeRecordingTransport({
      readText: (boxPath: string) => {
        seen.push(boxPath);
        return null;
      },
    });
    await reconcileAgentCredentialsViaTransport(transport, {});
    expect(seen.some((p) => p.includes('.claude'))).toBe(true);
    expect(seen.some((p) => p.includes('.codex'))).toBe(true);
  });
});

describe('forwarded env keys respect the agent selection', () => {
  // An env-var login (ANTHROPIC_API_KEY / OPENAI_API_KEY / …) is a credential
  // like any other. Forwarding the union of all three agents' keys would
  // quietly undo the file-and-mount isolation for exactly the agents that
  // authenticate this way — a claude-only box inheriting OPENAI_API_KEY.
  const saved: Record<string, string | undefined> = {};
  const KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'];

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      process.env[k] = `test-${k}`;
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  /** A backend with no volume primitive — the path hetzner/vercel/e2b take. */
  const backend = { name: 'test' } as never;

  it('a claude-only box does not inherit the host OPENAI_API_KEY', async () => {
    const { ensureAgentVolumesForCloud } = await import('../src/sync/agent-credentials.js');
    const res = await ensureAgentVolumesForCloud(backend, { agents: ['claude'] });
    expect(res.env['ANTHROPIC_API_KEY']).toBe('test-ANTHROPIC_API_KEY');
    expect(res.env['OPENAI_API_KEY']).toBeUndefined();
    // ...and opencode's config dir is not wired into a box that has no opencode.
    expect(res.env['OPENCODE_CONFIG_DIR']).toBeUndefined();
  });

  it('a codex-only box does not inherit the host ANTHROPIC_API_KEY', async () => {
    const { ensureAgentVolumesForCloud } = await import('../src/sync/agent-credentials.js');
    const res = await ensureAgentVolumesForCloud(backend, { agents: ['codex'] });
    expect(res.env['OPENAI_API_KEY']).toBe('test-OPENAI_API_KEY');
    expect(res.env['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  it('an un-narrowed caller still gets every agent key', async () => {
    const { ensureAgentVolumesForCloud } = await import('../src/sync/agent-credentials.js');
    const res = await ensureAgentVolumesForCloud(backend, {});
    expect(res.env['ANTHROPIC_API_KEY']).toBe('test-ANTHROPIC_API_KEY');
    expect(res.env['OPENAI_API_KEY']).toBe('test-OPENAI_API_KEY');
  });
});
