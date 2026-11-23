import { Command } from 'commander';
import { fetchAgentDescriptorsOrThrow } from '../agent-registry.js';
import { runMcpBridge } from '../mcp-bridge.js';
import { registerBoxMcp } from '../mcp-register.js';

/**
 * `agentbox-ctl mcp` — the AgentBox MCP server over stdio, registered in each
 * agent's MCP config (`mcp register`, also run by the daemon at start). Every
 * message goes to the hub through this box's relay; stdout carries JSON-RPC
 * only, so diagnostics go to stderr.
 */
export const mcpCommand = new Command('mcp')
  .description("AgentBox MCP server over stdio (session history and memory from the hub)")
  .action(async () => {
    await runMcpBridge({
      input: process.stdin,
      output: process.stdout,
      log: (line) => void process.stderr.write(`agentbox-ctl: ${line}\n`),
    });
    process.exit(0);
  });

mcpCommand
  .command('register')
  .description("Register the AgentBox MCP server in every agent's config file in this box")
  .action(async () => {
    let targets;
    try {
      targets = (await fetchAgentDescriptorsOrThrow()).mcpTargets;
    } catch (err) {
      process.stderr.write(
        `mcp: could not read the agent registry: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
    const results = await registerBoxMcp(targets);
    for (const r of results) {
      process.stdout.write(
        `${r.agent}: ${r.outcome}${r.reason ? ` (${r.reason})` : ''} ${r.file}\n`,
      );
    }
    process.exit(results.some((r) => r.outcome === 'skipped') ? 1 : 0);
  });
