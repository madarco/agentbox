import { Command } from 'commander';
import {
  isRealAgentCredential,
  planPropagateTargets,
  pushCredentialToBox,
  readCredentialBackup,
  readState,
  resolveAgentSpec,
  type AgentId,
} from '@agentbox/sandbox-core';
import { DEFAULT_BOX_IMAGE, volumeSettingsTarget } from '@agentbox/sandbox-docker';
import type { BoxRecord } from '@agentbox/core';
import { providerForBox } from '../provider/registry.js';
import { handleLifecycleError } from './_errors.js';

interface PropagateOpts {
  agent: string;
  sourceBox?: string;
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

/**
 * `agentbox credentials propagate` — push the host credential backup
 * (`~/.agentbox/<agent>-credentials.json`) into every other box: the docker
 * config volumes via helper containers (covers paused boxes too — the volume
 * is the box's credential store) and each *running* cloud box over its
 * provider transport. Paused/stopped cloud boxes are reconciled on resume.
 *
 * Hidden: the relay spawns it (debounced) whenever a box reports a refreshed
 * credential — claude's OAuth refresh rotates the refresh token, so every
 * other copy dies the moment one box refreshes. Also usable manually for
 * recovery. All mechanics live in the sync layer (`pushCredentialToBox`,
 * `planPropagateTargets`, `volumeSettingsTarget`).
 */
const propagateCommand = new Command('propagate')
  .description('Push the host credential backup for an agent into all other boxes')
  .requiredOption('--agent <agent>', 'claude|codex|opencode')
  .option('--source-box <id>', 'box the update came from (skipped as a target)')
  .action(async (opts: PropagateOpts) => {
    try {
      const spec = resolveAgentSpec(opts.agent);
      const agent = spec.id;
      const content = await readCredentialBackup(agent);
      if (content === null || !isRealAgentCredential(agent, content)) {
        throw new Error(
          `no usable ${agent} credential backup at ${spec.credential.hostBackup}; nothing to propagate`,
        );
      }

      const state = await readState();
      const sourceBox = state.boxes.find((b) => b.id === opts.sourceBox);
      // The source box's own store already holds the fresh blob: its docker
      // volume IS the file the watcher saw change; a cloud source box wrote it
      // to its own FS. Excluding the source volume skips a guaranteed no-op.
      const excludeVolume =
        sourceBox && (sourceBox.provider ?? 'docker') === 'docker'
          ? (isolatedVolumeOf(sourceBox, agent) ?? spec.dockerVolume)
          : undefined;
      const plan = planPropagateTargets(state.boxes, {
        agent,
        sourceBoxId: opts.sourceBox ?? '',
        scope: 'all',
        excludeVolume,
      });

      let pushed = 0;
      let failed = 0;
      const image = sourceBox?.image || DEFAULT_BOX_IMAGE;
      for (const vol of plan.dockerVolumes) {
        try {
          await volumeSettingsTarget(vol.volume, image, vol.volume).writeText(
            spec.credential.boxRelPath,
            content,
            { mode: 0o600 },
          );
          pushed += 1;
          process.stdout.write(`pushed ${agent} credential to volume ${vol.volume} (${vol.boxNames.join(', ')})\n`);
        } catch (err) {
          failed += 1;
          process.stderr.write(
            `volume ${vol.volume}: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }

      for (const target of plan.cloudBoxes) {
        try {
          const provider = await providerForBox(target);
          if (!provider.syncTransport) {
            process.stdout.write(`${target.name}: no transport; skipped\n`);
            continue;
          }
          const insp = await provider.inspect(target);
          if (insp.state !== 'running') {
            process.stdout.write(`${target.name}: ${insp.state}; skipped (reconciled on resume)\n`);
            continue;
          }
          await pushCredentialToBox(provider.syncTransport(target), agent, content);
          pushed += 1;
          process.stdout.write(`pushed ${agent} credential to ${target.name}\n`);
        } catch (err) {
          failed += 1;
          process.stderr.write(
            `${target.name}: ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
      }

      process.stdout.write(
        `propagated ${agent} credential to ${String(pushed)} target(s)` +
          (failed > 0 ? `, ${String(failed)} failed` : '') +
          '\n',
      );
      if (failed > 0) process.exitCode = 1;
    } catch (err) {
      handleLifecycleError(err);
    }
  });

export const credentialsCommand = new Command('credentials')
  .description('Manage agent credential sync across boxes')
  .addCommand(propagateCommand);
