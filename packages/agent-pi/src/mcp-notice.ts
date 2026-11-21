/**
 * Where Pi's MCP server definitions live, as far as a box is concerned.
 *
 * Pi has no MCP client of its own; MCP comes from an extension, and the common
 * one reads definitions from more places than `~/.pi/agent`: a shared
 * `~/.config/mcp/mcp.json`, and an `imports` list in `~/.pi/agent/mcp.json`
 * that pulls servers out of other tools' configs (Claude Code, Cursor, …).
 * AgentBox copies only `~/.pi/agent`, so a box built from such a setup looks
 * like it lost its MCP servers.
 *
 * AgentBox does NOT fix that by copying more: MCP configs routinely carry API
 * keys and tokens in `env`/`headers`, and those files belong to other tools.
 * It tells the user instead. `~/.pi/agent/mcp.json` itself IS copied, even as
 * a symlink out of the folder (what stow and chezmoi produce): it is Pi's own
 * config, so the notice only says the box gets the linked file's contents. Every message carries a file path and COUNTS
 * only (servers, import sources) — never a server name, an import-source
 * name, or any part of a definition.
 */

import { lstat, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';

/** The MCP config files Pi's extensions read from inside `~/.pi/agent`. */
const PI_MCP_FILES = ['mcp.json'] as const;

/** The shared, tool-neutral MCP config that Pi's MCP extension also reads. */
const SHARED_MCP_REL = ['.config', 'mcp', 'mcp.json'] as const;

export interface PiMcpScan {
  /** One user-facing line per finding. File paths and counts only. */
  notices: string[];
}

function isUnder(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** `~`-relative for display, so a notice does not spell out the user's home. */
function tilde(hostHome: string, p: string): string {
  const rel = relative(hostHome, p);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? `~/${rel}` : p;
}

/** Parsed JSON object, or null for a missing / unreadable / non-object file. */
async function readJsonObject(file: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * How many servers a config defines, or null when it cannot be told. Counts
 * keys only: a server's name can itself be revealing, and its body is where
 * the tokens live, so neither is ever read into a message.
 */
function countServers(cfg: Record<string, unknown> | null): number | null {
  if (!cfg) return null;
  for (const key of ['mcpServers', 'servers']) {
    const v = cfg[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) return Object.keys(v).length;
  }
  return null;
}

/** `2 MCP servers`, or a neutral phrase when the count is unknown. */
function servers(n: number | null): string {
  if (n === null) return 'MCP servers';
  return `${String(n)} MCP server${n === 1 ? '' : 's'}`;
}

async function exists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

export async function scanPiMcpConfig(opts: { hostHome?: string } = {}): Promise<PiMcpScan> {
  const hostHome = opts.hostHome ?? homedir();
  const piDir = join(hostHome, '.pi', 'agent');
  const notices: string[] = [];
  const keep =
    'MCP configs can hold secrets, so AgentBox does not copy them; to use those servers in a box, ' +
    'put the ones you need in ~/.pi/agent/mcp.json, or copy the file explicitly with `carry:` in agentbox.yaml.';

  let piDirReal: string;
  try {
    piDirReal = await realpath(piDir);
  } catch {
    piDirReal = piDir;
  }

  for (const name of PI_MCP_FILES) {
    const file = join(piDir, name);
    let st;
    try {
      st = await lstat(file);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      // A dangling link is the stager's to report; it skips it with a warning.
      const target = await realpath(file).catch(() => null);
      if (target === null) continue;
      if (!isUnder(piDirReal, target)) {
        const n = countServers(await readJsonObject(file));
        notices.push(
          `pi: ${tilde(hostHome, file)} links to a file outside ~/.pi/agent (${servers(n)}); ` +
            'the box gets a copy of that file, like the rest of ~/.pi/agent.',
        );
      }
    }
    const imports = (await readJsonObject(file))?.['imports'];
    const sources = Array.isArray(imports) ? imports.length : 0;
    if (sources > 0) {
      notices.push(
        `pi: ${tilde(hostHome, file)} imports MCP servers from ${String(sources)} other tool config${sources === 1 ? '' : 's'}; ` +
          `those files are not copied into the box, so the imported servers will be missing there. ${keep}`,
      );
    }
  }

  const shared = join(hostHome, ...SHARED_MCP_REL);
  if (await exists(shared)) {
    const n = countServers(await readJsonObject(shared));
    notices.push(
      `pi: ${tilde(hostHome, shared)} defines ${servers(n)} that are not copied into the box (only ~/.pi/agent is). ${keep}`,
    );
  }

  return { notices };
}
