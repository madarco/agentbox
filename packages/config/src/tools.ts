/**
 * Host-tool grants — the authoritative, host-only record of which host CLIs
 * a box may reach through the relay.
 *
 * The trust split matters: a project's `agentbox.yaml` `tools:` block only
 * *requests* access (it is committed, and a cloned repo must not be able to
 * wire itself to the host's credentials). The host approves a request once,
 * and the approval lands here. The relay consults only this file, so an
 * unapproved yaml entry is inert.
 *
 * Layered global < project, mirroring `loadEffectiveConfig`: a global grant
 * applies to every project, a project grant only to its own. Project wins on
 * name collision so a project can narrow (add a `deny`) what a global grant
 * allows.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { GLOBAL_TOOLS_FILE, projectToolsFile } from './paths.js';

/** Where a grant came from; surfaced by `agentbox tools list`. */
export type ToolGrantSource = 'builtin' | 'cli' | 'yaml' | 'request';

export interface ToolGrant {
  /** Command name the box types, and the basename of its shim symlink. */
  name: string;
  /** Host binary actually executed. Defaults to `name`. */
  bin: string;
  /**
   * Argv patterns (JS regexes, matched against the space-joined argv) that
   * run without a host prompt even when prompting is otherwise on. Use for
   * the read-only subcommands of a chatty CLI.
   */
  allow?: string[];
  /**
   * Argv patterns refused outright, before any prompt or spawn. Layered on
   * top of the built-in credential deny list, never replacing it.
   */
  deny?: string[];
  /** Per-call wall-clock budget; host tools are non-interactive. */
  timeoutMs?: number;
  source: ToolGrantSource;
  /** ISO timestamp of the approval that created this grant. */
  approvedAt?: string;
}

/** On-disk shape of a `tools.yaml`. */
interface ToolsFile {
  tools?: Record<string, Omit<ToolGrant, 'name'> | null>;
}

/**
 * The one grant every box gets for free. `gh` predates this system — Claude
 * Code's PR badge and our documented agent flows call it — and it keeps its
 * bespoke relay handler (branch injection, the `gh api` endpoint allowlist),
 * so it is listed here for discoverability but never dispatched through
 * `tool.run`. `tools.gh.enabled: false` revokes it.
 */
export const BUILTIN_GH_GRANT: ToolGrant = {
  name: 'gh',
  bin: 'gh',
  source: 'builtin',
};

/**
 * Every granted tool for `cwd`, keyed by name. Global grants first, project
 * grants layered on top. Never throws: a malformed or unreadable grant file
 * yields no grants, so the relay fails closed.
 */
export async function loadGrantedTools(
  cwd: string,
  opts: { includeBuiltins?: boolean } = {},
): Promise<Map<string, ToolGrant>> {
  const merged = new Map<string, ToolGrant>();
  if (opts.includeBuiltins !== false) merged.set(BUILTIN_GH_GRANT.name, BUILTIN_GH_GRANT);
  for (const file of [GLOBAL_TOOLS_FILE, projectToolsFile(cwd)]) {
    for (const grant of await readToolsFile(file)) merged.set(grant.name, grant);
  }
  return merged;
}

/** Read one grant file; `[]` when absent or malformed (fail closed). */
export async function readToolsFile(file: string): Promise<ToolGrant[]> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch {
    return [];
  }
  const tools = (doc as ToolsFile | null)?.tools;
  if (!tools || typeof tools !== 'object') return [];
  const out: ToolGrant[] = [];
  for (const [name, value] of Object.entries(tools)) {
    if (!isValidToolName(name)) continue;
    const entry = (value ?? {}) as Partial<ToolGrant>;
    out.push({
      name,
      bin: typeof entry.bin === 'string' && entry.bin ? entry.bin : name,
      ...(stringArray(entry.allow) ? { allow: stringArray(entry.allow) } : {}),
      ...(stringArray(entry.deny) ? { deny: stringArray(entry.deny) } : {}),
      ...(typeof entry.timeoutMs === 'number' && entry.timeoutMs > 0
        ? { timeoutMs: entry.timeoutMs }
        : {}),
      source: isGrantSource(entry.source) ? entry.source : 'cli',
      ...(typeof entry.approvedAt === 'string' ? { approvedAt: entry.approvedAt } : {}),
    });
  }
  return out;
}

/**
 * Write (or overwrite) one grant in a grant file, preserving the others.
 * Read-modify-write rather than a merge helper because the file is small and
 * only ever touched by an interactive approval.
 */
export async function writeToolGrant(file: string, grant: ToolGrant): Promise<void> {
  const existing = await readToolsFile(file);
  const byName = new Map(existing.map((g) => [g.name, g]));
  byName.set(grant.name, grant);
  await persist(file, [...byName.values()]);
}

/** Remove a grant. Returns false when it wasn't there. */
export async function removeToolGrant(file: string, name: string): Promise<boolean> {
  const existing = await readToolsFile(file);
  const kept = existing.filter((g) => g.name !== name);
  if (kept.length === existing.length) return false;
  await persist(file, kept);
  return true;
}

async function persist(file: string, grants: ToolGrant[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tools: Record<string, Omit<ToolGrant, 'name'>> = {};
  for (const g of grants.sort((a, b) => a.name.localeCompare(b.name))) {
    const rest: Omit<ToolGrant, 'name'> = { bin: g.bin, source: g.source };
    if (g.allow) rest.allow = g.allow;
    if (g.deny) rest.deny = g.deny;
    if (g.timeoutMs !== undefined) rest.timeoutMs = g.timeoutMs;
    if (g.approvedAt) rest.approvedAt = g.approvedAt;
    tools[g.name] = rest;
  }
  const header =
    '# agentbox host-tool grants — written by `agentbox tools` and by approved\n' +
    '# in-box `agentbox-ctl tool request` calls. The relay reads only this file;\n' +
    '# an agentbox.yaml `tools:` entry is a request until it is approved here.\n';
  await writeFile(file, header + stringifyYaml({ tools }), 'utf8');
}

/**
 * A tool name becomes a `~/.local/bin/<name>` symlink inside the box, so it
 * has to be a plain command name — no path separators, no leading dash, no
 * shell metacharacters.
 */
export function isValidToolName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/.test(name);
}

function stringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string' && x.length > 0);
  return out.length > 0 ? out : undefined;
}

function isGrantSource(v: unknown): v is ToolGrantSource {
  return v === 'builtin' || v === 'cli' || v === 'yaml' || v === 'request';
}
