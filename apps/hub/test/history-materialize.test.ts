import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HistoryFileRow, HistorySessionRow } from '../lib/backend/history';
import {
  createSessionMaterializer,
  hostPathFor,
  materializeTargets,
} from '../lib/backend/history-materialize';

const SID = '0123abcd-1111-2222-3333-444455556666';

function sessionRow(p: Partial<HistorySessionRow> = {}): HistorySessionRow {
  return {
    key: `claude:${SID}`,
    agent: 'claude',
    sessionId: SID,
    boxId: 'box1',
    boxName: 'smoke',
    provider: 'docker',
    hostId: null,
    projectRepoUrl: null,
    account: null,
    parentSessionId: null,
    firstTs: null,
    lastTs: null,
    title: null,
    turns: 1,
    inputTokens: 0,
    outputTokens: 0,
    parserVersion: 1,
    createdAt: 0,
    updatedAt: 0,
    ...p,
  };
}

function fileRow(id: number, path: string, bytes: Buffer): HistoryFileRow {
  return {
    id,
    originKey: 'box:box1',
    agent: 'claude',
    path,
    sessionKey: `claude:${SID}`,
    generation: 0,
    offset: bytes.length,
    sha256: '',
    parseState: null,
    child: path.includes('/subagents/'),
    updatedAt: 0,
  };
}

let dir: string;
let home: string;
let folder: string;
let logs: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'materialize-'));
  home = join(dir, 'home');
  folder = join(dir, 'Projects', 'my.app');
  await mkdir(folder, { recursive: true });
  logs = [];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function harness(opts: { session?: HistorySessionRow; enabled?: boolean } = {}) {
  const contents = new Map<number, Buffer>();
  const files: HistoryFileRow[] = [];
  const session = opts.session ?? sessionRow();
  let enabled = opts.enabled ?? true;
  const setFile = (id: number, path: string, text: string): void => {
    const bytes = Buffer.from(text);
    contents.set(id, bytes);
    const row = fileRow(id, path, bytes);
    const i = files.findIndex((f) => f.id === id);
    if (i >= 0) files[i] = row;
    else files.push(row);
  };
  const m = createSessionMaterializer({
    history: {
      repo: {
        getSession: async (k: string) => (k === session.key ? session : null),
        listSessions: async () => [session],
        filesOfSession: async () => files,
      } as never,
      async *rawStream(id: number, end?: number) {
        yield contents.get(id)!.subarray(0, end);
      },
      onSessionUpdated: () => () => {},
    },
    folderOf: async () => folder,
    enabled: async () => enabled,
    log: (l) => logs.push(l),
    home,
    manifestFile: join(dir, 'manifest.json'),
  });
  return {
    m,
    setFile,
    setEnabled: (v: boolean) => {
      enabled = v;
    },
  };
}

const projectDir = (): string =>
  join(home, '.claude', 'projects', folder.replace(/[^a-zA-Z0-9]/g, '-'));

describe('hostPathFor', () => {
  it("keys the host folder the way claude does and keeps a subagent's subpath", () => {
    const [claude] = materializeTargets('/h');
    expect(claude!.agent).toBe('claude');
    expect(hostPathFor(claude!, `projects/-workspace/${SID}.jsonl`, '/Users/me/my.app')).toBe(
      `/h/.claude/projects/-Users-me-my-app/${SID}.jsonl`,
    );
    expect(hostPathFor(claude!, `projects/-workspace/${SID}/subagents/agent-1.jsonl`, '/x')).toBe(
      `/h/.claude/projects/-x/${SID}/subagents/agent-1.jsonl`,
    );
    expect(hostPathFor(claude!, 'projects/-workspace/../../etc/x.jsonl', '/x')).toBeNull();
    expect(hostPathFor(claude!, 'todos/x.jsonl', '/x')).toBeNull();
  });
});

describe('createSessionMaterializer', () => {
  it('writes complete lines, rewrites on change, and re-creates a deleted file', async () => {
    const h = harness();
    h.setFile(1, `projects/-workspace/${SID}.jsonl`, '{"a":1}\n{"b":2}\n{"partial');
    h.setFile(2, `projects/-workspace/${SID}/subagents/agent-1.jsonl`, '{"c":3}\n');
    expect((await h.m.session(`claude:${SID}`)).written).toBe(2);
    const main = join(projectDir(), `${SID}.jsonl`);
    expect(await readFile(main, 'utf8')).toBe('{"a":1}\n{"b":2}\n');
    expect(await readFile(join(projectDir(), SID, 'subagents', 'agent-1.jsonl'), 'utf8')).toBe(
      '{"c":3}\n',
    );

    // Unchanged: nothing written.
    expect((await h.m.pass()).written).toBe(0);

    // The hub's copy grew: rewritten.
    h.setFile(1, `projects/-workspace/${SID}.jsonl`, '{"a":1}\n{"b":2}\n{"d":4}\n');
    expect((await h.m.pass()).written).toBe(1);
    expect(await readFile(main, 'utf8')).toBe('{"a":1}\n{"b":2}\n{"d":4}\n');

    // claude's cleanup deleted it: written back.
    await rm(main);
    expect((await h.m.pass()).written).toBe(1);
    expect((await stat(main)).size).toBeGreaterThan(0);
  });

  it("never overwrites a file the host's claude wrote, and logs the collision once", async () => {
    const h = harness();
    await mkdir(projectDir(), { recursive: true });
    const main = join(projectDir(), `${SID}.jsonl`);
    await writeFile(main, 'host\n');
    h.setFile(1, `projects/-workspace/${SID}.jsonl`, '{"a":1}\n');
    await h.m.pass();
    await h.m.pass();
    expect(await readFile(main, 'utf8')).toBe('host\n');
    expect(logs.filter((l) => l.includes('collision')).length).toBe(1);
  });

  it('leaves a copy alone once the host appended to it', async () => {
    const h = harness();
    h.setFile(1, `projects/-workspace/${SID}.jsonl`, '{"a":1}\n');
    await h.m.pass();
    const main = join(projectDir(), `${SID}.jsonl`);
    await writeFile(main, '{"a":1}\n{"host":1}\n');
    await utimes(main, new Date(), new Date(Date.now() + 5000));
    h.setFile(1, `projects/-workspace/${SID}.jsonl`, '{"a":1}\n{"box":2}\n');
    expect((await h.m.pass()).written).toBe(0);
    expect(await readFile(main, 'utf8')).toBe('{"a":1}\n{"host":1}\n');
  });

  it('writes nothing when turned off, for host sessions, or with no folder', async () => {
    const off = harness({ enabled: false });
    off.setFile(1, `projects/-workspace/${SID}.jsonl`, '{"a":1}\n');
    expect((await off.m.pass()).written).toBe(0);

    const host = harness({ session: sessionRow({ boxId: null, provider: 'host' }) });
    host.setFile(1, `projects/-workspace/${SID}.jsonl`, '{"a":1}\n');
    expect((await host.m.pass()).written).toBe(0);

    const codex = harness({ session: sessionRow({ agent: 'codex', key: `codex:${SID}` }) });
    codex.setFile(1, `sessions/x.jsonl`, '{"a":1}\n');
    expect((await codex.m.pass()).written).toBe(0);
    await expect(stat(projectDir())).rejects.toThrow();
  });
});
