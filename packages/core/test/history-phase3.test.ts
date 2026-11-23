import { describe, expect, it } from 'vitest';
import {
  HistoryRowCursor,
  parseJsonlChunk,
  resolveSessionFiles,
  resolveSessionFilesFromSizes,
  transcriptRoots,
  validSqliteSource,
  type AgentHistorySqliteTable,
  type HistoryBinding,
  type HistoryFileSource,
  type HistoryRowFiles,
  type HistoryRowSource,
  type ShippedAgent,
} from '../src/index.js';

const CODEX: ShippedAgent = {
  agent: 'codex',
  configDir: '/home/vscode/.codex',
  projectKey: '-workspace',
  spec: {
    transcripts: [
      {
        root: 'sessions',
        format: 'jsonl',
        mode: 'append',
        sessionFiles: ['*/*/*/rollout-*-<sessionId>.jsonl'],
      },
    ],
  },
};
const SID = '019a0000-1111-7222-8333-444444444444';
const ROLLOUT = `/home/vscode/.codex/sessions/2026/11/23/rollout-2026-11-23T10-00-00-${SID}.jsonl`;
const OTHER = `/home/vscode/.codex/sessions/2026/11/23/rollout-2026-11-23T10-00-00-019a0000-9999-7222-8333-444444444444.jsonl`;

function memSource(files: string[]): HistoryFileSource {
  return {
    readBindings: async () => [],
    size: async (p) => (files.includes(p) ? 1 : null),
    read: async () => new Uint8Array(),
    list: async (dir) => {
      const names = new Set<string>();
      for (const f of files) {
        if (!f.startsWith(`${dir}/`)) continue;
        names.add(f.slice(dir.length + 1).split('/')[0]!);
      }
      return names.size ? [...names] : null;
    },
  };
}

describe('session-file globs in any segment', () => {
  it('expands directory globs through list (the ctl path)', async () => {
    const got = await resolveSessionFiles(memSource([ROLLOUT, OTHER]), CODEX, SID);
    expect(got).toEqual([{ abs: ROLLOUT, rel: ROLLOUT.slice('/home/vscode/.codex/'.length) }]);
  });

  it('matches the same files from a scan listing (the docker path)', () => {
    const sizes = new Map([
      [ROLLOUT, 10],
      [OTHER, 10],
    ]);
    expect(resolveSessionFilesFromSizes(sizes, CODEX, SID).map((f) => f.abs)).toEqual([ROLLOUT]);
  });

  it('includes snapshot roots, whose session files are the row cursor output', () => {
    expect(transcriptRoots([CODEX, OPENCODE])).toEqual([
      '/home/vscode/.codex/sessions',
      '/home/vscode/.local/share/opencode/agentbox-history',
    ]);
  });
});

// --- row cursor -------------------------------------------------------------

const TABLES: AgentHistorySqliteTable[] = [
  { name: 'session', id: 'id', session: 'id', updated: 'u' },
  { name: 'message', id: 'id', session: 'session_id', updated: 'u', settleMs: 1000 },
  {
    name: 'part',
    id: 'id',
    session: 'session_id',
    updated: 'u',
    parent: { column: 'message_id', table: 'message' },
    settleMs: 1000,
  },
];
const OPENCODE: ShippedAgent = {
  agent: 'opencode',
  configDir: '/home/vscode/.local/share/opencode',
  projectKey: '-workspace',
  spec: {
    transcripts: [
      {
        root: 'agentbox-history',
        format: 'sqlite',
        mode: 'snapshot',
        sessionFiles: ['<sessionId>.jsonl'],
        sqlite: { db: 'opencode.db', tables: TABLES },
      },
    ],
  },
};
const OSID = 'ses_abcdef0123';
const OUT = `/home/vscode/.local/share/opencode/agentbox-history/${OSID}.jsonl`;

type Row = Record<string, unknown>;

