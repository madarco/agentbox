import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCliSpec } from '@agentbox/cli-kit';
import type { BoxRecord } from '@agentbox/sandbox-docker';

/**
 * `<agent> start <box>` must sync the agent's host config even when the box
 * was created for a different agent, so it carries no volume of this agent's.
 * The start path used to gate every host-facing step on the box record's
 * volume, which is only set for the agents chosen at create time — so
 * `codex start` in a claude-created box installed codex and started it with
 * the default provider and model.
 *
 * Docker is mocked; the staging mechanics are covered in sandbox-docker's
 * agent-config-target test. This one pins what the start path does with the
 * target it gets back.
 */

const calls: string[] = [];
const sd = vi.hoisted(() => ({
  openAgentConfigTarget: vi.fn(),
  seedAgentDeclaredFiles: vi.fn(),
  moduleAfterVolumeSync: vi.fn(),
}));

vi.mock('@agentbox/sandbox-docker', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  inspectBox: vi.fn(async () => ({ state: 'running' })),
  recordLastAgent: vi.fn(async () => {}),
  startBox: vi.fn(),
  unpauseBox: vi.fn(),
  execInBox: vi.fn(),
  openAgentConfigTarget: sd.openAgentConfigTarget,
  seedAgentDeclaredFiles: sd.seedAgentDeclaredFiles,
  agentSyncModule: () => ({ afterVolumeSync: sd.moduleAfterVolumeSync }),
}));

vi.mock('@agentbox/config', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  loadEffectiveConfig: vi.fn(async () => ({
    effective: { box: { resyncOnStart: false } },
    projectRoot: '/proj',
  })),
}));

vi.mock('@agentbox/cli-kit', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  intro: vi.fn(),
  outro: vi.fn(),
  spinner: () => ({ start: vi.fn(), message: vi.fn(), stop: vi.fn() }),
}));

vi.mock('../src/lib/resync-start.js', () => ({
  maybeResyncWorkspace: vi.fn(async () => undefined),
}));
vi.mock('../src/terminal/host.js', () => ({ hostAwareOpenIn: () => undefined }));

const { startOrAttach } = await import('../src/agents/command/start-attach.js');

const box = {
  id: 'b1',
  name: 'issue1-repro',
  container: 'agentbox-issue1-repro',
  image: 'agentbox/box:dev-claude',
  workspacePath: '/proj',
  provider: 'docker',
  // created for claude: no codex volume on the record
  claudeConfigVolume: 'agentbox-claude-config-b1',
} as unknown as BoxRecord;

function codexSpec(): AgentCliSpec {
  return {
    id: 'codex',
    shortName: 'Codex',
    acceptsSeedPrompt: false,
    spec: { caps: { resume: false } },
    text: { syncConfigLabel: '~/.codex' },
    hooks: {
      afterVolumeSync: vi.fn(async (_b: BoxRecord, o: { volume: string }) => {
        calls.push(`hook:${o.volume}`);
      }),
      afterConfigSync: vi.fn(async (_b: BoxRecord, o: { volume?: string }) => {
        calls.push(`live:${o.volume ?? '-'}`);
      }),
    },
    runtime: {
      cliOverrides: () => ({}),
      sessionNameOf: () => 'codex',
      sessionInfo: vi.fn(async () => ({ running: false })),
      offerDockerLogin: vi.fn(async () => {}),
      resolveConfigVolume: (b: BoxRecord) => b.codexConfigVolume,
      ensureVolume: vi.fn(async (t: { volume: string }, o: { syncFromHost: boolean }) => {
        calls.push(`ensure:${t.volume}:${o.syncFromHost}`);
      }),
      ensureInstalled: vi.fn(async () => calls.push('install')),
      startSession: vi.fn(async () => calls.push('session')),
      skipPermissions: null,
      SessionError: Error,
    },
    attachWrapped: vi.fn(),
  } as unknown as AgentCliSpec;
}

function stagedTarget(): { flush: () => Promise<void>; release: () => Promise<void> } {
  const t = {
    volume: 'agentbox-codex-config-stage-b1',
    mounted: false,
    flush: vi.fn(async () => {
      calls.push('flush');
    }),
    release: vi.fn(async () => {
      calls.push('release');
    }),
  };
  sd.openAgentConfigTarget.mockResolvedValue(t);
  return t;
}

beforeEach(() => {
  calls.length = 0;
  sd.openAgentConfigTarget.mockReset();
  sd.seedAgentDeclaredFiles.mockReset();
  sd.seedAgentDeclaredFiles.mockImplementation(async (_a: string, v: string) => {
    calls.push(`seed:${v}`);
    return { seeded: [] };
  });
  sd.moduleAfterVolumeSync.mockReset();
  sd.moduleAfterVolumeSync.mockImplementation(async (v: string) => {
    calls.push(`module:${v}`);
    return { notes: [] };
  });
});

describe('<agent> start on a box created for another agent', () => {
  it('syncs host config into the staged target, mirrors it in once, then runs the in-box step', async () => {
    stagedTarget();
    await startOrAttach(codexSpec(), box, [], { attach: false });

    expect(sd.openAgentConfigTarget).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'codex', container: box.container, stage: true }),
    );
    const stage = 'agentbox-codex-config-stage-b1';
    expect(calls).toEqual([
      `ensure:${stage}:true`,
      `seed:${stage}`,
      `module:${stage}`,
      `hook:${stage}`,
      'flush',
      'release',
      // in-box work runs on the mirrored tree, with no volume to prescan
      'live:-',
      'install',
      'session',
    ]);
  });

  it('releases the staging volume even when the sync throws', async () => {
    const t = stagedTarget();
    const a = codexSpec();
    (a.runtime.ensureVolume as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('rsync'));
    await expect(startOrAttach(a, box, [], { attach: false })).rejects.toThrow('rsync');
    expect(t.release).toHaveBeenCalledTimes(1);
    expect(calls).not.toContain('flush');
    expect(calls).not.toContain('session');
  });

  it('--no-sync-config asks for no staging and skips the host sync', async () => {
    sd.openAgentConfigTarget.mockResolvedValue(undefined);
    await startOrAttach(codexSpec(), box, [], { attach: false, syncConfig: false });
    expect(sd.openAgentConfigTarget).toHaveBeenCalledWith(
      expect.objectContaining({ stage: false }),
    );
    expect(calls).toEqual(['install', 'session']);
  });
});

describe('<agent> start on a box created for that agent', () => {
  it('syncs into the mounted volume as before, without the create-time module step', async () => {
    const vol = 'agentbox-codex-config';
    sd.openAgentConfigTarget.mockResolvedValue({
      volume: vol,
      mounted: true,
      flush: async () => {},
      release: async () => {},
    });
    await startOrAttach(codexSpec(), { ...box, codexConfigVolume: vol } as BoxRecord, [], {
      attach: false,
    });
    expect(calls).toEqual([
      `ensure:${vol}:true`,
      `seed:${vol}`,
      `hook:${vol}`,
      `live:${vol}`,
      'install',
      'session',
    ]);
  });

  it('--no-sync-config still seeds declared files into the mounted volume', async () => {
    const vol = 'agentbox-codex-config';
    sd.openAgentConfigTarget.mockResolvedValue({
      volume: vol,
      mounted: true,
      flush: async () => {},
      release: async () => {},
    });
    await startOrAttach(codexSpec(), box, [], { attach: false, syncConfig: false });
    expect(calls).toEqual([`seed:${vol}`, `hook:${vol}`, `live:${vol}`, 'install', 'session']);
  });
});
