import { Command } from 'commander';
import { runMcpStdioBridge, type McpForward } from '@agentbox/core';
import { resolveHubApiTarget } from './control-plane.js';

/** A tool call reads the hub's store; anything slower is a hub that is not there. */
const REQUEST_TIMEOUT_MS = 60_000;

/** POST one message to `<hub>/api/mcp`; the hub's reply, or null for a notification. */
export function hubMcpForward(target: { url: string; apiKey: string }): McpForward {
  const endpoint = `${target.url.replace(/\/+$/, '')}/api/mcp`;
  return async (message) => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${target.apiKey}`,
        // Reading a skill's files (`skill_get`) is a custody byte read on the
        // hub: an enrolled device's own token passes it, as for `skills --download`.
        'x-agentbox-admin-token': target.apiKey,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 202) return null;
    const text = await res.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error(`the hub answered ${String(res.status)} with no JSON-RPC body`);
    }
  };
}

/**
 * `agentbox mcp` — the hub's MCP server (past sessions and agent memory) as a
 * stdio server for an agent on this PC. Register it with the agent's own MCP
 * command (`claude mcp add agentbox -- agentbox mcp`). The hub credential is
 * read here at run time, so it never lands in the agent's config file, which
 * AgentBox copies into boxes.
 */
export const mcpCommand = new Command('mcp')
  .description(
    "Serve the hub's MCP tools (past sessions, agent memory) over stdio, for an agent on this PC",
  )
  .option('--local', "use this machine's hub instead of a configured control box")
  .action(async (opts: { local?: boolean }) => {
    // stdout carries JSON-RPC only: every diagnostic goes to stderr.
    const target = await resolveHubApiTarget(undefined, {
      quiet: true,
      ...(opts.local ? { preferLocal: true } : {}),
    });
    if (!target) {
      process.stderr.write(
        'agentbox mcp: no hub to reach. Start the local hub (`agentbox hub`) or run `agentbox hub login`.\n',
      );
      process.exit(1);
    }
    await runMcpStdioBridge({
      input: process.stdin,
      output: process.stdout,
      forward: hubMcpForward(target),
      log: (line) => void process.stderr.write(`agentbox mcp: ${line}\n`),
    });
    process.exit(0);
  });
