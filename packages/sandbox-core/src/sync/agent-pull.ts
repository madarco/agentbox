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
import type { AgentSyncSpec, SyncTransport } from '@agentbox/core';
import { resolveAgentSpec } from './registry.js';
import type { AgentId } from '@agentbox/core';
import {
  mergeInstalledPlugins,
  mergeKnownMarketplaces,
  pickNewItems,
  SKILL_EXCLUDE_PREFIXES,
  type MergeResult,
} from './claude-pull.js';

/**
 * Box-side agent config root, DERIVED from the registry rather than restated.
 *
 * `staticPaths[0].boxDir` is the same value the host->box push already syncs to,
 * so the two directions can no longer disagree. It used to be three literals
 * here plus three more in `registry.ts` — the box->host direction restating what
 * the push direction already knew, with nothing to catch a divergence.
 *
 * Note `staticPaths[0]` specifically: opencode has three roots and the DATA one
 * is first (`~/.local/share/opencode`); its config root is that same `boxDir`
 * plus the entry's `relocToSubpath`, which `pullOpencodeConfigViaTransport`
 * applies itself.
 */
/** A pull spec's flat item names for one group, from the registry. */
export function pullItems(agent: AgentId, group: string): readonly string[] {
  const g = resolveAgentSpec(agent).pull?.items?.find((i) => i.group === group);
  return g?.names ?? [];
}

/** A pull spec's category dirs, from the registry. */
export function pullCategories(agent: AgentId): readonly string[] {
  return resolveAgentSpec(agent).pull?.categories ?? [];
}

export function agentBoxDir(agent: AgentId): string {
  const dir = resolveAgentSpec(agent).staticPaths[0]?.boxDir;
  if (!dir) throw new Error(`agent ${agent} declares no staticPaths[0].boxDir`);
  return dir;
}

/** Box-side agent config roots (identical to the docker volume layout). */
export const CLAUDE_BOX_CONFIG_DIR = agentBoxDir('claude');
export const CODEX_BOX_CONFIG_DIR = agentBoxDir('codex');
export const OPENCODE_BOX_DATA_DIR = agentBoxDir('opencode');

// ---------------------------------------------------------------------------
// claude
// ---------------------------------------------------------------------------

/** Claude's category dirs, from the registry. */
export const CLAUDE_PULL_DIR_CATEGORIES = pullCategories('claude');

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
  const mergedInstalled = mergeInstalledPlugins(
    hostInstalled,
    inv.registries['installed_plugins'],
    {
      hostHome,
    },
  );
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
export const CODEX_PULL_ITEMS = pullItems('codex', 'data');

/** Data-dir items (data root → host ~/.local/share/opencode). */
export const OPENCODE_PULL_DATA_ITEMS = pullItems('opencode', 'data');
/**
 * Config-dir items (`config/` under the data root → host ~/.config/opencode).
 * Covers both the `.json` and `.jsonc` global config and OpenCode's
 * user-extension subdirs.
 */
export const OPENCODE_PULL_CONFIG_ITEMS = pullItems('opencode', 'config');

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

/**
 * Inventory the CHILDREN of each declared category dir.
 *
 * `AgentPullSpec.categories` names directories whose children are the unit
 * (Pi's `skills`/`extensions`/`prompts`/`themes`, claude's
 * `skills`/`agents`/`commands`). Listing the category itself as a flat item is
 * WRONG for these: the pull is additive and skips anything the host already
 * has, so one pre-existing `skills/` dir on the host would make every
 * box-created skill permanently unpullable.
 *
 * Emits the same `<group> <KIND> <name>` lines `flatInventoryScript` does, with
 * the category as the group and the child's basename as the name.
 */
