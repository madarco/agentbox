/**
 * Provider-neutral box→host pull of agent extensions/config — the shared core
 * behind `agentbox download claude|codex|opencode`. Additive only: an item
 * already present on the host is never overwritten.
 *
 * Two execution paths share this module:
 *  - docker (`@agentbox/sandbox-docker`): reads the agent-config *volume* via
 *    throwaway helper containers (works while the box is stopped) — it runs the
 *    inventory scripts built here with the volume mounted at `/src` and keeps
 *    its own container-based copy step;
 *  - cloud (any provider with a `SyncTransport`): reads the live box FS via
 *    `pullClaudeExtrasViaTransport` / `pullCodexConfigViaTransport` /
 *    `pullOpencodeConfigViaTransport`. The box-side relative layout matches the
 *    docker volume layout by construction (opencode's config dir is relocated
 *    to `<data>/config` in boxes exactly like in the volume).
 */

import { chmod, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SyncTransport } from '@agentbox/core';
import {
  mergeInstalledPlugins,
  mergeKnownMarketplaces,
  pickNewItems,
  SKILL_EXCLUDE_PREFIXES,
  type MergeResult,
} from './claude-pull.js';

/** Box-side agent config roots (identical to the docker volume layout). */
export const CLAUDE_BOX_CONFIG_DIR = '/home/vscode/.claude';
export const CODEX_BOX_CONFIG_DIR = '/home/vscode/.codex';
export const OPENCODE_BOX_DATA_DIR = '/home/vscode/.local/share/opencode';

// ---------------------------------------------------------------------------
// claude
// ---------------------------------------------------------------------------

export const CLAUDE_PULL_DIR_CATEGORIES = ['skills', 'agents', 'commands'] as const;

export interface PullClaudeResult {
  /**
   * Box-installed extensions not present on the host. `category` is one of
   * skills/agents/commands (then `name` is the dir name) or `plugins` (then
   * `name` is the `<marketplace>/<plugin>` cache key).
   */
  newItems: Array<{ category: string; name: string }>;
  /** Registry JSONs that gained box-only entries (e.g. `known_marketplaces.json`). */
  mergedRegistries: string[];
  /**
   * The source's raw plugin registries (container-prefixed paths), keyed
   * `installed_plugins` / `known_marketplaces`. Carried so a subsequent
   * propagate step can additively merge them into *other* boxes (same
   * container prefix on both sides — no path rewrite).
   */
  sourceRegistries?: Record<string, unknown>;
}

/**
 * Shell script that inventories a claude config tree rooted at `src`:
 * `DIR <cat> <name>` per skills/agents/commands child dir, `PLUGIN <m>/<p>`
 * per plugin-cache entry, and `JSON <which> <base64>` for each plugin
 * registry. `base64 -w0` keeps each registry JSON on one parseable line.
 */
export function claudeInventoryScript(src: string): string {
  return [
    'for cat in skills agents commands; do',
    `  [ -d "${src}/$cat" ] || continue;`,
    `  for d in "${src}/$cat"/*/; do`,
    '    [ -d "$d" ] || continue;',
    '    printf "DIR %s %s\\n" "$cat" "$(basename "$d")";',
    '  done;',
    'done;',
    `if [ -d ${src}/plugins/cache ]; then`,
    `  for m in ${src}/plugins/cache/*/; do`,
    '    [ -d "$m" ] || continue;',
    '    for p in "$m"*/; do',
    '      [ -d "$p" ] || continue;',
    '      printf "PLUGIN %s/%s\\n" "$(basename "$m")" "$(basename "$p")";',
    '    done;',
    '  done;',
    'fi;',
    'for f in installed_plugins known_marketplaces; do',
    `  [ -f "${src}/plugins/$f.json" ] || continue;`,
    '  printf "JSON %s " "$f";',
    `  base64 -w0 "${src}/plugins/$f.json";`,
    '  printf "\\n";',
    'done',
  ].join(' ');
}

export interface ClaudeInventory {
  dirs: Record<string, string[]>;
  plugins: string[];
  registries: Record<string, unknown>;
}

