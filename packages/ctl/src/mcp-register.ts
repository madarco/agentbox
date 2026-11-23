/**
 * Register the AgentBox MCP server (`agentbox-ctl mcp`) in each agent's own
 * config file (docs/agent-history-plan.md, Phase 6). The targets come from the
 * host's `agents.list` (`AgentSyncSpec.mcp`), so a new agent needs no ctl
 * change. Never throws: a file it cannot parse is reported and left alone.
 */
import { randomBytes } from 'node:crypto';
import { chown, lstat, mkdir, readFile, readlink, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { applyMcpRegistration, BOX_HOME } from '@agentbox/core';
import type { AgentMcpTarget } from './agent-registry.js';

export interface McpRegisterResult {
  agent: string;
  file: string;
  outcome: 'added' | 'present' | 'skipped';
  reason?: string;
}

function expandHome(file: string, home: string): string {
  return file.startsWith('~/') ? `${home}/${file.slice(2)}` : file;
}

/**
 * Follow a symlink chain to the file to write (claude's `~/.claude.json` points
 * into the config volume). A dangling link resolves to its target, so writing
 * creates the target instead of replacing the link with a regular file.
 */
async function resolveTarget(path: string): Promise<string> {
  let p = path;
  for (let i = 0; i < 8; i++) {
    const st = await lstat(p).catch(() => null);
    if (!st?.isSymbolicLink()) return p;
    const to = await readlink(p);
    p = isAbsolute(to) ? to : resolve(dirname(p), to);
  }
  return p;
}

/** ctl may run as root; the file belongs to the owner of the nearest non-root dir. */
async function ownerFor(path: string): Promise<{ uid: number; gid: number } | null> {
  if (process.getuid?.() !== 0) return null;
  for (let d = dirname(path); d !== '/' && d !== '.'; d = dirname(d)) {
    const st = await stat(d).catch(() => null);
    if (st && st.uid !== 0) return { uid: st.uid, gid: st.gid };
  }
  return null;
}

export async function registerMcpTarget(
  target: AgentMcpTarget,
  home: string = BOX_HOME,
): Promise<McpRegisterResult> {
  const file = expandHome(target.file, home);
  const base = { agent: target.agent, file };
  try {
    const path = await resolveTarget(file);
    const current = await readFile(path, 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    const r = applyMcpRegistration(current, target);
    if (!r.ok) return { ...base, outcome: 'skipped', reason: r.reason };
    if (!r.changed) return { ...base, outcome: 'present' };
    const owner = await ownerFor(path);
    const made = await mkdir(dirname(path), { recursive: true });
    if (owner && made) {
      for (let d = dirname(path); d.length >= made.length; d = dirname(d)) {
        await chown(d, owner.uid, owner.gid).catch(() => undefined);
      }
    }
    const mode = (await stat(path).catch(() => null))?.mode;
    const tmp = `${path}.agentbox-${randomBytes(4).toString('hex')}`;
    await writeFile(tmp, r.text, { mode: mode !== undefined ? mode & 0o777 : 0o600 });
    if (owner) await chown(tmp, owner.uid, owner.gid).catch(() => undefined);
    await rename(tmp, path);
    return { ...base, outcome: 'added' };
  } catch (err) {
    return { ...base, outcome: 'skipped', reason: (err as Error).message };
  }
}

/** Register every target, one at a time (two agents may share a file). */
export async function registerBoxMcp(
  targets: readonly AgentMcpTarget[],
  opts: { home?: string; log?: (line: string) => void } = {},
): Promise<McpRegisterResult[]> {
  const out: McpRegisterResult[] = [];
  for (const t of targets) {
    const r = await registerMcpTarget(t, opts.home);
    if (r.outcome === 'added') opts.log?.(`mcp: registered the agentbox server for ${r.agent}`);
    if (r.outcome === 'skipped') {
      opts.log?.(`mcp: could not register for ${r.agent} in ${r.file}: ${r.reason ?? ''}`);
    }
    out.push(r);
  }
  return out;
}
