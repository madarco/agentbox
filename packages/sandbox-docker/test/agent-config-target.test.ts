import { beforeEach, describe, expect, it, vi } from 'vitest';

// No docker: execa (volume create/rm/inspect) and the tar pipe are both mocked.
const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock('execa', () => ({ execa: execaMock }));

const { streamTarPipeMock } = vi.hoisted(() => ({ streamTarPipeMock: vi.fn() }));
vi.mock('../src/box-cp.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  streamTarPipe: streamTarPipeMock,
}));

const { openAgentConfigTarget, agentConfigDir, agentConfigStagingVolume } =
  await import('../src/sync/agents/config-target.js');
const { registerAgentSyncModule } = await import('../src/sync/agents/module.js');

const CODEX_DIR = '/home/vscode/.codex';

registerAgentSyncModule({
  id: 'codex',
  resolveVolume: ({ isolate, boxId }) => ({
    volume: isolate ? `agentbox-codex-config-${boxId}` : 'agentbox-codex-config',
  }),
  buildMounts: (spec) => ({
    extraVolumes: [`${spec.volume}:${CODEX_DIR}`],
    env: {},
    volumeName: spec.volume,
  }),
  ensureVolume: async () => ({ created: false, synced: true }),
  sessionInfo: async () => ({ running: false, sessionName: 'codex', startedAt: null }),
});

