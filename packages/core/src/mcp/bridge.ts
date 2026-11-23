/**
 * A stdio MCP server that forwards every newline-delimited JSON-RPC message to
 * somewhere else and writes the replies back (docs/agent-history-plan.md,
 * Phase 6). Shared by `agentbox-ctl mcp` (a box, over its relay) and
 * `agentbox mcp` (a PC, over HTTP to the hub's `/api/mcp`): neither holds the
 * tools, both only carry messages.
 */
import { createInterface } from 'node:readline';

/** One message to the server; resolves to its reply (`null` for a notification). */
export type McpForward = (message: unknown) => Promise<unknown>;

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

/**
 * Serve stdin → hub → stdout until stdin closes. Requests are forwarded
 * concurrently; each reply is written as one line. A transport failure becomes
 * a JSON-RPC error for a request and is dropped for a notification.
 */
export async function runMcpStdioBridge(opts: {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  forward: McpForward;
  log?: (line: string) => void;
}): Promise<void> {
  const forward = opts.forward;
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