export function parseClaudeInventory(stdout: string): ClaudeInventory {
  const dirs: Record<string, string[]> = { skills: [], agents: [], commands: [] };
  const plugins: string[] = [];
  const registries: Record<string, unknown> = {};
  for (const line of stdout.split('\n')) {
    if (line.startsWith('DIR ')) {
      const rest = line.slice(4);
      const sp = rest.indexOf(' ');
      if (sp === -1) continue;
      const cat = rest.slice(0, sp);
      const name = rest.slice(sp + 1);
      if (cat in dirs) dirs[cat]!.push(name);
    } else if (line.startsWith('PLUGIN ')) {
      plugins.push(line.slice(7));
    } else if (line.startsWith('JSON ')) {
      const rest = line.slice(5);
      const sp = rest.indexOf(' ');
      if (sp === -1) continue;
      const which = rest.slice(0, sp);
      try {
        registries[which] = JSON.parse(Buffer.from(rest.slice(sp + 1), 'base64').toString('utf8'));
      } catch {
        // Leave undefined; the merge helpers tolerate it.
      }
    }
  }
  return { dirs, plugins, registries };
}

export interface ClaudePullPlan {
  newItems: PullClaudeResult['newItems'];
  /** Config-root-relative paths to copy (`skills/<n>`, `plugins/cache/<m>/<p>`). */
  copyRels: string[];
  mergedInstalled: MergeResult;
  mergedMarkets: MergeResult;
  mergedRegistries: string[];
}

/**
 * Immediate child item names of `dir`, or [] if it doesn't exist. Symlinks
 * count: the host's `~/.claude/skills/<name>` is a symlink into `~/.agents`
 * (Claude Code's user-skills convention), so `isDirectory()` alone would miss
 * them and every host skill would look "new".
 */
async function listChildDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Compute the additive delta of a box claude inventory against the host's
 * `~/.claude` (`hostHome` overridable for tests): which items are new, which
 * config-root-relative paths to copy, and the merged plugin registries.
 */
export async function computeClaudePullPlan(
  inv: ClaudeInventory,
  opts: { hostHome?: string } = {},
): Promise<ClaudePullPlan> {
  const hostHome = opts.hostHome ?? homedir();
  const hostClaude = join(hostHome, '.claude');

  const newItems: PullClaudeResult['newItems'] = [];
  const copyRels: string[] = [];
  for (const cat of CLAUDE_PULL_DIR_CATEGORIES) {
    const hostNames = await listChildDirs(join(hostClaude, cat));
    const excludes = cat === 'skills' ? SKILL_EXCLUDE_PREFIXES : [];
    for (const name of pickNewItems(inv.dirs[cat] ?? [], hostNames, excludes)) {
      newItems.push({ category: cat, name });
      copyRels.push(`${cat}/${name}`);
    }
  }
  const hostPluginKeys: string[] = [];
  for (const m of await listChildDirs(join(hostClaude, 'plugins', 'cache'))) {
    for (const p of await listChildDirs(join(hostClaude, 'plugins', 'cache', m))) {
      hostPluginKeys.push(`${m}/${p}`);
    }
  }
  for (const key of pickNewItems(inv.plugins, hostPluginKeys)) {
    newItems.push({ category: 'plugins', name: key });
    copyRels.push(`plugins/cache/${key}`);
  }

  const hostInstalled = await readJsonFile(join(hostClaude, 'plugins', 'installed_plugins.json'));
  const hostMarkets = await readJsonFile(join(hostClaude, 'plugins', 'known_marketplaces.json'));
  const mergedInstalled = mergeInstalledPlugins(hostInstalled, inv.registries['installed_plugins'], {
    hostHome,
  });
  const mergedMarkets = mergeKnownMarketplaces(hostMarkets, inv.registries['known_marketplaces'], {
    hostHome,
  });
  const mergedRegistries: string[] = [];
  if (mergedInstalled.changed) mergedRegistries.push('installed_plugins.json');
  if (mergedMarkets.changed) mergedRegistries.push('known_marketplaces.json');

  return { newItems, copyRels, mergedInstalled, mergedMarkets, mergedRegistries };
}

/**
 * Write the merged plugin registries host-side — only the ones the merge
 * actually changed (host paths are directly writable; no container needed).
 */
