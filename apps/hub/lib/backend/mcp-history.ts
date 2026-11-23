// The history tool set of the hub's MCP server (docs/agent-history-plan.md,
// Phase 6): past sessions and agent memory, read through the same services as
// `/api/v1/history`, and `memory_propose`, which asks a human before it writes.
// A box sees only its own repo's sessions and memory; a hub caller sees all.
import { repoKey } from '@agentbox/config';
import { MEMORY_FILE_MAX_BYTES, safeMemoryPath } from '@agentbox/core';
import type { HistoryService, HistorySessionRow, HistoryTurnRow } from './history';
import type { MemoryKey, MemoryService } from './history-memory';
import { McpToolError, type McpScope, type McpTool } from './mcp';

export interface HistoryMcpDeps {
  history: () => HistoryService | undefined;
  memory: () => MemoryService | undefined;
  log?: (line: string) => void;
}

/** Characters of turn text kept per row in a condensed page. */
const CONDENSED_TEXT_CHARS = 2_000;
/** Characters of text a single tool reply carries before it pages. */
const PAGE_CHARS = 48_000;
const PROPOSAL_PREVIEW_CHARS = 1_500;
/** The history service's own cap on one listing. */
const SESSIONS_LIST_MAX = 500;

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

function int(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isSafeInteger(n) ? Math.min(Math.max(n, min), max) : fallback;
}

function clip(text: string | null, max: number): string | null {
  if (text === null) return null;
  return text.length > max
    ? `${text.slice(0, max)}… [${String(text.length - max)} more chars]`
    : text;
}

function historyOf(deps: HistoryMcpDeps): HistoryService {
  const h = deps.history();
  if (!h) throw new McpToolError('session history is not enabled on this hub');
  return h;
}

function memoryOf(deps: HistoryMcpDeps): MemoryService {
  const m = deps.memory();
  if (!m) throw new McpToolError('agent memory is not enabled on this hub');
  return m;
}

/** The repo a call is limited to: the box's own, or a hub caller's optional `repo`. */
function scopedRepo(scope: McpScope, args: Record<string, unknown>): string | null | undefined {
  if (scope.kind === 'box') return scope.repoKey;
  const raw = str(args.repo);
  if (!raw) return undefined;
  const key = raw.startsWith('local:') ? raw : repoKey(raw);
  if (!key) throw new McpToolError(`not a repository URL: ${raw}`);
  return key;
}

/** Stored URL spellings of the scoped repo; undefined = no limit (hub, no `repo`). */
async function scopeUrls(
  history: HistoryService,
  scope: McpScope,
  args: Record<string, unknown>,
): Promise<string[] | undefined> {
  const key = scopedRepo(scope, args);
  if (key === undefined) return undefined;
  if (key === null) return [];
  return history.projectUrlsFor(key);
}

function visible(scope: McpScope, s: HistorySessionRow): boolean {
  if (scope.kind === 'hub') return true;
  if (!scope.repoKey || !s.projectRepoUrl) return false;
  return s.projectRepoUrl === scope.repoKey || repoKey(s.projectRepoUrl) === scope.repoKey;
}

function sessionSummary(s: HistorySessionRow): Record<string, unknown> {
  return {
    id: s.sessionId,
    agent: s.agent,
    box: s.boxName ?? s.boxId,
    provider: s.provider,
    repo: s.projectRepoUrl,
    title: s.title,
    parentSessionId: s.parentSessionId,
    firstTs: s.firstTs,
    lastTs: s.lastTs,
    turns: s.turns,
  };
}

function memoryKeyOf(scope: McpScope, args: Record<string, unknown>): MemoryKey {
  const key = scopedRepo(scope, args);
  if (key === null) {
    throw new McpToolError("this box's repository is unknown to the hub, so it has no memory");
  }
  if (key === undefined) throw new McpToolError('repo is required: a git remote URL or a repo key');
  return { repoKey: key, agent: str(args.agent) ?? 'claude', scope: 'project' };
}

const repoProp = {
  repo: {
    type: 'string',
    description:
      'Repository (git remote URL in any spelling). Hub callers only; a box is always limited to its own repository.',
  },
};

