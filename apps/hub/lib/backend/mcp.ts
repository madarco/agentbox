// The hub's MCP server (docs/agent-history-plan.md, Phase 6): one JSON-RPC
// handler behind both transports, `POST /api/mcp` (hub credential, scope
// `hub`) and a box's `agentbox-ctl mcp` relayed as `mcp.message` (scope
// `box`). Tools come in sets; history registers the first, and skills
// (docs/hub-skills-plan.md, Phase 7) adds its own set next to it.
import type { McpApprovalRequest, McpBoxScope, MemoryOrigin } from '@agentbox/core';

/** A hub-credential caller: sees every repo; a write still asks a human. */
export interface McpHubScope {
  kind: 'hub';
  origin: MemoryOrigin;
  approve(req: McpApprovalRequest): Promise<boolean>;
  redact(bytes: Uint8Array): Promise<Uint8Array>;
}

export type McpScope = McpHubScope | McpBoxScope;

export interface McpToolResult {
  /** JSON-serializable payload, sent as text content and as `structuredContent`. */
  data: Record<string, unknown>;
  isError?: boolean;
}

export interface McpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** `readOnlyHint` etc., passed through to `tools/list`. */
  annotations?: Record<string, unknown>;
  run(args: Record<string, unknown>, scope: McpScope): Promise<McpToolResult>;
}

/** A tool's own failure, reported to the agent as an `isError` result. */
export class McpToolError extends Error {}

/** Sent at `initialize`: what the server is for, so an agent knows when to reach for it. */
export const MCP_INSTRUCTIONS =
  'AgentBox keeps the transcripts of past coding-agent sessions (from every box) and the agents\' shared memory. ' +
  'Use sessions_search to find earlier work by keywords, session_get to read a session, ' +
  'and memory_list / memory_get for the memory files. In a box, results are limited to this repository.';

export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

export interface McpServer {
  /** One message (or a batch); resolves to the reply, or null when none is due. */
  handle(message: unknown, scope: McpScope): Promise<unknown>;
  tools(): McpTool[];
}

type Id = string | number;

const rpcError = (id: Id | null, code: number, message: string): Record<string, unknown> => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Rough size of a reply in model tokens (4 characters each), for paging decisions. */
export function tokensEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

export function createMcpServer(opts: {
  name: string;
  version: string;
  instructions?: string;
  toolSets: ReadonlyArray<() => McpTool[]>;
}): McpServer {
  const tools = (): McpTool[] => opts.toolSets.flatMap((set) => set());

  async function callTool(params: unknown, scope: McpScope): Promise<Record<string, unknown>> {
    const p = isRecord(params) ? params : {};
    const name = typeof p.name === 'string' ? p.name : '';
    const tool = tools().find((t) => t.name === name);
    if (!tool) throw Object.assign(new Error(`unknown tool: ${name}`), { rpcCode: -32602 });
    const args = isRecord(p.arguments) ? p.arguments : {};
    let result: McpToolResult;
    try {
      result = await tool.run(args, scope);
    } catch (err) {
      if (!(err instanceof McpToolError)) throw err;
      result = { data: { error: err.message }, isError: true };
    }
    const body = JSON.stringify(result.data, null, 1);
    const data = { ...result.data, tokensEstimate: tokensEstimate(body) };
    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 1) }],
      structuredContent: data,
      ...(result.isError ? { isError: true } : {}),
    };
  }

  async function one(message: unknown, scope: McpScope): Promise<unknown> {
    if (!isRecord(message)) return rpcError(null, -32600, 'invalid request');
    const method = message.method;
    const rawId = message.id;
    const id: Id | null = typeof rawId === 'string' || typeof rawId === 'number' ? rawId : null;
    // A response or a notification: nothing to answer.
    if (typeof method !== 'string' || id === null) return null;
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
    try {
      switch (method) {
        case 'initialize': {
          const asked = isRecord(message.params) ? message.params.protocolVersion : undefined;
          const protocolVersion = MCP_PROTOCOL_VERSIONS.includes(asked as never)
            ? (asked as string)
            : MCP_PROTOCOL_VERSIONS[0];
          return ok({
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: opts.name, version: opts.version },
            ...(opts.instructions ? { instructions: opts.instructions } : {}),
          });
        }
        case 'ping':
          return ok({});
        case 'tools/list':
          return ok({
            tools: tools().map((t) => ({
              name: t.name,
              ...(t.title ? { title: t.title } : {}),
              description: t.description,
              inputSchema: t.inputSchema,
              ...(t.annotations ? { annotations: t.annotations } : {}),
            })),
          });
        case 'tools/call':
          return ok(await callTool(message.params, scope));
        case 'resources/list':
          return ok({ resources: [] });
        case 'prompts/list':
          return ok({ prompts: [] });
        default:
          return rpcError(id, -32601, `method not found: ${method}`);
      }
    } catch (err) {
      const code = (err as { rpcCode?: number }).rpcCode ?? -32603;
      return rpcError(id, code, err instanceof Error ? err.message : String(err));
    }
  }

  return {
    tools,
    async handle(message, scope) {
      if (Array.isArray(message)) {
        if (message.length === 0) return rpcError(null, -32600, 'empty batch');
        const replies = (await Promise.all(message.map((m) => one(m, scope)))).filter(
          (r) => r !== null,
        );
        return replies.length > 0 ? replies : null;
      }
      return one(message, scope);
    },
  };
}