export async function writeClaudeMergedRegistries(
  plan: ClaudePullPlan,
  opts: { hostHome?: string } = {},
): Promise<void> {
  if (!plan.mergedInstalled.changed && !plan.mergedMarkets.changed) return;
  const hostClaude = join(opts.hostHome ?? homedir(), '.claude');
  await mkdir(join(hostClaude, 'plugins'), { recursive: true });
  if (plan.mergedMarkets.changed) {
    await writeFile(
      join(hostClaude, 'plugins', 'known_marketplaces.json'),
      `${JSON.stringify(plan.mergedMarkets.data, null, 2)}\n`,
    );
  }
  if (plan.mergedInstalled.changed) {
    await writeFile(
      join(hostClaude, 'plugins', 'installed_plugins.json'),
      `${JSON.stringify(plan.mergedInstalled.data, null, 2)}\n`,
    );
  }
}

/**
 * Pull box-installed Claude extensions from a *live* box over a
 * `SyncTransport` (the cloud counterpart of sandbox-docker's volume-based
 * `pullClaudeExtras`). Additive: only items missing on the host are copied.
 */
export async function pullClaudeExtrasViaTransport(
  t: SyncTransport,
  opts: { boxDir?: string; hostHome?: string; dryRun?: boolean } = {},
): Promise<PullClaudeResult> {
  const boxDir = opts.boxDir ?? CLAUDE_BOX_CONFIG_DIR;
  const inv = await t.exec(['sh', '-c', claudeInventoryScript(boxDir)]);
  if (inv.exitCode !== 0) {
    throw new Error(
      `failed to inventory ${boxDir} in the box: ${inv.stderr.trim() || `exit ${String(inv.exitCode)}`}`,
    );
  }
  const inventory = parseClaudeInventory(inv.stdout);
  const plan = await computeClaudePullPlan(inventory, { hostHome: opts.hostHome });
  const result: PullClaudeResult = {
    newItems: plan.newItems,
    mergedRegistries: plan.mergedRegistries,
    sourceRegistries: inventory.registries,
  };
  if (opts.dryRun || (plan.newItems.length === 0 && plan.mergedRegistries.length === 0)) {
    return result;
  }

  const hostClaude = join(opts.hostHome ?? homedir(), '.claude');
  for (const rel of plan.copyRels) {
    const hostDest = join(hostClaude, rel);
    await mkdir(hostDest, { recursive: true });
    // node_modules excluded for the same reason as the docker pull: the box
    // carries linux binaries useless on the host (claude rebuilds lazily).
    await t.pullTree(`${boxDir}/${rel}`, hostDest, { exclude: ['node_modules'] });
  }
  await writeClaudeMergedRegistries(plan, { hostHome: opts.hostHome });
  return result;
}

// ---------------------------------------------------------------------------
// codex / opencode — flat item lists, shared with the docker volume pulls
// ---------------------------------------------------------------------------

/** Top-level codex-config items `download codex` considers. */
export const CODEX_PULL_ITEMS = ['config.toml', 'auth.json', 'prompts'] as const;

/** Data-dir items (data root → host ~/.local/share/opencode). */
export const OPENCODE_PULL_DATA_ITEMS = ['auth.json'] as const;
/**
 * Config-dir items (`config/` under the data root → host ~/.config/opencode).
 * Covers both the `.json` and `.jsonc` global config and OpenCode's
 * user-extension subdirs.
 */
export const OPENCODE_PULL_CONFIG_ITEMS = [
  'opencode.json',
  'opencode.jsonc',
  'agents',
  'commands',
  'modes',
  'plugins',
  'skills',
  'tools',
  'themes',
] as const;

/**
 * Inventory script for flat item lists: prints `<group> <FILE|DIR> <name>` per
 * present item. `groups` maps a group label to `{ dir, items }`.
 */
export function flatInventoryScript(
  groups: Record<string, { dir: string; items: readonly string[] }>,
): string {
  const parts: string[] = [];
  for (const [group, { dir, items }] of Object.entries(groups)) {
    parts.push(
      `for f in ${items.join(' ')}; do` +
        ` if [ -d "${dir}/$f" ]; then echo "${group} DIR $f";` +
        ` elif [ -e "${dir}/$f" ]; then echo "${group} FILE $f"; fi;` +
        ` done;`,
    );
  }
  parts.push('true');
  return parts.join(' ');
}

export interface FlatInventoryEntry {
  group: string;
  kind: 'file' | 'dir';
  name: string;
}

