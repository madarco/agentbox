import { describe, expect, it } from 'vitest';
import { makeRecordingTransport } from '../src/sync/recording-transport.js';

describe('RecordingSyncTransport', () => {
  it('records every call in invocation order with normalized args', async () => {
    const t = makeRecordingTransport();
    await t.pushTree('/host/.claude', '/home/vscode/.claude', { exclude: ['node_modules'] });
    await t.exec(['sh', '-c', 'echo hi']);
    await t.pushFile('/host/a.env', '/workspace/.env', { uid: 1000 });
    await t.readText('/home/vscode/.codex/auth.json');

    expect(t.ops).toEqual([
      { op: 'pushTree', args: { hostSrcDir: '/host/.claude', boxDestDir: '/home/vscode/.claude', opts: { exclude: ['node_modules'] } } },
      { op: 'exec', args: { cmd: ['sh', '-c', 'echo hi'], opts: undefined } },
      { op: 'pushFile', args: { hostSrcPath: '/host/a.env', boxDestPath: '/workspace/.env', opts: { uid: 1000 } } },
      { op: 'readText', args: { boxPath: '/home/vscode/.codex/auth.json' } },
    ]);
  });

  it('serves canned exec + readText results and defaults', async () => {
    const t = makeRecordingTransport({
      execResult: (cmd) => ({ exitCode: cmd.includes('fail') ? 1 : 0, stdout: 'out', stderr: '' }),
      readText: (p) => (p.endsWith('auth.json') ? '{"tok":1}' : null),
    });
    expect(await t.exec(['fail'])).toEqual({ exitCode: 1, stdout: 'out', stderr: '' });
    expect(await t.readText('/x/auth.json')).toBe('{"tok":1}');
    expect(await t.readText('/x/missing')).toBeNull();
  });

  it('models a docker-like backend (volumes present) by default', async () => {
    const t = makeRecordingTransport();
    expect(t.caps).toEqual({ persistentVolumes: true, helperContainer: true, ephemeralFs: false });
    expect(typeof t.ensureVolume).toBe('function');
    expect(typeof t.seedVolumeFromHost).toBe('function');
  });

  it('models an ephemeral cloud backend (no volume primitives) when withVolumes=false', () => {
    const t = makeRecordingTransport({
      withVolumes: false,
      caps: { persistentVolumes: false, helperContainer: false, ephemeralFs: true },
    });
    expect(t.ensureVolume).toBeUndefined();
    expect(t.seedVolumeFromHost).toBeUndefined();
    expect(t.caps.ephemeralFs).toBe(true);
  });

  it('clear() resets the op log', async () => {
    const t = makeRecordingTransport();
    await t.exec(['a']);
    t.clear();
    await t.exec(['b']);
    expect(t.ops).toEqual([{ op: 'exec', args: { cmd: ['b'], opts: undefined } }]);
  });
});
