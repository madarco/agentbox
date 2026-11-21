import { describe, expect, it } from 'vitest';
import { parseProviderWarning, type LoopbackEndpoint } from '@agentbox/core';
import { loopbackEndpointNotes } from '../src/host-endpoints.js';

const rewritten: LoopbackEndpoint = {
  where: '~/.codex/config.toml model_providers.gw.base_url',
  url: 'http://127.0.0.1:4000/v1',
  port: 4000,
  rewrittenTo: 'http://host.docker.internal:4000/v1',
};

describe('loopbackEndpointNotes', () => {
  it('prints nothing when nothing was rewritten', async () => {
    const reportOnly = { ...rewritten, rewrittenTo: undefined };
    expect(
      await loopbackEndpointNotes('codex', [reportOnly], { gateway: async () => null }),
    ).toEqual([]);
  });

  it('one persisted line per rewrite, no probe off a native Linux engine', async () => {
    const notes = await loopbackEndpointNotes('codex', [rewritten], { gateway: async () => null });
    expect(notes).toHaveLength(1);
    expect(parseProviderWarning(notes[0] ?? '')).toContain(
      '-> http://host.docker.internal:4000/v1',
    );
  });

  it('warns to rebind when the bridge address refuses the port', async () => {
    const probed: string[] = [];
    const notes = await loopbackEndpointNotes('codex', [rewritten, rewritten], {
      gateway: async () => '172.17.0.1',
      reachable: async (h, p) => {
        probed.push(`${h}:${String(p)}`);
        return false;
      },
    });
    expect(probed).toEqual(['172.17.0.1:4000']); // de-duplicated by port
    expect(parseProviderWarning(notes[2] ?? '')).toContain('bind it to 0.0.0.0 or 172.17.0.1');
  });

  it('stays quiet when the bridge address answers', async () => {
    const notes = await loopbackEndpointNotes('codex', [rewritten], {
      gateway: async () => '172.17.0.1',
      reachable: async () => true,
    });
    expect(notes).toHaveLength(1);
  });
});

describe('stageLoopbackOverlay', () => {
  it('writes rewritten copies only for files that changed, laid out by rel', async () => {
    const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
    const { existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { stageLoopbackOverlay } = await import('../src/host-endpoints.js');
    const home = await mkdtemp(join(tmpdir(), 'ovl-test-'));
    const loop = join(home, 'loop.json');
    const remote = join(home, 'remote.json');
    await writeFile(loop, '{"providers":{"a":{"baseUrl":"http://127.0.0.1:1234/v1"}}}');
    await writeFile(remote, '{"providers":{"a":{"baseUrl":"https://api.example.com"}}}');
    const paths = [['providers', '*', 'baseUrl']] as const;
    const o = await stageLoopbackOverlay([
      { src: loop, rel: 'config/loop.json', paths, source: 'loop' },
      { src: remote, rel: 'remote.json', paths, source: 'remote' },
      { src: join(home, 'missing.json'), rel: 'missing.json', paths, source: 'missing' },
    ]);
    try {
      expect(o.endpoints).toHaveLength(1);
      expect(o.dir).not.toBeNull();
      const out = await readFile(join(o.dir as string, 'config/loop.json'), 'utf8');
      expect(out).toContain('http://host.docker.internal:1234/v1');
      expect(existsSync(join(o.dir as string, 'remote.json'))).toBe(false);
    } finally {
      await o.cleanup();
      await rm(home, { recursive: true, force: true });
    }
  });
});
