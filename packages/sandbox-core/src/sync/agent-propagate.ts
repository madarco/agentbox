/**
 * Propagate pulled agent settings (skills/plugins/config items) from one box
 * to other boxes — the sync-layer core behind the `agentbox download <agent>`
 * propagate step. Everything here is additive: an item a target already has
 * is never overwritten, and plugin-registry merges are target-wins.
 *
 * Targets are abstracted behind `SettingsTarget`:
 *  - a live box over its provider's `SyncTransport` (`transportSettingsTarget`)
 *    — any cloud provider, or a running docker box;
 *  - a docker config *volume* via throwaway helper containers
 *    (`volumeSettingsTarget` in `@agentbox/sandbox-docker`) — covers every
 *    docker box sharing that volume, running or paused.
 *
 * Items are staged host-side first (`stageItemsViaTransport` /
 * sandbox-docker's `stageItemsFromVolume`) in the volume-style relative
 * layout, so propagation works even when the user declined the host
 * `~/.claude` write.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SyncTransport } from '@agentbox/core';
import type { AgentId } from './agents/types.js';
import { resolveAgentSpec } from './registry.js';
import { mergeInstalledPlugins, mergeKnownMarketplaces } from './claude-pull.js';
import {
  CLAUDE_BOX_CONFIG_DIR,
  CODEX_BOX_CONFIG_DIR,
  OPENCODE_BOX_DATA_DIR,
  type PullClaudeResult,
} from './agent-pull.js';

/** One staged settings item, in the volume-style relative layout. */
export interface StagedItem {
  /** Config-root-relative path (`skills/foo`, `plugins/cache/m/p`, `config.toml`). */
  rel: string;
  /** Human label for summaries (`skills/foo`, `config/skills`). */
  label: string;
  kind: 'dir' | 'file';
}

/** A pulled settings set staged host-side, ready to propagate to targets. */
export interface StagedSettings {
  agent: AgentId;
  /** Host dir holding the items at their `rel` paths. */
  stagingDir: string;
  items: StagedItem[];
  /** claude only: the source box's raw plugin registries for target merges. */
  sourceRegistries?: Record<string, unknown>;
}

/** The box-side config root the staged rels apply under, per agent. */
export function agentBoxConfigDir(agent: AgentId): string {
  switch (agent) {
    case 'claude':
      return CLAUDE_BOX_CONFIG_DIR;
    case 'codex':
      return CODEX_BOX_CONFIG_DIR;
    default:
      return OPENCODE_BOX_DATA_DIR;
  }
}

/** Map a claude pull result to staged-item descriptors (all claude items are dirs). */
export function claudeStagedItems(result: PullClaudeResult): StagedItem[] {
  return result.newItems.map((it) => ({
    rel: it.category === 'plugins' ? `plugins/cache/${it.name}` : `${it.category}/${it.name}`,
    label: `${it.category}/${it.name}`,
    kind: 'dir' as const,
  }));
}

/** Map codex pull items (`config.toml`/`auth.json` files, `prompts` dir). */
export function codexStagedItems(newItems: string[]): StagedItem[] {
  return newItems.map((name) => ({
    rel: name,
    label: name,
    kind: name === 'prompts' ? ('dir' as const) : ('file' as const),
  }));
}

/** Map opencode pull labels (`auth.json`, `config/<item>`) to volume-style rels. */
export function opencodeStagedItems(newItems: string[]): StagedItem[] {
  return newItems.map((label) => {
    const name = label.startsWith('config/') ? label.slice('config/'.length) : label;
    const isFile = name === 'auth.json' || name === 'opencode.json' || name === 'opencode.jsonc';
    return { rel: label, label, kind: isFile ? ('file' as const) : ('dir' as const) };
  });
}

/** Stage box-side items into `stagingDir` (volume-style layout) over a transport. */
export async function stageItemsViaTransport(
  t: SyncTransport,
  boxDir: string,
  items: StagedItem[],
  stagingDir: string,
): Promise<void> {
  for (const item of items) {
    const dest = join(stagingDir, item.rel);
    if (item.kind === 'dir') {
      await mkdir(dest, { recursive: true });
      await t.pullTree(`${boxDir}/${item.rel}`, dest, { exclude: ['node_modules'] });
    } else {
      await mkdir(dirname(dest), { recursive: true });
      await t.pullFile(`${boxDir}/${item.rel}`, dest);
    }
  }
}