function rowCursorRig() {
  const tables: Record<string, Row[]> = { session: [], message: [], part: [] };
  const disk = new Map<string, string>();
  let stamp = 's1';
  let now = 10_000;
  let opens = 0;
  const bindings: HistoryBinding[] = [{ ts: '', boxId: 'b1', agent: 'opencode', sessionId: OSID }];
  const source: HistoryRowSource = {
    versions: (t, sid) =>
      tables[t.name]!.filter((r) => r[t.session] === sid).map((r) => ({
        id: String(r[t.id]),
        u: Number(r[t.updated]),
        ...(t.parent ? { parent: String(r[t.parent.column]) } : {}),
      })),
    rows: (t, sid, ids) =>
      tables[t.name]!.filter((r) => r[t.session] === sid && ids.includes(String(r[t.id]))),
    sessions: () => [],
    close: () => {},
  };
  const files: HistoryRowFiles = {
    readText: async (p) => disk.get(p) ?? null,
    append: async (p, text) => {
      disk.set(p, (disk.get(p) ?? '') + text);
    },
    writeText: async (p, text) => {
      disk.set(p, text);
    },
    stamp: async () => stamp,
  };
  const cursor = new HistoryRowCursor({
    agents: [OPENCODE],
    boxId: 'b1',
    readBindings: async () => bindings,
    open: () => {
      opens++;
      return source;
    },
    files,
    now: () => now,
  });
  const lines = (): Array<{ t: string; id: string; u: number }> =>
    (disk.get(OUT) ?? '')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { t: string; id: string; u: number });
  return {
    tables,
    disk,
    cursor,
    lines,
    bindings,
    setStamp: (s: string) => (stamp = s),
    setNow: (n: number) => (now = n),
    opens: () => opens,
  };
}

describe('HistoryRowCursor', () => {
  it('writes settled rows, children after their parent, then only changes', async () => {
    const rig = rowCursorRig();
    rig.tables.session!.push({ id: OSID, u: 9_900, title: 't' });
    rig.tables.message!.push({ id: 'm1', session_id: OSID, u: 8_500 });
    rig.tables.part!.push({ id: 'p1', session_id: OSID, message_id: 'm1', u: 8_000 });
    // m2 still streaming: neither it nor its (old) part is written yet.
    rig.tables.message!.push({ id: 'm2', session_id: OSID, u: 9_800 });
    rig.tables.part!.push({ id: 'p2', session_id: OSID, message_id: 'm2', u: 8_000 });

    await rig.cursor.pass();
    expect(rig.lines().map((l) => l.id)).toEqual([OSID, 'm1', 'p1']);

    rig.setNow(20_000);
    await rig.cursor.pass();
    expect(rig.lines().map((l) => l.id)).toEqual([OSID, 'm1', 'p1', 'm2', 'p2']);

    // A changed row is written again; an unchanged one is not.
    rig.tables.session![0]!.u = 19_000;
    rig.setStamp('s2');
    await rig.cursor.pass();
    expect(
      rig
        .lines()
        .map((l) => `${l.id}@${String(l.u)}`)
        .slice(-1),
    ).toEqual([`${OSID}@19000`]);
    expect(rig.lines()).toHaveLength(6);
  });

  it('skips an unchanged db once nothing waits to settle, and a final pass ignores settling', async () => {
    const rig = rowCursorRig();
    rig.tables.message!.push({ id: 'm1', session_id: OSID, u: 9_900 });
    await rig.cursor.pass();
    expect(rig.lines()).toHaveLength(0);
    await rig.cursor.pass(); // m1 still pending: the db is read again
    expect(rig.opens()).toBe(2);
    await rig.cursor.pass({ final: true });
    expect(rig.lines().map((l) => l.id)).toEqual(['m1']);
    await rig.cursor.pass();
    await rig.cursor.pass();
    expect(rig.opens()).toBe(3);
  });

  it("keeps its cursor beside the output and ignores other boxes' bindings", async () => {
    const rig = rowCursorRig();
    rig.bindings.push({ ts: '', boxId: 'other', agent: 'opencode', sessionId: 'ses_foreign01' });
    rig.tables.session!.push({ id: OSID, u: 1 });
    rig.tables.session!.push({ id: 'ses_foreign01', u: 1 });
    await rig.cursor.pass();
    expect([...rig.disk.keys()].sort()).toEqual([OUT.replace(/\.jsonl$/, '.cursor.json'), OUT]);
  });

  it('refuses a source with non-identifier names (they are interpolated into sql)', () => {
    expect(validSqliteSource({ db: 'x.db', tables: TABLES })).toBe(true);
    expect(
      validSqliteSource({ db: 'x.db', tables: [{ ...TABLES[0]!, name: 'session; drop' }] }),
    ).toBe(false);
    expect(validSqliteSource({ db: '../x.db', tables: TABLES })).toBe(false);
    const zstd = { ...TABLES[1]!, zstd: { column: 'blob', into: 'text' } };
    expect(validSqliteSource({ db: 'x.db', tables: [zstd] })).toBe(true);
    expect(
      validSqliteSource({
        db: 'x.db',
        tables: [{ ...zstd, zstd: { column: 'blob', into: 'text) --' } }],
      }),
    ).toBe(false);
    expect(
      validSqliteSource({
        db: 'x.db',
        tables: TABLES,
        sessions: { table: 'session', column: 'id; drop' },
      }),
    ).toBe(false);
  });
});

