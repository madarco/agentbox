/**
 * `agentbox-ctl mcp`: the box's MCP server, as an agent sees it. A stdio
 * server (newline-delimited JSON-RPC) that forwards every message to the hub
 * as an `mcp.message` RPC over the box's existing relay channel, so the box
 * authenticates with its own relay token and never holds the hub's
 * (docs/agent-history-plan.md, Phase 6). The tools live hub-side.
 */
import { MCP_RPC_METHOD, runMcpStdioBridge, type McpForward } from '@agentbox/core';
import { postRpcAwait } from './relay-rpc.js';

export type { McpForward };

// A tool call reads the hub's store; a cloud box's RPC also waits for the
// host's next poll. Anything slower is a host that is not there.
const FORWARD_TIMEOUT_MS = 60_000;

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

/** Serve stdin -> hub (through this box's relay) -> stdout until stdin closes. */
export function runMcpBridge(opts: {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  forward?: McpForward;
  log?: (line: string) => void;
}): Promise<void> {
  return runMcpStdioBridge({ ...opts, forward: opts.forward ?? relayMcpForward });
}
