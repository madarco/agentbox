import { confirm, intro, isCancel, log, outro, spinner } from '@clack/prompts';
import { createBox } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { execSync, spawnSync } from 'node:child_process';
import { clampSpinnerLine } from '../spinner-line.js';

interface CreateOptions {
  workspace: string;
  name?: string;
  snapshot?: boolean; // commander: --snapshot / --no-snapshot => true / false / undefined
  image?: string;
  attach?: boolean;
  yes?: boolean;
}

async function resolveUseSnapshot(opts: CreateOptions): Promise<boolean> {
  if (opts.snapshot === true) return true;
  if (opts.snapshot === false) return false;
  if (opts.yes) return true;

  const ans = await confirm({
    message: 'Use a frozen workspace snapshot? (recommended — host stays editable)',
    initialValue: true,
  });
  if (isCancel(ans)) {
    log.error('cancelled');
    process.exit(130);
  }
  return ans;
}

function attachShell(container: string): never {
  // execSync is fine here: we hand control to docker exec and exit on its exit.
  const child = spawnSync('docker', ['exec', '-it', container, 'bash'], {
    stdio: 'inherit',
  });
  process.exit(child.status ?? 0);
}

export const createCommand = new Command('create')
  .description('Create and start a new agent box (Docker container with FUSE overlay)')
  .option('-w, --workspace <path>', 'host workspace to mount', process.cwd())
  .option('-n, --name <name>', 'friendly box name (default: <workspace-basename>-<id>)')
  .option('--snapshot', 'use a frozen APFS clone of the workspace as the overlay lower')
  .option('--no-snapshot', 'bind the live workspace directly (host edits leak into reads)')
  .option('--image <ref>', 'override the box image', undefined)
  .option('--attach', 'drop into a shell inside the box after it is ready')
  .option('-y, --yes', 'skip prompts, accept defaults (snapshot=on)')
  .action(async (opts: CreateOptions) => {
    intro('agentbox create');

    const useSnapshot = await resolveUseSnapshot(opts);

    const s = spinner();
    s.start('creating box');
    try {
      const result = await createBox({
        workspacePath: opts.workspace,
        name: opts.name,
        useSnapshot,
        image: opts.image,
        onLog: (line) => s.message(clampSpinnerLine(line)),
      });
      s.stop(`box ${result.record.container} ready`);

      log.info(`id:        ${result.record.id}`);
      log.info(`container: ${result.record.container}`);
      log.info(`image:     ${result.record.image}${result.imageBuilt ? ' (built just now)' : ''}`);
      log.info(`lower:     ${result.record.lowerPath}`);
      log.info(`upper:     ${result.record.upperVolume}`);
      if (result.record.snapshotDir) {
        log.info(`snapshot:  ${result.record.snapshotDir}`);
      }

      for (const check of result.overlayChecks) {
        log.success(`${check.name} — ${check.detail}`);
      }

      log.message(
        [
          '',
          'Try it:',
          `  docker exec -it ${result.record.container} bash`,
          `  docker exec ${result.record.container} ls /workspace`,
          '',
          'Destroy:',
          `  docker rm -f ${result.record.container}`,
          `  docker volume rm ${result.record.upperVolume} ${result.record.nodeModulesVolume}`,
        ].join('\n'),
      );

      outro('done');

      if (opts.attach) {
        attachShell(result.record.container);
      }
    } catch (err) {
      s.stop('failed');
      const msg = err instanceof Error ? err.message : String(err);
      log.error(msg);
      // Help the user clean up partial state.
      try {
        const running = execSync('docker ps --format "{{.Names}}"', {
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .toString()
          .split('\n')
          .filter((n) => n.startsWith('agentbox-'));
        if (running.length > 0) {
          log.warn(`leftover containers: ${running.join(', ')}`);
          log.warn(`remove with: docker rm -f ${running.join(' ')}`);
        }
      } catch {
        /* best-effort */
      }
      process.exit(1);
    }
  });
