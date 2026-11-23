import type { McpApprovalRequest, McpBoxHandler, McpBoxScope } from '@agentbox/core';
import { askPrompt, type PendingPrompts, type PromptSubscribers } from './prompts.js';

/** An MCP approval (a proposal) left unanswered resolves to no after a day. */
export const MCP_APPROVAL_TTL_MS = 24 * 60 * 60_000;

/**
 * Park an MCP approval (a `memory_propose`, a skill proposal or install) in the prompt mailbox, where the
 * web UI, the tray and an attached footer answer it. Never auto-denied for want
 * of an attached client: it waits for a human until the TTL.
 */
export function askMcpApproval(
  prompts: PendingPrompts,
  subscribers: PromptSubscribers,
  boxId: string,
  req: McpApprovalRequest,
): Promise<boolean> {
  return askPrompt(
    prompts,
    subscribers,
    boxId,
    {
      kind: 'confirm',
      message: req.message,
      ...(req.detail ? { detail: req.detail } : {}),
      defaultAnswer: 'n',
      context: { command: req.command ?? 'memory_propose' },
      ...(req.summary ? { richDetail: { type: 'text', summary: req.summary } } : {}),
    },
    { ttlMs: MCP_APPROVAL_TTL_MS, ...(req.noAutoApprove ? { noAutoApprove: true } : {}) },
  ).then((r) => r.answer === 'y' && r.cancelled !== true);
}

export interface McpRpcResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * `mcp.message` for one authenticated box (docs/agent-history-plan.md, Phase 6):
 * `{message}` in, `{message}` out, where `message` is one JSON-RPC message for
 * the hub's MCP server. The single handler behind server.ts `/rpc` and the
 * cloud executor. Always exit 0, so ctl can tell an MCP error from a dead
 * transport; a relay with no hub answers every request with a JSON-RPC error.
 */
export async function runMcpRpc(
  handler: McpBoxHandler | null,
  scope: () => Promise<McpBoxScope>,
  method: string,
  params: unknown,
): Promise<McpRpcResult> {
  if (method !== 'mcp.message') {
    return { exitCode: 64, stdout: '', stderr: `unknown mcp method '${method}'\n` };
  }
  const message = (params as { message?: unknown } | null)?.message;
  const reply = (v: unknown): McpRpcResult => ({
    exitCode: 0,
    stdout: JSON.stringify({ message: v ?? null }),
    stderr: '',
  });
  const id = (message as { id?: unknown } | null)?.id;
  const isRequest =
    typeof (message as { method?: unknown } | null)?.method === 'string' &&
    (typeof id === 'string' || typeof id === 'number');
  const error = (code: number, text: string): McpRpcResult =>
    reply(isRequest ? { jsonrpc: '2.0', id, error: { code, message: text } } : null);
  if (!handler) return error(-32601, 'this relay has no hub: AgentBox MCP is not available');
  try {
    return reply(await handler(await scope(), message));
  } catch (e) {
    return error(-32603, e instanceof Error ? e.message : String(e));
  }
}