/** Create a scratch staging dir for a propagate run (caller rm's it). */
export async function makeStagingDir(agent: AgentId): Promise<string> {
  return mkdtemp(join(tmpdir(), `agentbox-${agent}-propagate-`));
}

export async function removeStagingDir(stagingDir: string): Promise<void> {
  await rm(stagingDir, { recursive: true, force: true });
}

/**
 * Minimal write seam for one propagate target — a live box over a transport or
 * a docker config volume via helper containers. All paths are config-root
 * relative (same layout as `StagedItem.rel`).
 */
export interface SettingsTarget {
  /** Human label for the per-target summary (box name or volume name). */
  label: string;
  exists(rel: string): Promise<boolean>;
  readText(rel: string): Promise<string | null>;
  /** `opts.mode` sets the file mode (e.g. 0o600 for credential blobs). */
  writeText(rel: string, content: string, opts?: { mode?: number }): Promise<void>;
  /** Copy a staged item into the target at `rel` (parents created, additive). */
  copyIn(stagingAbs: string, rel: string, kind: 'dir' | 'file'): Promise<void>;
}

/**
 * A `SettingsTarget` over a live box's `SyncTransport`, rooted at the agent's
 * box config dir. Ownership follows the transport's default exec user (the
 * box's `vscode`, whatever uid that is on the provider).
 */