describe('HistoryRowCursor, a `sessions` source (openclaw)', () => {
  const SID_A = '7241fdc1-21e3-4d4e-929a-e49794bad4c4';
  const SID_B = '0bd2a7a0-0e3c-4f55-9a61-5b6f3a4c0d11';
  const CLAW: ShippedAgent = {
    agent: 'openclaw',
    configDir: '/home/vscode/.openclaw',
    projectKey: '-workspace',
    spec: {
      transcripts: [
        {
          root: 'agentbox-history',
          format: 'sqlite',
          mode: 'snapshot',
          sessionFiles: ['<sessionId>.jsonl'],
          sqlite: {
            db: 'agents/main/agent/openclaw-agent.sqlite',
            sessions: { table: 'session_windows', column: 'session_id' },
            tables: [{ name: 'transcript_events', id: 'seq', session: 'session_id', updated: 'c' }],
          },
        },
      ],
    },
  };

  it('binds and copies every session in the db, with per-session ids in number order', async () => {
    const events: Row[] = [
      { session_id: SID_A, seq: 10, c: 5, event_json: 'a10' },
      { session_id: SID_A, seq: 9, c: 5, event_json: 'a9' },
      { session_id: SID_B, seq: 9, c: 5, event_json: 'b9' },
    ];
    const bindings: HistoryBinding[] = [
      { ts: '', boxId: 'b1', agent: 'openclaw', sessionId: SID_A },
    ];
    const bound: string[] = [];
    const disk = new Map<string, string>();
    const cursor = new HistoryRowCursor({
      agents: [CLAW],
      boxId: 'b1',
      readBindings: async () => bindings,
      bind: (agent, sid) => {
        bound.push(`${agent}:${sid}`);
      },
      open: () => ({
        versions: (t, sid) =>
          events
            .filter((r) => r.session_id === sid)
            .map((r) => ({ id: String(r[t.id]), u: Number(r[t.updated]) })),
        rows: (t, sid, ids) =>
          events.filter((r) => r.session_id === sid && ids.includes(String(r[t.id]))),
        sessions: () => [SID_A, SID_B, 'bad id'],
        close: () => {},
      }),
      files: {
        readText: async (p) => disk.get(p) ?? null,
        append: async (p, text) => {
          disk.set(p, (disk.get(p) ?? '') + text);
        },
        writeText: async (p, text) => {
          disk.set(p, text);
        },
        stamp: async () => 's1',
      },
      now: () => 100,
    });
    await cursor.pass();
    // Only the unbound, well-formed session is bound; both are copied.
    expect(bound).toEqual([`openclaw:${SID_B}`]);
    const out = (sid: string) =>
      (disk.get(`/home/vscode/.openclaw/agentbox-history/${sid}.jsonl`) ?? '')
        .split('\n')
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as { row: { event_json: string } }).row.event_json);
    expect(out(SID_A)).toEqual(['a9', 'a10']);
    expect(out(SID_B)).toEqual(['b9']);
  });
});

describe('parseJsonlChunk', () => {
  it('carries a partial line and keeps the parser state keys', () => {
    const seen: number[] = [];
    const onLine = (_l: Record<string, unknown>, at: number, st: Record<string, unknown>) => {
      seen.push(at);
      st.count = Number(st.count ?? 0) + 1;
      return [];
    };
    const a = parseJsonlChunk(
      { path: 'f', offset: 0, bytes: Buffer.from('{"a":1}\n{"b"') },
      {},
      onLine,
    );
    expect(a.state.partial).toBeDefined();
    const b = parseJsonlChunk(
      { path: 'f', offset: 12, bytes: Buffer.from(':2}\n') },
      a.state,
      onLine,
    );
    expect(seen).toEqual([0, 8]);
    expect(b.state).toEqual({ count: 2 });
  });
});
