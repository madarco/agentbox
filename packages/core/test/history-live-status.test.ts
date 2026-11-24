// Live status (docs/agent-live-status-plan.md, Phase 3): the row cursor's
// `jsonl` source (codex's shared session_index.jsonl) and the working-on line.
import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_MAX,
  HistoryRowCursor,
  activityLine,
  commandSummary,
  toolActivity,
  validSqliteSource,
  type HistoryBinding,
  type ShippedAgent,
} from '../src/index.js';

const SID = '019a0000-1111-7222-8333-444444444444';
const OTHER = '019a0000-9999-7222-8333-444444444444';
const INDEX = '/home/vscode/.codex/session_index.jsonl';
const OUT = `/home/vscode/.codex/agentbox-history/${SID}.index.jsonl`;

const CODEX: ShippedAgent = {
  agent: 'codex',
  configDir: '/home/vscode/.codex',
  projectKey: '-workspace',
  spec: {
    transcripts: [
      {
        root: 'agentbox-history',
        format: 'jsonl',
        mode: 'snapshot',
        sessionFiles: ['<sessionId>.index.jsonl'],
        sqlite: {
          db: 'session_index.jsonl',
          format: 'jsonl',
          tables: [{ name: 'session_index', id: 'line', session: 'id', updated: 'line' }],
        },
      },
    ],
  },
};

const row = (id: string, name: string) =>
  `${JSON.stringify({ id, thread_name: name, updated_at: '2026-11-24T10:00:00Z' })}\n`;

function rig() {
  const disk = new Map<string, string>();
  let stamp = 0;
  const bindings: HistoryBinding[] = [{ ts: 't', boxId: 'b1', agent: 'codex', sessionId: SID }];
  const cursor = new HistoryRowCursor({
    agents: [CODEX],
    boxId: 'b1',
    readBindings: async () => bindings,
    open: () => {
      throw new Error('a jsonl source must not open a db');
    },
    files: {
      readText: async (p) => disk.get(p) ?? null,
      append: async (p, text) => {
        disk.set(p, (disk.get(p) ?? '') + text);
      },
      writeText: async (p, text) => {
        disk.set(p, text);
      },
      rename: async () => {},
      stamp: async (p) => (disk.has(p) ? String(stamp) : null),
    },
  });
  const write = (text: string) => {
    disk.set(INDEX, (disk.get(INDEX) ?? '') + text);
    stamp++;
  };
  const out = () =>
    (disk.get(OUT) ?? '')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { t: string; row: { id: string; thread_name: string } });
  return { cursor, write, out };
}

describe('row cursor, a jsonl source', () => {
  it('is valid only with exactly one table', () => {
    const src = CODEX.spec.transcripts[0]!.sqlite!;
    expect(validSqliteSource(src)).toBe(true);
    expect(validSqliteSource({ ...src, tables: [...src.tables, ...src.tables] })).toBe(false);
  });

  it('copies only the bound session lines, each once, as they are appended', async () => {
    const r = rig();
    r.write(row(OTHER, 'not ours') + row(SID, 'Add health route'));
    await r.cursor.pass();
    expect(r.out().map((l) => l.row.thread_name)).toEqual(['Add health route']);
    await r.cursor.pass();
    expect(r.out()).toHaveLength(1);
    r.write(row(SID, 'renamed') + row(OTHER, 'still not ours'));
    await r.cursor.pass();
    expect(r.out().map((l) => `${l.t}:${l.row.thread_name}`)).toEqual([
      'session_index:Add health route',
      'session_index:renamed',
    ]);
  });

  it('skips a torn last line and copies it once complete', async () => {
    const r = rig();
    const full = row(SID, 'late');
    r.write(full.slice(0, 10));
    await r.cursor.pass();
    expect(r.out()).toEqual([]);
    r.write(full.slice(10));
    await r.cursor.pass();
    expect(r.out().map((l) => l.row.thread_name)).toEqual(['late']);
  });
});

describe('activityLine / toolActivity', () => {
  it('is one line, clipped', () => {
    expect(activityLine('  a\n\tb  ')).toBe('a b');
    const long = activityLine('word '.repeat(100));
    expect(long.length).toBe(ACTIVITY_MAX);
    expect(long.endsWith('…')).toBe(true);
  });

  it('redacts a known secret format', () => {
    const line = activityLine(`export GITHUB_TOKEN=ghp_${'A1b2C3d4E5'.repeat(4)}`);
    expect(line).not.toContain('A1b2C3d4E5');
  });

  it('describes a call by its short fields, never a payload', () => {
    expect(toolActivity('Write', { file_path: 'a.ts', content: 'body' })).toBe('Write: a.ts');
    expect(toolActivity('Bash', { command: 'npm test', description: 'Run tests' })).toBe(
      'Bash: Run tests',
    );
    expect(toolActivity('exec', { command: ['git', 'status'] })).toBe('exec: git status');
    expect(toolActivity('TodoWrite', { todos: [{ content: 'x' }] })).toBe('TodoWrite');
  });
});

describe('commandSummary', () => {
  it('keeps the program and a plain first argument', () => {
    expect(commandSummary('npm test')).toBe('npm test');
    expect(commandSummary('git status --short')).toBe('git status');
    expect(commandSummary(['/usr/bin/node', '--check', 'server.js'])).toBe('node --check');
  });

  it('never shows a heredoc body, a redirect target or a second command', () => {
    const cmd = 'cat > .env <<EOF\nFOO=s3cr3tValue-1234567890abcdef\nEOF';
    expect(commandSummary(cmd)).toBe('cat');
    expect(commandSummary(`bash -lc "${cmd}"`)).toBe('cat');
    expect(commandSummary(['bash', '-lc', cmd])).toBe('cat');
    expect(commandSummary('echo hi && curl -H "Authorization: Bearer abc" x')).toBe('echo hi');
  });

  it('drops leading assignments, prefixes, quoted payloads and inline scripts', () => {
    expect(commandSummary('API_KEY=abcdef1234567890XYZ npm run deploy')).toBe('npm run');
    expect(commandSummary('sudo env FOO=1 apt-get install -y jq')).toBe('apt-get install');
    expect(commandSummary(`node -e 'console.log(process.env.TOKEN)'`)).toBe('node -e');
    expect(commandSummary(`python3 -c "import os; print(os.environ)"`)).toBe('python3 -c');
    expect(commandSummary(`curl "https://x.test/?token=abc"`)).toBe('curl');
    expect(commandSummary('$(cat secret) --flag')).toBe('');
  });

  it('a secret-shaped argument is left out', () => {
    expect(commandSummary('login ghp_A1b2C3d4E5f6G7h8I9j0K1l2')).toBe('login');
  });

  it('toolActivity prefers the description and summarizes a command', () => {
    expect(toolActivity('Bash', { command: 'cat > .env <<EOF\nX=1\nEOF' })).toBe('Bash: cat');
    expect(toolActivity('Bash', { command: 'cat > .env', description: 'Write env' })).toBe(
      'Bash: Write env',
    );
    expect(toolActivity('WebFetch', { url: 'https://api.test/v1?key=abc#frag' })).toBe(
      'WebFetch: https://api.test/v1',
    );
  });
});