export function transportSettingsTarget(
  t: SyncTransport,
  boxDir: string,
  label: string,
): SettingsTarget {
  const abs = (rel: string) => `${boxDir}/${rel}`;
  return {
    label,
    async exists(rel: string): Promise<boolean> {
      const r = await t.exec(['sh', '-c', `test -e '${abs(rel)}'`]);
      return r.exitCode === 0;
    },
    readText(rel: string): Promise<string | null> {
      return t.readText(abs(rel));
    },
    async writeText(rel: string, content: string, opts?: { mode?: number }): Promise<void> {
      const stage = await mkdtemp(join(tmpdir(), 'agentbox-target-write-'));
      try {
        const tmp = join(stage, 'file');
        await writeFile(tmp, content);
        await t.exec(['sh', '-c', `mkdir -p '${dirname(abs(rel))}'`]);
        await t.pushFile(tmp, abs(rel));
        if (opts?.mode !== undefined) {
          await t.exec(['sh', '-c', `chmod ${opts.mode.toString(8)} '${abs(rel)}'`]);
        }
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
    },
    async copyIn(stagingAbs: string, rel: string, kind: 'dir' | 'file'): Promise<void> {
      if (kind === 'dir') {
        await t.exec(['sh', '-c', `mkdir -p '${abs(rel)}'`]);
        await t.pushTree(stagingAbs, abs(rel), { exclude: ['node_modules'] });
      } else {
        await t.exec(['sh', '-c', `mkdir -p '${dirname(abs(rel))}'`]);
        await t.pushFile(stagingAbs, abs(rel));
      }
    },
  };
}

export interface PropagateTargetResult {
  target: string;
  copied: string[];
  skipped: string[];
  mergedRegistries: string[];
  error?: string;
}

/** The two claude plugin registries a propagate merges into targets. */
const CLAUDE_REGISTRY_FILES: ReadonlyArray<{ key: string; rel: string }> = [
  { key: 'installed_plugins', rel: 'plugins/installed_plugins.json' },
  { key: 'known_marketplaces', rel: 'plugins/known_marketplaces.json' },
];

/**
 * Push one staged settings set into one target: copy items the target lacks,
 * then (claude) additively merge the source's plugin registries into the
 * target's — target-wins, and since source and target both use the container
 * plugin prefix, passing `/home/vscode` as the "host home" makes the merge
 * helpers' path rewrite the identity.
 */
export async function propagateStagedSettings(
  target: SettingsTarget,
  staged: StagedSettings,
): Promise<PropagateTargetResult> {
  const result: PropagateTargetResult = {
    target: target.label,
    copied: [],
    skipped: [],
    mergedRegistries: [],
  };
  for (const item of staged.items) {
    if (await target.exists(item.rel)) {
      result.skipped.push(item.label);
      continue;
    }
    await target.copyIn(join(staged.stagingDir, item.rel), item.rel, item.kind);
    result.copied.push(item.label);
  }

  if (staged.agent === 'claude' && staged.sourceRegistries) {
    for (const { key, rel } of CLAUDE_REGISTRY_FILES) {
      const source = staged.sourceRegistries[key];
      if (source === undefined) continue;
      const raw = await target.readText(rel);
      let targetJson: unknown;
      try {
        targetJson = raw === null ? undefined : JSON.parse(raw);
      } catch {
        targetJson = undefined;
      }
      const merged =
        key === 'installed_plugins'
          ? mergeInstalledPlugins(targetJson, source, { hostHome: '/home/vscode' })
          : mergeKnownMarketplaces(targetJson, source, { hostHome: '/home/vscode' });
      if (!merged.changed) continue;
      await target.writeText(rel, `${JSON.stringify(merged.data, null, 2)}\n`);
      result.mergedRegistries.push(rel);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// target planning
// ---------------------------------------------------------------------------

/** The BoxRecord fields target planning needs (structural, for pure tests). */
export interface PropagateBoxLike {
  id: string;
  name: string;
  provider?: string;
  projectRoot?: string;
  claudeConfigVolume?: string;
  codexConfigVolume?: string;
  opencodeConfigVolume?: string;
}

export interface PropagatePlan<B extends PropagateBoxLike> {
  /**
   * Docker config volumes to write, each covering the named boxes (the shared
   * volume groups every non-isolated docker box — one write covers them all,
   * running or paused).
   */
  dockerVolumes: Array<{ volume: string; boxNames: string[]; shared: boolean }>;
  /** Cloud boxes to push to (caller checks each is running / resumable). */
  cloudBoxes: B[];
}

function isolatedVolumeOf(box: PropagateBoxLike, agent: AgentId): string | undefined {
  switch (agent) {
    case 'claude':
      return box.claudeConfigVolume;
    case 'codex':
      return box.codexConfigVolume;
    default:
      return box.opencodeConfigVolume;
  }
}

/**
 * Plan which stores a propagate run must write: dedup docker boxes onto their
 * config volumes (shared volume once) and list cloud boxes individually.
 * `scope: 'project'` keeps only boxes whose `projectRoot` matches the source's.
 * `excludeVolume` drops the source box's own volume (propagating a docker
 * box's items back into the volume they came from is a guaranteed no-op).
 */
export function planPropagateTargets<B extends PropagateBoxLike>(
  boxes: B[],
  opts: {
    agent: AgentId;
    sourceBoxId: string;
    scope: 'project' | 'all';
    projectRoot?: string;
    excludeVolume?: string;
  },
): PropagatePlan<B> {
  const sharedVolume = resolveAgentSpec(opts.agent).dockerVolume;
  const inScope = boxes.filter(
    (b) =>
      b.id !== opts.sourceBoxId &&
      (opts.scope === 'all' || (b.projectRoot ?? '') === (opts.projectRoot ?? '')),
  );
  const volumes = new Map<string, { boxNames: string[]; shared: boolean }>();
  const cloudBoxes: B[] = [];
  for (const box of inScope) {
    if ((box.provider ?? 'docker') !== 'docker') {
      cloudBoxes.push(box);
      continue;
    }
    const volume = isolatedVolumeOf(box, opts.agent) ?? sharedVolume;
    if (volume === opts.excludeVolume) continue;
    const entry = volumes.get(volume) ?? { boxNames: [], shared: volume === sharedVolume };
    entry.boxNames.push(box.name);
    volumes.set(volume, entry);
  }
  return {
    dockerVolumes: [...volumes.entries()].map(([volume, v]) => ({ volume, ...v })),
    cloudBoxes,
  };
}
