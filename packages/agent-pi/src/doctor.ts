import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CheckResult } from '@agentbox/sandbox-core';

/** Count MCP declarations without ever returning server names, commands, or env values. */
function mcpServerCount(value: unknown): number {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
  return Object.keys(value as Record<string, unknown>).length;
}

/**
 * Warn when Pi is present but its MCP definitions live outside the Pi root that
 * AgentBox syncs. These files often contain credential-bearing `env` blocks,
 * so discovery is deliberately count-only: AgentBox neither reads values into
 * the result nor copies the files. The fix is an explicit, reviewed Pi MCP
 * config, not an implicit credential migration.
 */
export async function checkExternalPiMcpConfigs(
  hostHome: string = homedir(),
): Promise<CheckResult | null> {
  if (!existsSync(join(hostHome, '.pi', 'agent'))) return null;

  const found: string[] = [];
  const inspect = async (
    rel: string[],
    label: string,
    count: (json: Record<string, unknown>) => number,
  ): Promise<void> => {
    try {
      const raw = await readFile(join(hostHome, ...rel), 'utf8');
      const json = JSON.parse(raw) as Record<string, unknown>;
      const total = count(json);
      if (total > 0) found.push(`${label} (${String(total)})`);
    } catch {
      // Missing, unreadable, and malformed external files are not Pi sync facts.
    }
  };

  await Promise.all([
    inspect(['.config', 'mcp', 'mcp.json'], '~/.config/mcp/mcp.json', (json) =>
      mcpServerCount(json.mcpServers),
    ),
    inspect(['.claude.json'], '~/.claude.json', (json) => {
      let total = mcpServerCount(json.mcpServers);
      const projects = json.projects;
      if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
        for (const project of Object.values(projects as Record<string, unknown>)) {
          if (project && typeof project === 'object' && !Array.isArray(project)) {
            total += mcpServerCount((project as Record<string, unknown>).mcpServers);
          }
        }
      }
      return total;
    }),
  ]);

  if (found.length === 0) return null;
  return {
    label: 'pi MCP config',
    status: 'warn',
    detail: `${found.join(', ')} declare MCP servers outside ~/.pi/agent and will not be copied into Pi boxes`,
    hint: 'define reviewed non-secret servers in ~/.pi/agent/mcp.json; keep credentials in scoped env or provider-owned stores',
  };
}
