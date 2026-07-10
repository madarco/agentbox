import type { AgentId, StagedItem, StagedSettings } from '@agentbox/sandbox-core';
import type { BoxRecord } from '@agentbox/core';
import {
  agentBoxConfigDir,
  makeStagingDir,
  planPropagateTargets,
  propagateStagedSettings,
  readState,
  removeStagingDir,
  resolveAgentSpec,
  transportSettingsTarget,
  type PropagateTargetResult,
} from '@agentbox/sandbox-core';
import { DEFAULT_BOX_IMAGE, volumeSettingsTarget } from '@agentbox/sandbox-docker';
import { providerForBox } from '../provider/registry.js';
import { log, select } from '../lib/prompt.js';

export type PropagateScope = 'project' | 'all' | 'none';

export function parsePropagateFlag(value: string | undefined): PropagateScope | undefined {
  if (value === undefined) return undefined;
  if (value === 'project' || value === 'all' || value === 'none') return value;
  throw new Error(`invalid --propagate value '${value}' (expected project|all|none)`);
}

function isolatedVolumeOf(box: BoxRecord, agent: AgentId): string | undefined {
  switch (agent) {
    case 'claude':
      return box.claudeConfigVolume;
    case 'codex':
      return box.codexConfigVolume;
    default:
      return box.opencodeConfigVolume;
  }
}

function summarize(result: PropagateTargetResult): string {
  const parts: string[] = [];
  if (result.copied.length > 0) parts.push(`copied ${String(result.copied.length)} item(s)`);
  if (result.mergedRegistries.length > 0) {
    parts.push(`merged ${result.mergedRegistries.map((r) => r.split('/').pop()).join(', ')}`);
  }
  if (result.skipped.length > 0) parts.push(`skipped ${String(result.skipped.length)} existing`);
  return parts.length > 0 ? parts.join(', ') : 'nothing to do';
}

/**
 * The interactive propagate step of `agentbox download <agent>`: pick a scope,
 * stage the pulled items from the source (works even when the host write was
 * declined), and push them additively into the chosen targets. All mechanics
 * live in the sync layer (`agent-propagate.ts` in @agentbox/sandbox-core +
 * `settings-propagate.ts` in @agentbox/sandbox-docker); this is prompt +
 * lifecycle glue.
 */
export async function runPropagateStep(opts: {
  agent: AgentId;
  sourceBox: BoxRecord;
  items: StagedItem[];
  sourceRegistries?: Record<string, unknown>;
  /** Stage the items from the source (docker volume or live cloud box). */
  stage: (stagingDir: string) => Promise<void>;
  /** Validated --propagate flag value; undefined = ask interactively. */
  scopeFlag?: PropagateScope;
  /** -y was passed: never prompt (without an explicit --propagate, skip). */
  yes?: boolean;
}): Promise<void> {
  const { agent, sourceBox } = opts;
  if (opts.items.length === 0 && !(agent === 'claude' && opts.sourceRegistries)) return;
  if (opts.scopeFlag === 'none') return;

  const boxes = (await readState()).boxes.filter((b) => b.id !== sourceBox.id);
  if (boxes.length === 0) return;
  const projectCount = boxes.filter((b) => b.projectRoot === sourceBox.projectRoot).length;

  // Annotated, not inferred: the `opts.scopeFlag === 'none'` guard above narrows
  // scopeFlag to 'project' | 'all' | undefined, so an inferred `scope` couldn't
  // hold the 'none' the interactive picker can still return.
  let scope: PropagateScope | undefined = opts.scopeFlag;
  if (scope === undefined) {
    if (opts.yes) {
      log.info('skipping propagation (-y without --propagate); re-run with --propagate project|all');
      return;
    }
    const picked = await select({
      message: 'Propagate to other boxes?',
      options: [
        { value: 'none', label: 'no' },
        ...(projectCount > 0
          ? [{ value: 'project', label: `same project (${String(projectCount)} box(es))` }]
          : []),
        { value: 'all', label: `all boxes (${String(boxes.length)})` },
      ],
    });
    scope = picked as PropagateScope;
  }
  if (scope === 'none') return;

  const excludeVolume =
    (sourceBox.provider ?? 'docker') === 'docker'
      ? (isolatedVolumeOf(sourceBox, agent) ?? resolveAgentSpec(agent).dockerVolume)
      : undefined;
  const plan = planPropagateTargets(boxes, {
    agent,
    sourceBoxId: sourceBox.id,
    scope,
    projectRoot: sourceBox.projectRoot,
    excludeVolume,
  });
  if (plan.dockerVolumes.length === 0 && plan.cloudBoxes.length === 0) {
    log.info('no other target boxes in scope');
    return;
  }

  const stagingDir = await makeStagingDir(agent);
  try {
    await opts.stage(stagingDir);
    const staged: StagedSettings = {
      agent,
      stagingDir,
      items: opts.items,
      sourceRegistries: opts.sourceRegistries,
    };
    const image = sourceBox.image || DEFAULT_BOX_IMAGE;

    for (const vol of plan.dockerVolumes) {
      const label = vol.shared
        ? `docker boxes (shared volume): ${vol.boxNames.join(', ')}`
        : `${vol.boxNames.join(', ')} (isolated volume)`;
      try {
        const result = await propagateStagedSettings(
          volumeSettingsTarget(vol.volume, image, label),
          staged,
        );
        process.stdout.write(`  -> ${label}: ${summarize(result)}\n`);
      } catch (err) {
        log.warn(`  -> ${label}: failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    for (const target of plan.cloudBoxes) {
      try {
        const provider = await providerForBox(target);
        if (!provider.syncTransport) {
          log.warn(`  -> ${target.name}: provider '${target.provider ?? ''}' has no transport; skipped`);
          continue;
        }
        const insp = await provider.inspect(target);
        if (insp.state !== 'running') {
          log.info(`  -> ${target.name}: ${insp.state}; skipped (resume it and re-run to include it)`);
          continue;
        }
        const result = await propagateStagedSettings(
          transportSettingsTarget(provider.syncTransport(target), agentBoxConfigDir(agent), target.name),
          staged,
        );
        process.stdout.write(`  -> ${target.name}: ${summarize(result)}\n`);
      } catch (err) {
        log.warn(`  -> ${target.name}: failed — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    await removeStagingDir(stagingDir);
  }
}
