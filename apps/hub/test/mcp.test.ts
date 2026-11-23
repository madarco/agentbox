import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  registerAgentHistoryModule,
  type AgentHistoryModule,
  type HistoryRecord,
  type McpApprovalRequest,
  type McpBoxScope,
} from '@agentbox/core';
import { createHistoryService, type HistoryArchive } from '../lib/backend/history';
import { createMemoryService } from '../lib/backend/history-memory';
import { createMcpServer, type McpHubScope, type McpScope } from '../lib/backend/mcp';
import { historyMcpTools } from '../lib/backend/mcp-history';
import { openSqliteHistoryRepo, openSqliteMemoryRepo } from '../lib/history-sqlite';

const mod: AgentHistoryModule = {
  id: 'claude',
  parserVersion: 1,
  identify(_head, path) {
    return { sessionId: path.slice(path.lastIndexOf('/') + 1).replace(/\.jsonl$/, '') };
  },
  parse(chunk) {
    const records: HistoryRecord[] = [];
    let at = chunk.offset;
    for (const raw of Buffer.from(chunk.bytes).toString('utf8').split('\n')) {
      if (!raw) continue;
      const l = JSON.parse(raw) as { role: 'user' | 'assistant'; text?: string; tool?: string };
      if (l.tool) records.push({ kind: 'tool', name: l.tool, at });
      else
        records.push({
          kind: 'turn',
          role: l.role,
          text: l.text ?? '',
          at,
          ts: '2026-11-23T10:00:00Z',
        });
      at += Buffer.byteLength(raw) + 1;
    }
    return { records, state: {} };
  },
};
beforeAll(() => registerAgentHistoryModule(mod));

function memArchive(): HistoryArchive {
  const m = new Map<string, Buffer>();
  return {
    put: async (k, b) => void m.set(k, Buffer.from(b)),
    get: async (k) => m.get(k) ?? Buffer.alloc(0),
    delete: async (k) => void m.delete(k),
  };
}

const A = 'aaaaaaaa-1111-2222-3333-444444444444';
const B = 'bbbbbbbb-1111-2222-3333-444444444444';
const C = 'cccccccc-1111-2222-3333-444444444444';

async function setup() {
  const history = createHistoryService({
    repo: await openSqliteHistoryRepo(':memory:'),
    archive: memArchive(),
    retentionDays: 90,
  });
  const memory = createMemoryService({ repo: await openSqliteMemoryRepo(':memory:') });
  const ship = async (id: string, boxId: string, repo: string, lines: object[]) => {
    const data = Buffer.from(lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
    await history.ingest({
      origin: { boxId, boxName: boxId, provider: 'docker', projectRepoUrl: repo },
      agent: 'claude',
      path: `projects/-workspace/${id}.jsonl`,
      offset: 0,
      sha256Prefix: '',
      sha256: createHash('sha256').update(data).digest('hex'),
      data: data.toString('base64'),
    });
  };
  // Same repo in two spellings, plus another repo.
  await ship(A, 'box-a', 'git@github.com:Owner/Repo.git', [
    { role: 'user', text: 'remember the pineapple codeword' },
    { role: 'assistant', tool: 'Bash' },
    { role: 'assistant', text: 'The codeword is PINEAPPLE-42' },
  ]);
  await ship(B, 'box-b', 'https://github.com/owner/repo', [
    { role: 'user', text: 'unrelated pineapple chat' },
  ]);
  await ship(C, 'box-c', 'https://github.com/other/secret', [
    { role: 'user', text: 'secret pineapple project' },
  ]);
  const server = createMcpServer({
    name: 'agentbox',
    version: 'test',
    toolSets: [() => historyMcpTools({ history: () => history, memory: () => memory })],
  });
  return { history, memory, server };
}

function boxScope(repoKey: string | null, approvals: McpApprovalRequest[] = []): McpBoxScope {
  return {
    kind: 'box',
    boxId: 'box-new',
    boxName: 'box-new',
    repoKey,
    origin: { boxId: 'box-new', boxName: 'box-new', provider: 'docker' },
    approve: async (req) => {
      approvals.push(req);
      return true;
    },
    redact: async (b) =>
      Buffer.from(
        Buffer.from(b)
          .toString()
          .replace(/s3cr3t/g, '******'),
      ),
  };
}

const hubScope: McpHubScope = {
  kind: 'hub',
  origin: { boxId: null },
  approve: async () => false,
  redact: async (b) => b,
};

let nextId = 1;
async function call(
  server: Awaited<ReturnType<typeof setup>>['server'],
  scope: McpScope,
  name: string,
  args: Record<string, unknown>,
) {
  const reply = (await server.handle(
    { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } },
    scope,
  )) as { result?: { structuredContent: Record<string, unknown>; isError?: boolean } };
  return reply.result!;
}

