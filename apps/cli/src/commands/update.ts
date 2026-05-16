import { spawn } from 'node:child_process';
import { confirm, intro, isCancel, log, outro, spinner } from '@clack/prompts';
import {
  DEFAULT_BOX_IMAGE,
  ensureRelay,
  removeImage,
  stopRelay,
} from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { detectExecutionMethod, type ExecMethod } from '../exec-method.js';
import { handleLifecycleError } from './_errors.js';

interface UpdateOptions {
  yes?: boolean;
  dryRun?: boolean;
  skipSelf?: boolean;
}

/** The published npm package name (apps/cli/package.json `name`). */
const PKG = 'agentbox';

function selfUpdateCommand(method: ExecMethod): { cmd: string; args: string[] } | null {
  if (method === 'npm') return { cmd: 'npm', args: ['install', '-g', `${PKG}@latest`] };
  if (method === 'pnpm') return { cmd: 'pnpm', args: ['add', '-g', `${PKG}@latest`] };
  return null;
}

function describeSelfUpdate(method: ExecMethod): string {
  switch (method) {
    case 'npm':
      return 'self-update: npm install -g agentbox@latest';
    case 'pnpm':
      return 'self-update: pnpm add -g agentbox@latest';
    case 'npx':
      return 'self-update: skipped (running via npx — always the latest version)';
    case 'direct':
      return 'self-update: skipped (running from source — no global install to update)';
  }
}

function runInherit(cmd: string, args: string[]): Promise<number> {
  return new Promise<number>((resolveP, rejectP) => {
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', rejectP);
    child.on('close', (code) => resolveP(code ?? 0));
  });
}

export const updateCommand = new Command('update')
  .description(
    'Update agentbox: self-update via npm/pnpm (unless run via npx), wipe the box image so it rebuilds, and reload the relay',
  )
  .option('-y, --yes', 'skip the confirmation prompt')
  .option('--dry-run', "show what would happen, don't change anything")
  .option('--skip-self', 'skip the package self-update; only refresh the image + relay')
  .action(async (opts: UpdateOptions) => {
    try {
      const method = detectExecutionMethod({
        userAgent: process.env.npm_config_user_agent,
        argv1: process.argv[1],
      });

      intro('agentbox update');

      const selfStep = opts.skipSelf
        ? 'self-update: skipped (--skip-self)'
        : describeSelfUpdate(method);
      log.info(
        [
          'plan:',
          `  ${selfStep}`,
          `  image: docker image rm -f ${DEFAULT_BOX_IMAGE} (rebuilds on next create/claude)`,
          '  relay: stop, then respawn unless a self-update ran',
        ].join('\n'),
      );

      if (opts.dryRun) {
        outro('dry run — nothing changed');
        return;
      }

      if (!opts.yes) {
        const ok = await confirm({ message: 'Proceed with update?', initialValue: true });
        if (isCancel(ok) || !ok) {
          log.info('cancelled');
          return;
        }
      }

      // Step 1: self-update. selfUpdated stays false unless an npm/pnpm global
      // install actually ran — that's what makes the running process stale and
      // forces the lazy image/relay path below.
      let selfUpdated = false;
      if (opts.skipSelf) {
        log.info('skipping self-update (--skip-self)');
      } else {
        const cmd = selfUpdateCommand(method);
        if (cmd === null) {
          log.info(describeSelfUpdate(method));
        } else {
          log.info(`running: ${cmd.cmd} ${cmd.args.join(' ')}`);
          const code = await runInherit(cmd.cmd, cmd.args);
          if (code !== 0) {
            throw new Error(`${cmd.cmd} exited with code ${String(code)}`);
          }
          selfUpdated = true;
          log.success(`updated ${PKG} via ${cmd.cmd}`);
        }
      }

      // Step 2: wipe the box image. Best-effort; the next create/claude
      // rebuilds it from the (now updated) Dockerfile via ensureImage().
      const s = spinner();
      s.start(`removing image ${DEFAULT_BOX_IMAGE}`);
      const removed = await removeImage(DEFAULT_BOX_IMAGE);
      s.stop(
        removed
          ? `removed image ${DEFAULT_BOX_IMAGE} (rebuilds on next create/claude)`
          : `image ${DEFAULT_BOX_IMAGE} not present (nothing to remove)`,
      );

      // Step 3: reload the relay. Always stop it. Only respawn here when no
      // self-update ran — after a self-update this process is the old build,
      // so respawning would relaunch the stale relay bin. In that case the
      // next `agentbox create`/`claude` (a fresh process) brings it back up.
      const sr = spinner();
      sr.start('stopping relay');
      const stop = await stopRelay();
      sr.stop(
        stop.stopped
          ? `stopped relay (pid ${String(stop.pid)})`
          : 'relay was not running',
      );

      if (selfUpdated) {
        log.info(
          'relay will restart automatically (with the updated build) on your next `agentbox create` / `agentbox claude`',
        );
      } else {
        const sr2 = spinner();
        sr2.start('restarting relay');
        try {
          const ep = await ensureRelay();
          sr2.stop(`relay back up on ${ep.hostUrl}`);
        } catch (err) {
          sr2.stop('relay restart failed');
          log.warn(
            `${err instanceof Error ? err.message : String(err)} — it will retry on the next box command`,
          );
        }
      }

      outro('update complete');
    } catch (err) {
      handleLifecycleError(err);
    }
  });