export function parseFlatInventory(stdout: string): FlatInventoryEntry[] {
  const out: FlatInventoryEntry[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^(\S+) (FILE|DIR) (\S+)$/.exec(line.trim());
    if (!m) continue;
    out.push({ group: m[1]!, kind: m[2] === 'DIR' ? 'dir' : 'file', name: m[3]! });
  }
  return out;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Pull one flat-inventory entry to the host, preserving 0600 on auth files. */
async function pullFlatEntry(
  t: SyncTransport,
  entry: FlatInventoryEntry,
  boxPath: string,
  hostPath: string,
): Promise<void> {
  if (entry.kind === 'dir') {
    await mkdir(hostPath, { recursive: true });
    await t.pullTree(boxPath, hostPath, { exclude: ['node_modules'] });
    return;
  }
  await mkdir(dirname(hostPath), { recursive: true });
  await t.pullFile(boxPath, hostPath);
  if (entry.name === 'auth.json') await chmod(hostPath, 0o600);
}

/**
 * Pull box-side codex config/auth from a live box over a `SyncTransport`
 * (cloud counterpart of sandbox-docker's `pullCodexConfig`). Additive only.
 */
export async function pullCodexConfigViaTransport(
  t: SyncTransport,
  opts: { boxDir?: string; hostHome?: string; dryRun?: boolean } = {},
): Promise<{ newItems: string[] }> {
  const boxDir = opts.boxDir ?? CODEX_BOX_CONFIG_DIR;
  const hostCodex = join(opts.hostHome ?? homedir(), '.codex');
  const script = flatInventoryScript({ codex: { dir: boxDir, items: CODEX_PULL_ITEMS } });
  const inv = await t.exec(['sh', '-c', script]);
  if (inv.exitCode !== 0) {
    throw new Error(
      `failed to inventory ${boxDir} in the box: ${inv.stderr.trim() || `exit ${String(inv.exitCode)}`}`,
    );
  }
  const entries: FlatInventoryEntry[] = [];
  for (const entry of parseFlatInventory(inv.stdout)) {
    if (await pathExists(join(hostCodex, entry.name))) continue; // additive
    entries.push(entry);
  }
  const newItems = entries.map((e) => e.name);
  if (opts.dryRun || entries.length === 0) return { newItems };

  for (const entry of entries) {
    await pullFlatEntry(t, entry, `${boxDir}/${entry.name}`, join(hostCodex, entry.name));
  }
  return { newItems };
}

/**
 * Pull box-side OpenCode config/auth from a live box over a `SyncTransport`
 * (cloud counterpart of sandbox-docker's `pullOpencodeConfig`). Additive only;
 * `auth.json` lands in the host `~/.local/share/opencode`, config items in
 * `~/.config/opencode`.
 */
export async function pullOpencodeConfigViaTransport(
  t: SyncTransport,
  opts: { boxDir?: string; hostHome?: string; dryRun?: boolean } = {},
): Promise<{ newItems: string[] }> {
  const boxDir = opts.boxDir ?? OPENCODE_BOX_DATA_DIR;
  const hostHome = opts.hostHome ?? homedir();
  const hostBases = {
    data: join(hostHome, '.local', 'share', 'opencode'),
    config: join(hostHome, '.config', 'opencode'),
  } as const;
  const script = flatInventoryScript({
    data: { dir: boxDir, items: OPENCODE_PULL_DATA_ITEMS },
    config: { dir: `${boxDir}/config`, items: OPENCODE_PULL_CONFIG_ITEMS },
  });
  const inv = await t.exec(['sh', '-c', script]);
  if (inv.exitCode !== 0) {
    throw new Error(
      `failed to inventory ${boxDir} in the box: ${inv.stderr.trim() || `exit ${String(inv.exitCode)}`}`,
    );
  }
  const entries: Array<FlatInventoryEntry & { label: string }> = [];
  for (const entry of parseFlatInventory(inv.stdout)) {
    if (entry.group !== 'data' && entry.group !== 'config') continue;
    const hostBase = hostBases[entry.group as keyof typeof hostBases];
    if (await pathExists(join(hostBase, entry.name))) continue; // additive
    entries.push({ ...entry, label: entry.group === 'data' ? entry.name : `config/${entry.name}` });
  }
  const newItems = entries.map((e) => e.label);
  if (opts.dryRun || entries.length === 0) return { newItems };

  for (const entry of entries) {
    const boxPath =
      entry.group === 'data' ? `${boxDir}/${entry.name}` : `${boxDir}/config/${entry.name}`;
    const hostPath = join(hostBases[entry.group as keyof typeof hostBases], entry.name);
    await pullFlatEntry(t, entry, boxPath, hostPath);
  }
  return { newItems };
}