describe('MCP protocol', () => {
  it('initializes, lists tools, answers ping, ignores notifications', async () => {
    const { server } = await setup();
    const init = (await server.handle(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
      hubScope,
    )) as { result: { protocolVersion: string; capabilities: unknown } };
    expect(init.result.protocolVersion).toBe('2025-03-26');
    expect(init.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(
      await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, hubScope),
    ).toBeNull();
    const list = (await server.handle(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      hubScope,
    )) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((t) => t.name)).toEqual([
      'sessions_list',
      'sessions_search',
      'session_get',
      'memory_list',
      'memory_get',
      'memory_propose',
    ]);
    expect(await server.handle({ jsonrpc: '2.0', id: 3, method: 'ping' }, hubScope)).toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: {},
    });
    const unknown = (await server.handle({ jsonrpc: '2.0', id: 4, method: 'nope' }, hubScope)) as {
      error: { code: number };
    };
    expect(unknown.error.code).toBe(-32601);
    const badTool = (await server.handle(
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } },
      hubScope,
    )) as { error: { code: number } };
    expect(badTool.error.code).toBe(-32602);
  });
});

describe('history tools', () => {
  it("limits a box to its own repository's sessions, across URL spellings", async () => {
    const { server } = await setup();
    const scope = boxScope('github.com/owner/repo');
    const list = await call(server, scope, 'sessions_list', {});
    expect(
      (list.structuredContent.sessions as Array<{ id: string }>).map((s) => s.id).sort(),
    ).toEqual([A, B]);
    const hits = await call(server, scope, 'sessions_search', { query: 'pineapple' });
    const ids = (hits.structuredContent.hits as Array<{ session: { id: string } }>).map(
      (h) => h.session.id,
    );
    expect(ids).toContain(A);
    expect(ids).not.toContain(C);
    // Another repo's session is not readable, even by its full id.
    const other = await call(server, scope, 'session_get', { id: C });
    expect(other.isError).toBe(true);
    // A box whose repo is unknown sees nothing.
    const none = await call(server, boxScope(null), 'sessions_list', {});
    expect(none.structuredContent.sessions).toEqual([]);
    // The hub sees everything.
    const all = await call(server, hubScope, 'sessions_list', {});
    expect((all.structuredContent.sessions as unknown[]).length).toBe(3);
    const scoped = await call(server, hubScope, 'sessions_list', {
      repo: 'https://github.com/other/secret.git',
    });
    expect((scoped.structuredContent.sessions as Array<{ id: string }>).map((s) => s.id)).toEqual([
      C,
    ]);
  });

  it('condenses a session: prompts and replies, tools between them, a token estimate', async () => {
    const { server } = await setup();
    const got = await call(server, boxScope('github.com/owner/repo'), 'session_get', {
      id: A.slice(0, 8),
    });
    const items = got.structuredContent.items as Array<Record<string, unknown>>;
    expect(items).toEqual([
      expect.objectContaining({ role: 'user', text: 'remember the pineapple codeword' }),
      { tools: ['Bash'] },
      expect.objectContaining({ role: 'assistant', text: 'The codeword is PINEAPPLE-42' }),
    ]);
    expect(got.structuredContent.totalTurns).toBe(3);
    expect(got.structuredContent.tokensEstimate).toBeGreaterThan(0);
    const full = await call(server, boxScope('github.com/owner/repo'), 'session_get', {
      id: A,
      detail: 'full',
      from: 1,
      to: 1,
    });
    expect(full.structuredContent.items).toEqual([
      expect.objectContaining({ index: 1, tool: 'Bash' }),
    ]);
  });

  it('proposes memory through an approval, redacted, and returns before it is answered', async () => {
    const { server, memory } = await setup();
    const approvals: McpApprovalRequest[] = [];
    const scope = boxScope('github.com/owner/repo', approvals);
    const r = await call(server, scope, 'memory_propose', {
      path: 'feedback-tests.md',
      content: 'run the tests first; token s3cr3t',
      reason: 'learned today',
    });
    expect(r.structuredContent.status).toBe('pending');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.message).toContain('feedback-tests.md');
    await new Promise((res) => setTimeout(res, 20));
    const key = { repoKey: 'github.com/owner/repo', agent: 'claude', scope: 'project' as const };
    const file = await memory.file(key, 'feedback-tests.md');
    expect(file?.bytes.toString()).toBe('run the tests first; token ******');
    expect(file?.view.origin.boxId).toBe('box-new');
    const list = await call(server, scope, 'memory_list', {});
    expect((list.structuredContent.files as Array<{ path: string }>).map((f) => f.path)).toEqual([
      'feedback-tests.md',
    ]);
    const got = await call(server, scope, 'memory_get', { path: 'feedback-tests.md' });
    expect(got.structuredContent.content).toBe('run the tests first; token ******');
    // A rejected proposal writes nothing; an unsafe path is refused outright.
    const rejected = await call(
      server,
      { ...scope, approve: async () => false },
      'memory_propose',
      {
        path: 'other.md',
        content: 'x',
      },
    );
    expect(rejected.structuredContent.status).toBe('pending');
    await new Promise((res) => setTimeout(res, 20));
    expect(await memory.file(key, 'other.md')).toBeNull();
    const bad = await call(server, scope, 'memory_propose', {
      path: '../etc/passwd',
      content: 'x',
    });
    expect(bad.isError).toBe(true);
    // The hub must name a repo; a box with no repo cannot propose.
    expect((await call(server, hubScope, 'memory_list', {})).isError).toBe(true);
    expect((await call(server, boxScope(null), 'memory_list', {})).isError).toBe(true);
  });

  it('drops an approved proposal whose base version was superseded', async () => {
    const { server, memory } = await setup();
    let approve!: (v: boolean) => void;
    const scope = {
      ...boxScope('github.com/owner/repo'),
      approve: () => new Promise<boolean>((res) => (approve = res)),
    };
    const key = { repoKey: 'github.com/owner/repo', agent: 'claude', scope: 'project' as const };
    const r = await call(server, scope, 'memory_propose', { path: 'x.md', content: 'mine' });
    expect(r.structuredContent.baseVersion).toBe(0);
    await memory.memoryPut({ ...key, path: 'x.md', bytes: Buffer.from('newer'), origin: { boxId: 'b2' } });
    approve(true);
    await new Promise((res) => setTimeout(res, 20));
    expect((await memory.file(key, 'x.md'))?.bytes.toString()).toBe('newer');
  });

  it('pages sessions_list inside the 500-row listing and flags a capped session_get range', async () => {
    const { server } = await setup();
    const big = await call(server, hubScope, 'sessions_list', { offset: 490, limit: 20 });
    expect(big.isError).toBe(true);
    const got = await call(server, hubScope, 'session_get', { id: A, detail: 'full', from: 0, to: 1 });
    expect(got.structuredContent.nextFrom).toBeUndefined();
  });
});