/** `docker inspect <container>` answers with these mounts. */
function inspectReturns(mounts: unknown[] | null): void {
  execaMock.mockImplementation(async (_file: string, args: string[]) => {
    if (args[0] === 'inspect') {
      return mounts === null
        ? { exitCode: 1, stdout: '', stderr: 'no such container' }
        : { exitCode: 0, stdout: JSON.stringify([{ Mounts: mounts }]), stderr: '' };
    }
    if (args[0] === 'volume' && args[1] === 'inspect') return { exitCode: 1, stdout: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  });
}

/** argv of every `docker volume rm` the run issued. */
function volumeRmCalls(): string[][] {
  return (execaMock.mock.calls as [string, string[]][])
    .map(([, a]) => a)
    .filter((a) => a[0] === 'volume' && a[1] === 'rm');
}

const OK: [unknown, unknown] = [
  { exitCode: 0, stderr: '' },
  { exitCode: 0, stderr: '' },
];

const base = {
  agent: 'codex' as const,
  container: 'agentbox-claude-made',
  boxId: 'b1',
  image: 'agentbox/box:dev',
};

beforeEach(() => {
  execaMock.mockReset();
  streamTarPipeMock.mockReset();
  streamTarPipeMock.mockResolvedValue(OK);
});

describe('agentConfigDir', () => {
  it("reads the mount point from the agent's own buildMounts", () => {
    expect(agentConfigDir('codex')).toBe(CODEX_DIR);
  });

  it('is undefined for an agent with no docker module', () => {
    expect(agentConfigDir('no-such-agent' as never)).toBeUndefined();
  });
});

describe('openAgentConfigTarget', () => {
  it('syncs straight into the mounted volume, by its inspected name', async () => {
    inspectReturns([{ Type: 'volume', Name: 'agentbox-codex-config', Destination: CODEX_DIR }]);
    const t = await openAgentConfigTarget({ ...base, recordVolume: undefined, stage: true });
    expect(t).toMatchObject({ volume: 'agentbox-codex-config', mounted: true });
    await t!.flush();
    await t!.release();
    expect(streamTarPipeMock).not.toHaveBeenCalled();
  });

  it('stages a box created for another agent and copies the result into the container', async () => {
    // The reported bug: a claude-created box mounts no codex volume, so the
    // record has none and the old start path skipped the sync.
    inspectReturns([
      { Type: 'volume', Name: 'agentbox-claude-config', Destination: '/home/vscode/.claude' },
    ]);
    const t = await openAgentConfigTarget({ ...base, recordVolume: undefined, stage: true });
    const stage = agentConfigStagingVolume('codex', 'b1');
    expect(t).toMatchObject({ volume: stage, mounted: false });

    // Pulled from the container's config dir into the staging volume first, so
    // merge-style syncs see the in-box state.
    expect(streamTarPipeMock).toHaveBeenCalledTimes(1);
    const [pFile, pArgs, cFile, cArgs] = streamTarPipeMock.mock.calls[0]!;
    expect(pFile).toBe('docker');
    expect(pArgs).toEqual(expect.arrayContaining(['exec', base.container]));
    expect(pArgs.join(' ')).toContain(`tar -C '${CODEX_DIR}' -cf - .`);
    expect(cFile).toBe('docker');
    expect(cArgs).toEqual(expect.arrayContaining(['run', `${stage}:/stage`, base.image]));

    await t!.flush();
    expect(streamTarPipeMock).toHaveBeenCalledTimes(2);
    const [, fArgs, , iArgs] = streamTarPipeMock.mock.calls[1]!;
    expect(fArgs).toEqual(expect.arrayContaining(['run', `${stage}:/stage:ro`]));
    // One root mirror WITH deletion: an additive copy-back would resurrect what
    // the sync removed (claude's marketplace prunes).
    expect(iArgs.slice(0, 5)).toEqual(['exec', '-i', '--user', '0', base.container]);
    const script = iArgs[iArgs.indexOf('-c') + 1] as string;
    expect(script).toContain('rsync -a --delete -- "$s/" "$1/"');
    expect(script).toContain('chown -R "$2:" "$1"');
    expect(iArgs.slice(-2)).toEqual([CODEX_DIR, 'vscode']);

    await t!.release();
    const rms = volumeRmCalls();
    // Once before staging (a leftover from an interrupted start), once on release.
    expect(rms.map((a) => a[2])).toEqual([stage, stage]);
  });

  it('ignores the record when the record names a volume the container does not mount', async () => {
    // claude's resolver falls back to the shared volume on a box without one.
    inspectReturns([]);
    const t = await openAgentConfigTarget({
      ...base,
      recordVolume: 'agentbox-codex-config',
      stage: true,
    });
    expect(t?.mounted).toBe(false);
    expect(t?.volume).toBe(agentConfigStagingVolume('codex', 'b1'));
    await t!.release();
  });

  it('does not stage when staging is off (attach, --no-sync-config)', async () => {
    inspectReturns([]);
    const t = await openAgentConfigTarget({
      ...base,
      recordVolume: 'agentbox-codex-config',
      stage: false,
    });
    expect(t).toBeUndefined();
    expect(streamTarPipeMock).not.toHaveBeenCalled();
  });

  it('fails closed when the container cannot be inspected, never trusting the record', async () => {
    inspectReturns(null);
    await expect(
      openAgentConfigTarget({ ...base, recordVolume: 'from-record', stage: true }),
    ).rejects.toThrow(/could not inspect agentbox-claude-made/);
    expect(streamTarPipeMock).not.toHaveBeenCalled();
  });

  it('drops the staging volume on Ctrl-C while it exists, and unhooks on release', async () => {
    inspectReturns([]);
    const before = process.listenerCount('SIGINT');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      const t = await openAgentConfigTarget({ ...base, recordVolume: undefined, stage: true });
      expect(process.listenerCount('SIGINT')).toBe(before + 1);
      const rmsBefore = volumeRmCalls().length;
      process.emit('SIGINT', 'SIGINT');
      // Still attached while it runs: with `once`, execa's signal-exit would see
      // itself as the last listener and re-raise SIGINT before the removal.
      expect(process.listenerCount('SIGINT')).toBe(before + 1);
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130));
      expect(volumeRmCalls().length).toBe(rmsBefore + 1);
      await t!.release();
      expect(process.listenerCount('SIGINT')).toBe(before);
    } finally {
      exit.mockRestore();
    }
  });

  it('is already hooked when Ctrl-C lands while the volume is being created', async () => {
    inspectReturns([]);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const plain = execaMock.getMockImplementation()!;
    execaMock.mockImplementation(async (file: string, args: string[]) => {
      if (args[0] === 'volume' && args[1] === 'create') process.emit('SIGINT', 'SIGINT');
      return plain(file, args);
    });
    try {
      const t = await openAgentConfigTarget({ ...base, recordVolume: undefined, stage: true });
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130));
      await t!.release();
    } finally {
      exit.mockRestore();
    }
  });

  it('retries the removal while an interrupted helper still holds the volume', async () => {
    inspectReturns([]);
    const t = await openAgentConfigTarget({ ...base, recordVolume: undefined, stage: true });
    const plain = execaMock.getMockImplementation()!;
    let busy = 2;
    execaMock.mockImplementation(async (file: string, args: string[]) => {
      if (args[0] === 'volume' && args[1] === 'rm' && busy-- > 0) {
        return { exitCode: 1, stdout: '', stderr: 'volume is in use' };
      }
      return plain(file, args);
    });
    const rmsBefore = volumeRmCalls().length;
    await t!.release();
    expect(volumeRmCalls().length - rmsBefore).toBe(3);
  });

  it('release is idempotent and removes the signal handlers', async () => {
    inspectReturns([]);
    const before = process.listenerCount('SIGTERM');
    const t = await openAgentConfigTarget({ ...base, recordVolume: undefined, stage: true });
    await t!.release();
    await t!.release();
    expect(process.listenerCount('SIGTERM')).toBe(before);
    expect(volumeRmCalls()).toHaveLength(2);
  });

  it('drops the staging volume and throws when the pull fails', async () => {
    inspectReturns([]);
    const before = process.listenerCount('SIGINT');
    streamTarPipeMock.mockResolvedValueOnce([
      { exitCode: 2, stderr: 'tar: boom' },
      { exitCode: 0, stderr: '' },
    ]);
    await expect(
      openAgentConfigTarget({ ...base, recordVolume: undefined, stage: true }),
    ).rejects.toThrow(/tar: boom/);
    const rms = volumeRmCalls();
    expect(rms).toHaveLength(2);
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});
