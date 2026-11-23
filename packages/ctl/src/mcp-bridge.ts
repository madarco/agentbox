/**
 * `agentbox-ctl mcp`: the box's MCP server, as an agent sees it. A stdio
 * server (newline-delimited JSON-RPC) that forwards every message to the hub
 * as an `mcp.message` RPC over the box's existing relay channel, so the box
 * authenticates with its own relay token and never holds the hub's
 * (docs/agent-history-plan.md, Phase 6). The tools live hub-side.
 */
import { createInterface } from 'node:readline';
import { MCP_RPC_METHOD } from '@agentbox/core';
import { postRpcAwait } from './relay-rpc.js';

/** One message to the hub; resolves to its reply (`null` for a notification). */
export type McpForward = (message: unknown) => Promise<unknown>;

// A tool call reads the hub's store; a cloud box's RPC also waits for the
// host's next poll. Anything slower is a host that is not there.
const FORWARD_TIMEOUT_MS = 60_000;

interface JsonRpcLike {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
}

function idOf(m: unknown): string | number | null {
  const id = (m as JsonRpcLike | null)?.id;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

function isRequest(m: unknown): boolean {
  const o = m as JsonRpcLike | null;
  return !!o && typeof o.method === 'string' && idOf(m) !== null;
}

function errorReply(id: string | number | null, code: number, message: string): unknown {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** The relay transport: `mcp.message` over `/rpc` (docker) or the parked cloud path. */
export const relayMcpForward: McpForward = async (message) => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
    timer = setTimeout(
      () => resolve({ exitCode: 124, stdout: '', stderr: 'timed out waiting for the relay' }),
      FORWARD_TIMEOUT_MS,
    );
  });
  try {
    const r = await Promise.race([
      postRpcAwait(MCP_RPC_METHOD, { message }, { quiet: true }),
      timeout,
    ]);
    if (r.exitCode !== 0) {
      const why = r.stderr.trim() || `exit ${String(r.exitCode)}`;
      throw new Error(`the AgentBox relay did not answer (${why})`);
    }
    const body = JSON.parse(r.stdout) as { message?: unknown };
    return body.message ?? null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Serve stdin → hub → stdout until stdin closes. Requests are forwarded
 * concurrently; each reply is written as one line. A transport failure becomes
 * a JSON-RPC error for a request and is dropped for a notification.
 */
export async function runMcpBridge(opts: {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  forward?: McpForward;
  log?: (line: string) => void;
}): Promise<void> {
  const forward = opts.forward ?? relayMcpForward;
  const write = (v: unknown): void => {
    opts.output.write(`${JSON.stringify(v)}\n`);
  };
  const pending = new Set<Promise<void>>();
  const handle = async (line: string): Promise<void> => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      write(errorReply(null, -32700, 'parse error'));
      return;
    }
    try {
      const reply = await forward(message);
      if (reply !== null && reply !== undefined) write(reply);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      opts.log?.(`mcp: ${why}`);
      if (isRequest(message)) write(errorReply(idOf(message), -32603, why));
    }
  };
  const rl = createInterface({ input: opts.input, crlfDelay: Infinity });
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) continue;
    const p = handle(line).finally(() => pending.delete(p));
    pending.add(p);
  }
  await Promise.all(pending);
}
