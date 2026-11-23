import { mkdir, mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HistoryFrame, HistoryIngestResult } from '@agentbox/core';
import { HostSessionWatcher, hostWatchedAgents } from '../src/history/host-watcher.js';
import type { HostDecisions } from '../src/history/host-settings.js';

const S = 'aaaaaaaa-1111-2222-3333-444444444444';
const T = 'bbbbbbbb-1111-2222-3333-444444444444';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'host-watch-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** A sink that accepts every frame at the offset it holds, like the hub. */
function memSink() {
  const frames: HistoryFrame[] = [];
  const held = new Map<string, number>();
  return {
    frames,
    sink: {
      async ingest(f: HistoryFrame): Promise<HistoryIngestResult> {
        const at = held.get(f.path) ?? 0;
        if (f.offset !== at)
          return { ok: false, code: 'offset_mismatch', message: 'x', offset: at };
        frames.push(f);
        const len = Buffer.from(f.data, 'base64').length;
        held.set(f.path, at + len);
        return { ok: true, offset: at + len, sha256: f.sha256 };
      },
    },
  };
}

function decisions(enabled: boolean, allow: Record<string, boolean>): () => Promise<HostDecisions> {
  return async () => ({
    enabled,
    projects: Object.entries(allow).map(([folder, allowed]) => ({
      folder,
      mode: 'inherit' as const,
      allowed,
      reason: allowed ? ('global' as const) : ('off' as const),
    })),
  });
}

async function session(folderKey: string, id: string, text: string): Promise<string> {
  const dir = join(home, '.claude', 'projects', folderKey);
  await mkdir(dir, { recursive: true });
  const p = join(dir, `${id}.jsonl`);
  await writeFile(p, text);
  return p;
}

describe('host session watcher', () => {
  it('declares claude as host-watched with its dashed-path key', () => {
    expect(hostWatchedAgents(home).map((a) => [a.agent, a.hostKey])).toContainEqual([
      'claude',
      'dashed-path',
    ]);
  });

  it('ships allowed projects only, with a host origin, and resumes from the hub cursor', async () => {
    const main = await session('-work-a', S, '{"n":1}\n');
    await mkdir(join(home, '.claude', 'projects', '-work-a', S, 'subagents'), { recursive: true });
    await writeFile(
      join(home, '.claude', 'projects', '-work-a', S, 'subagents', 'agent-1.jsonl'),
      '{"sub":1}\n',
    );
    await session('-work-b', T, '{"n":2}\n');
    const m = memSink();
    const statusFile = join(home, 'status.json');
    let resolved = 0;
    const w = new HostSessionWatcher({
      home,
      statusFile,
      log: () => {},
      machineId: () => 'pc-1',
      hostSecrets: async () => ['sekrit-value-1234567890'],
      knownFolders: async () => [{ folder: '/work/a' }, { folder: '/work/b' }],
      decide: decisions(true, { '/work/a': true, '/work/b': false }),
      resolveSink: async () => {
        resolved++;
        return { target: 'local', sink: m.sink };
      },
    });
    const st = await w.tick();
    expect(resolved).toBe(1);
    expect(m.frames.map((f) => f.path).sort()).toEqual([
      `projects/-work-a/${S}.jsonl`,
      `projects/-work-a/${S}/subagents/agent-1.jsonl`,
    ]);
    expect(m.frames[0]!.origin).toMatchObject({ kind: 'host', boxId: '', hostId: 'pc-1' });
    expect(st).toMatchObject({ enabled: true, target: 'local', hostId: 'pc-1', sessions: 1 });

    // Appended bytes ship from where the last frame ended; a host secret is redacted.
    await appendFile(main, '{"tok":"sekrit-value-1234567890"}\n');
    await w.tick();
    const last = m.frames[m.frames.length - 1]!;
    expect(last.offset).toBe(Buffer.byteLength('{"n":1}\n'));
    expect(Buffer.from(last.data, 'base64').toString()).not.toContain('sekrit');

    const written = JSON.parse(await readFile(statusFile, 'utf8')) as { projects: unknown[] };
    expect(written.projects).toHaveLength(2);
  });

  it('asks for no sink and reads nothing while every project is off', async () => {
    await session('-work-a', S, '{"n":1}\n');
    let resolved = 0;
    const w = new HostSessionWatcher({
      home,
      statusFile: join(home, 'status.json'),
      log: () => {},
      machineId: () => 'pc-1',
      knownFolders: async () => [{ folder: '/work/a' }],
      decide: decisions(false, { '/work/a': false }),
      resolveSink: async () => {
        resolved++;
        return { target: null, reason: 'unused' };
      },
    });
    const st = await w.tick();
    expect(resolved).toBe(0);
    expect(st).toMatchObject({ enabled: false, target: null, bytesShipped: 0 });
  });

  it('reports a missing hub in the status instead of shipping', async () => {
    await session('-work-a', S, '{"n":1}\n');
    const w = new HostSessionWatcher({
      home,
      statusFile: join(home, 'status.json'),
      log: () => {},
      machineId: () => 'pc-1',
      knownFolders: async () => [{ folder: '/work/a' }],
      decide: decisions(true, { '/work/a': true }),
      resolveSink: async () => ({ target: null, reason: 'no credential for https://hub' }),
    });
    const st = await w.tick();
    expect(st.errors).toEqual(['no credential for https://hub']);
  });
});

describe('httpHistorySink', () => {
  it('posts the frame with the Bearer and returns the bare /api/v1 result', async () => {
    const { createServer } = await import('node:http');
    const { httpHistorySink } = await import('../src/history/host-watcher.js');
    let auth = '';
    const srv = createServer((req, res) => {
      auth = req.headers.authorization ?? '';
      const ok = req.url === '/api/v1/history/chunks';
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(ok ? { ok: true, offset: 3, sha256: 'h' } : { error: { message: 'no' } }),
      );
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    try {
      const frame = {
        origin: { kind: 'host' as const, boxId: '', hostId: 'pc' },
        agent: 'claude',
        path: 'p/x.jsonl',
        offset: 0,
        sha256Prefix: '',
        sha256: 'h',
        data: 'YWJj',
      };
      const r = await httpHistorySink(`http://127.0.0.1:${String(port)}/`, () => 'tok').ingest(
        frame,
      );
      expect(r).toEqual({ ok: true, offset: 3, sha256: 'h' });
      expect(auth).toBe('Bearer tok');
      const bad = await httpHistorySink(`http://127.0.0.1:${String(port)}/x`, () => 'tok').ingest(
        frame,
      );
      expect(bad).toMatchObject({ ok: false, code: 'unavailable' });
    } finally {
      srv.close();
    }
  });
});
