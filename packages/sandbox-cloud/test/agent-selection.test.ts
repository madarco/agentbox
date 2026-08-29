import type { CloudBackend, CloudExecResult, CloudHandle, CloudState } from '@agentbox/core';
import { describe, expect, it } from 'vitest';
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

  it('mounts every agent when no selection is given', async () => {
    // Absent = historical behaviour, so an un-migrated caller keeps working.
    const res = await ensureAgentVolumesForCloud(volumeBackend(), {});
    expect(res.agents).toEqual(['claude', 'codex', 'opencode']);
    expect(res.mounts).toHaveLength(3);
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