export function categoryInventoryScript(categories: Record<string, { dir: string }>): string {
  const parts: string[] = [];
  for (const [group, { dir }] of Object.entries(categories)) {
    parts.push(
      `if [ -d "${dir}" ]; then for f in "${dir}"/*; do` +
        ` [ -e "$f" ] || continue; n=$(basename "$f");` +
        ` if [ -d "$f" ]; then echo "${group} DIR $n"; else echo "${group} FILE $n"; fi;` +
        ` done; fi;`,
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
 * Resolve one pull group to its box dir and host dir, per the rule
 * `AgentPullSpec` documents: `data` is `staticPaths[0]`, any other group is
 * that dir plus the entry whose `relocToSubpath` matches. `pull.roots` overrides
 * for a root that exists ONLY in the pull direction.
 */
function pullRootFor(
  spec: AgentSyncSpec,
  group: string,
  hostHome: string,
): { boxDir: string; hostDir: string } | null {
  const declared = spec.pull?.roots?.find((r) => r.group === group);
  if (declared) {
    return { boxDir: declared.boxDir, hostDir: join(hostHome, ...declared.hostHomeRel) };
  }
  const base = spec.staticPaths[0];
  if (!base) return null;
  if (group === 'data') {
    return { boxDir: base.boxDir, hostDir: join(hostHome, ...base.hostHomeRel) };
  }
  const reloc = spec.staticPaths.find((p) => p.relocToSubpath === group);
  if (!reloc) return null;
  return { boxDir: `${base.boxDir}/${group}`, hostDir: join(hostHome, ...reloc.hostHomeRel) };
}

/**
 * The DEFAULT box->host pull: flat items under one or more declared roots.
 *
 * Driven entirely by `AgentPullSpec.items` + the group rule above, so an agent
 * whose config is a flat set of files needs no pull code — declaring the row is
 * the whole job. This replaced the codex and opencode functions, which were the
 * same body differing only in the group->root mapping the spec already
 * described.
 *
 * Additive: an item the host already has is never overwritten, so a pull can
 * only ever add. `pullFlatEntry` restores `auth.json`'s 0600.
 */
export async function pullFlatConfigViaTransport(
  agent: AgentId,
  t: SyncTransport,
  opts: { hostHome?: string; dryRun?: boolean } = {},
): Promise<{ newItems: string[] }> {
  const spec = resolveAgentSpec(agent);
  const hostHome = opts.hostHome ?? homedir();
  const groups: Record<string, { dir: string; items: readonly string[] }> = {};
  const roots: Record<string, { boxDir: string; hostDir: string }> = {};
  for (const item of spec.pull?.items ?? []) {
    const root = pullRootFor(spec, item.group, hostHome);
    if (!root) continue;
    roots[item.group] = root;
    groups[item.group] = { dir: root.boxDir, items: item.names };
  }
  // Categories hang off the DEFAULT root and are addressed as `<cat>/<child>`.
  // An agent that declares none is completely unaffected by this block.
  const categories: Record<string, { dir: string }> = {};
  const defaultRoot = pullRootFor(spec, spec.pull?.items?.[0]?.group ?? 'data', hostHome);
  for (const cat of spec.pull?.categories ?? []) {
    if (!defaultRoot) break;
    roots[cat] = {
      boxDir: `${defaultRoot.boxDir}/${cat}`,
      hostDir: join(defaultRoot.hostDir, cat),
    };
    categories[cat] = { dir: `${defaultRoot.boxDir}/${cat}` };
  }

  if (Object.keys(groups).length === 0 && Object.keys(categories).length === 0) {
    return { newItems: [] };
  }

  const script = [
    Object.keys(groups).length > 0 ? flatInventoryScript(groups) : '',
    Object.keys(categories).length > 0 ? categoryInventoryScript(categories) : '',
  ]
    .filter((p) => p.length > 0)
    // `; ` and not ' ': each builder ends with a bare `true`, so a plain space
    // splices it onto the next segment's `if` and sh dies on "then unexpected".
    .join('; ');
  const inv = await t.exec(['sh', '-c', script]);
  if (inv.exitCode !== 0) {
    throw new Error(
      `failed to inventory ${spec.id} config in the box: ${inv.stderr.trim() || `exit ${String(inv.exitCode)}`}`,
    );
  }

  // The default group's items keep their bare name; any other group is labelled
  // `<group>/<name>` so the two cannot collide in the report.
  const defaultGroup = spec.pull?.items?.[0]?.group;
  const pending: Array<{ entry: FlatInventoryEntry; label: string; box: string; host: string }> =
    [];
  // Agentbox-OWNED files never travel to the host. `seeds` already declares
  // them (`destRel`, relative to the same root the pull walks), so this needs
  // no new field and no naming convention: Pi's activity extension is seeded
  // into `extensions/agentbox-state.js` and would otherwise be offered back as
  // if the user had written it, installing our extension into their real Pi.
  const seeded = new Set((spec.seeds ?? []).map((s) => s.destRel));

  for (const entry of parseFlatInventory(inv.stdout)) {
    const root = roots[entry.group];
    if (!root) continue;
    const rel = entry.group in categories ? `${entry.group}/${entry.name}` : entry.name;
    if (seeded.has(rel)) continue;
    const host = join(root.hostDir, entry.name);
    if (await pathExists(host)) continue; // additive
    pending.push({
      entry,
      label:
        entry.group === defaultGroup && !(entry.group in categories)
          ? entry.name
          : `${entry.group}/${entry.name}`,
      box: `${root.boxDir}/${entry.name}`,
      host,
    });
  }
  const newItems = pending.map((p) => p.label);
  if (opts.dryRun || pending.length === 0) return { newItems };
  for (const p of pending) await pullFlatEntry(t, p.entry, p.box, p.host);
  return { newItems };
}