const READ_ONLY = { readOnlyHint: true, openWorldHint: false };

export function historyMcpTools(deps: HistoryMcpDeps): McpTool[] {
  async function resolveVisible(
    history: HistoryService,
    scope: McpScope,
    ref: string,
  ): Promise<HistorySessionRow> {
    const r = await history.resolveSession(ref);
    // An ambiguous prefix may still name one session this caller can see.
    const keys = r.ok ? [r.key] : r.code === 'ambiguous' ? r.candidates : [];
    const rows: HistorySessionRow[] = [];
    for (const k of keys) {
      const s = await history.repo.getSession(k);
      if (s && visible(scope, s)) rows.push(s);
    }
    if (rows.length === 1) return rows[0]!;
    if (rows.length > 1) {
      throw new McpToolError(
        `"${ref}" matches several sessions: ${rows.map((s) => s.sessionId).join(', ')}`,
      );
    }
    throw new McpToolError(`no session matches "${ref}"`);
  }

  const sessionsList: McpTool = {
    name: 'sessions_list',
    title: 'List past agent sessions',
    description:
      'Past coding-agent sessions recorded by AgentBox (claude, codex, pi, opencode), newest activity first. In a box, only sessions of this repository. Use session_get to read one.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Only this agent (claude, codex, pi, opencode).' },
        box: { type: 'string', description: 'Only sessions from this box (name or id).' },
        since: { type: 'string', description: 'ISO-8601 timestamp: last activity at or after.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        offset: { type: 'integer', minimum: 0, default: 0, description: 'For the next page.' },
        ...repoProp,
      },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    async run(args, scope) {
      const history = historyOf(deps);
      const limit = int(args.limit, 20, 1, 100);
      // listSessions answers at most 500 rows, so a page must end inside them.
      const offset = int(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      if (offset + limit > SESSIONS_LIST_MAX) {
        throw new McpToolError(
          `offset + limit must be at most ${String(SESSIONS_LIST_MAX)}; narrow with agent, box or since`,
        );
      }
      const since = str(args.since);
      const sinceMs = since ? Date.parse(since) : undefined;
      if (sinceMs !== undefined && Number.isNaN(sinceMs)) {
        throw new McpToolError('since must be an ISO-8601 timestamp');
      }
      const projectUrls = await scopeUrls(history, scope, args);
      const rows = await history.listSessions({
        ...(str(args.agent) ? { agent: str(args.agent) } : {}),
        ...(str(args.box) ? { box: str(args.box) } : {}),
        ...(sinceMs !== undefined ? { sinceMs } : {}),
        ...(projectUrls ? { projectUrls } : {}),
        limit: Math.min(offset + limit + 1, SESSIONS_LIST_MAX),
      });
      const page = rows.slice(offset, offset + limit);
      return {
        data: {
          sessions: page.map(sessionSummary),
          ...(rows.length > offset + limit ? { nextOffset: offset + limit } : {}),
          ...(rows.length === SESSIONS_LIST_MAX && offset + limit === SESSIONS_LIST_MAX
            ? { truncated: true }
            : {}),
        },
      };
    },
  };

  const sessionsSearch: McpTool = {
    name: 'sessions_search',
    title: 'Search past agent sessions',
    description:
      'Full-text search over the prompts and replies of past agent sessions (all the words must match; plain words, no query syntax). In a box, only sessions of this repository. Returns snippets with matches in [brackets] and the session id to pass to session_get.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to search for.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        ...repoProp,
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    async run(args, scope) {
      const history = historyOf(deps);
      const q = str(args.query);
      if (!q) throw new McpToolError('query is required');
      const projectUrls = await scopeUrls(history, scope, args);
      const hits = await history.search(q, int(args.limit, 10, 1, 50), {
        ...(projectUrls ? { projectUrls } : {}),
      });
      const sessions = new Map<string, HistorySessionRow | null>();
      const out: Array<Record<string, unknown>> = [];
      for (const h of hits) {
        if (!sessions.has(h.sessionKey)) {
          sessions.set(h.sessionKey, await history.repo.getSession(h.sessionKey));
        }
        const s = sessions.get(h.sessionKey);
        if (!s || !visible(scope, s)) continue;
        out.push({
          session: { id: s.sessionId, agent: s.agent, box: s.boxName ?? s.boxId, title: s.title },
          role: h.role,
          ts: h.ts,
          snippet: h.snippet,
        });
      }
      return { data: { hits: out } };
    },
  };

  const sessionGet: McpTool = {
    name: 'session_get',
    title: 'Read a past agent session',
    description:
      "One past session. By default condensed: the user prompts and the agent's replies (each clipped), with the tools used between them, paged by turn index. detail=full returns every row unclipped for a range (from/to). Pass `nextFrom` back as `from` for the next page.",
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Session id, <agent>:<id>, or an id prefix of at least 8 characters.',
        },
        detail: { type: 'string', enum: ['condensed', 'full'], default: 'condensed' },
        from: { type: 'integer', minimum: 0, default: 0, description: 'First turn index.' },
        to: { type: 'integer', minimum: 0, description: 'Last turn index (inclusive).' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    async run(args, scope) {
      const history = historyOf(deps);
      const ref = str(args.id);
      if (!ref) throw new McpToolError('id is required');
      const s = await resolveVisible(history, scope, ref);
      const full = args.detail === 'full';
      const from = int(args.from, 0, 0, Number.MAX_SAFE_INTEGER);
      const toArg =
        args.to === undefined ? undefined : int(args.to, from, from, Number.MAX_SAFE_INTEGER);
      const span = Math.min((toArg ?? from + 199) - from + 1, 200);
      const rows = await history.sessionTurns(s.key, from, span);
      const items: Array<Record<string, unknown>> = [];
      let chars = 0;
      let nextFrom: number | undefined;
      let pendingTools: string[] = [];
      const flushTools = () => {
        if (pendingTools.length > 0) items.push({ tools: pendingTools });
        pendingTools = [];
      };
      for (const t of rows as HistoryTurnRow[]) {
        if (!full && t.kind === 'tool') {
          if (t.name) pendingTools.push(t.name);
          continue;
        }
        const text = full ? t.text : clip(t.text, CONDENSED_TEXT_CHARS);
        if (chars > 0 && chars + (text?.length ?? 0) > PAGE_CHARS) {
          nextFrom = t.index;
          break;
        }
        flushTools();
        chars += text?.length ?? 0;
        items.push(
          t.kind === 'tool'
            ? { index: t.index, tool: t.name, text, ts: t.ts }
            : { index: t.index, role: t.role, text, ts: t.ts },
        );
      }
      flushTools();
      const total = await history.repo.countTurns(s.key);
      // More rows exist past this page: the default window, or a `to` beyond
      // the 200-row cap.
      const wanted = toArg === undefined ? total - 1 : Math.min(toArg, total - 1);
      if (nextFrom === undefined && rows.length === span && from + span <= wanted) {
        nextFrom = from + span;
      }
      return {
        data: {
          session: sessionSummary(s),
          ...(from === 0 && !full ? { toolCounts: await history.repo.toolCounts(s.key) } : {}),
          totalTurns: total,
          from,
          items,
          ...(nextFrom !== undefined ? { nextFrom } : {}),
        },
      };
    },
  };

  const memoryList: McpTool = {
    name: 'memory_list',
    title: 'List agent memory files',
    description:
      'The agent memory files the hub holds for this repository (latest version of each path). Use memory_get to read one. agent defaults to claude.',
    inputSchema: {
      type: 'object',
      properties: { agent: { type: 'string', default: 'claude' }, ...repoProp },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    async run(args, scope) {
      const memory = memoryOf(deps);
      const key = memoryKeyOf(scope, args);
      const files = await memory.list(key);
      return {
        data: {
          repo: key.repoKey,
          agent: key.agent,
          files: files.map((f) => ({
            path: f.path,
            version: f.version,
            size: f.size,
            updatedAt: new Date(f.updatedAt).toISOString(),
            from: f.origin.boxName ?? f.origin.boxId ?? f.origin.hostId,
          })),
        },
      };
    },
  };

  const memoryGet: McpTool = {
    name: 'memory_get',
    title: 'Read an agent memory file',
    description: 'One agent memory file of this repository (default: its latest version).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path, as memory_list shows it.' },
        version: { type: 'integer', minimum: 1 },
        agent: { type: 'string', default: 'claude' },
        ...repoProp,
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    async run(args, scope) {
      const memory = memoryOf(deps);
      const key = memoryKeyOf(scope, args);
      const path = safeMemoryPath(args.path);
      if (!path) throw new McpToolError('path must be a relative memory file path');
      const version = args.version === undefined ? undefined : int(args.version, 1, 1, 1e9);
      const hit = await memory.file(key, path, version);
      if (!hit) throw new McpToolError(`no memory file ${path}`);
      return {
        data: {
          path,
          version: hit.view.version,
          updatedAt: new Date(hit.view.updatedAt).toISOString(),
          content: clip(hit.bytes.toString('utf8'), PAGE_CHARS),
        },
      };
    },
  };

  const memoryPropose: McpTool = {
    name: 'memory_propose',
    title: 'Propose an agent memory change',
    description:
      "Propose new content for one memory file of this repository (the hub's shared memory, which later boxes start from). A human approves or rejects it; the call returns at once with status pending and does not wait. Write the whole file, not a diff.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path, e.g. feedback-testing.md.' },
        content: { type: 'string', description: 'The complete new file content.' },
        reason: { type: 'string', description: 'One line on why, shown to the approver.' },
        agent: { type: 'string', default: 'claude' },
        ...repoProp,
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async run(args, scope) {
      const memory = memoryOf(deps);
      const key = memoryKeyOf(scope, args);
      const path = safeMemoryPath(args.path);
      if (!path) throw new McpToolError('path must be a relative memory file path');
      if (typeof args.content !== 'string') throw new McpToolError('content is required');
      const bytes = Buffer.from(args.content, 'utf8');
      if (bytes.length > MEMORY_FILE_MAX_BYTES) {
        throw new McpToolError(`content is over ${String(MEMORY_FILE_MAX_BYTES)} bytes`);
      }
      const current = await memory.file(key, path);
      if (current && current.bytes.equals(bytes)) {
        return { data: { status: 'unchanged', path, version: current.view.version } };
      }
      // The proposal is a whole file written against this version. A version
      // that lands before the approval would be lost under it, so the approval
      // then writes nothing.
      const baseVersion = (await memory.versions(key, path)).at(-1)?.version ?? 0;
      const who = scope.kind === 'box' ? `Box ${scope.boxName}` : 'A hub client';
      const reason = str(args.reason);
      const approved = scope.approve({
        message: `${who} proposes ${current ? 'a change to' : 'a new'} ${key.agent} memory file ${path}`,
        detail: `${key.repoKey}${reason ? ` — ${reason.slice(0, 200)}` : ''}`,
        summary: clip(args.content, PROPOSAL_PREVIEW_CHARS) ?? '',
      });
      // Not awaited: the agent goes on while a human decides.
      void approved
        .then(async (yes) => {
          if (!yes) return;
          const latest = (await memory.versions(key, path)).at(-1)?.version ?? 0;
          if (latest !== baseVersion) {
            deps.log?.(
              `mcp: memory_propose ${path} approved but not applied: v${String(latest)} landed after the proposal (based on v${String(baseVersion)})`,
            );
            return;
          }
          const r = await memory.memoryPut({
            repoKey: key.repoKey,
            agent: key.agent,
            scope: key.scope,
            path,
            bytes: await scope.redact(bytes),
            origin: scope.origin,
          });
          deps.log?.(`mcp: memory_propose ${path} approved (v${String(r.version)})`);
        })
        .catch((err: unknown) => {
          deps.log?.(
            `mcp: memory_propose ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      return {
        data: {
          status: 'pending',
          path,
          baseVersion,
          message:
            'Sent for approval. It becomes the shared version once a human approves it, unless the file changes first (then propose again from the new version).',
        },
      };
    },
  };

  return [sessionsList, sessionsSearch, sessionGet, memoryList, memoryGet, memoryPropose];
}
