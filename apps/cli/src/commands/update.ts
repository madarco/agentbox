import { spawn } from 'node:child_process';
import { confirm, intro, log, outro } from '../lib/prompt.js';
import { DEFAULT_BOX_IMAGE } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { detectExecutionMethod, type ExecMethod } from '../exec-method.js';
import { handleLifecycleError } from './_errors.js';
import { runPostUpdateRefresh } from '../lib/post-update-refresh.js';
import { isNewer } from '../lib/semver-lite.js';
import { maybePromptStar } from '../lib/star-prompt.js';
import { AGENTBOX_VERSION } from '../version.js';

interface UpdateOptions {
  yes?: boolean;
  dryRun?: boolean;
  skipSelf?: boolean;
  skipSkills?: boolean;
}

/** The published npm package name (apps/cli/package.json `name`). */
const PKG = '@madarco/agentbox';

function selfUpdateCommand(method: ExecMethod): { cmd: string; args: string[] } | null {
  if (method === 'npm') return { cmd: 'npm', args: ['install', '-g', `${PKG}@latest`] };
  if (method === 'pnpm') return { cmd: 'pnpm', args: ['add', '-g', `${PKG}@latest`] };
  return null;
}

function describeSelfUpdate(method: ExecMethod): string {
  switch (method) {
    case 'npm':
      return 'self-update: npm install -g @madarco/agentbox@latest';
    case 'pnpm':
      return 'self-update: pnpm add -g @madarco/agentbox@latest';
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

/** Best-effort current-vs-latest report; a dead network never blocks the update. */
async function reportLatest(): Promise<void> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${PKG}/latest`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;
    const body = (await res.json()) as { version?: unknown };
    const latest = typeof body.version === 'string' ? body.version : undefined;
    if (latest === undefined) return;
    log.info(
      isNewer(latest, AGENTBOX_VERSION)
        ? `current ${AGENTBOX_VERSION} → latest ${latest}`
        : `already the latest (${AGENTBOX_VERSION}) — refreshing skills/image/relay/app anyway`,
    );
  } catch {
    // Offline — proceed without the report.
  }
}

export const updateCommand = new Command('self-update')
  .description(
    'Update agentbox: self-update via npm/pnpm (unless run via npx), refresh the host skills, wipe the box image so it rebuilds, reload the relay, and update the menu-bar app',
  )
  .option('-y, --yes', 'skip the confirmation prompt')
  .option('--dry-run', "show what would happen, don't change anything")
  .option('--skip-self', 'skip the package self-update; only refresh the skills + image + relay + app')
  .option('--skip-skills', 'skip refreshing the host skill files in ~/.claude, ~/.codex, ~/.config/opencode')
  .action(async (opts: UpdateOptions) => {
    try {
      const method = detectExecutionMethod({
        userAgent: process.env.npm_config_user_agent,
        argv1: process.argv[1],
      });

      intro('agentbox self-update');
      await reportLatest();

      const selfStep = opts.skipSelf
        ? 'self-update: skipped (--skip-self)'
        : describeSelfUpdate(method);
      const skillsStep = opts.skipSkills
        ? 'skills: skipped (--skip-skills)'
        : 'skills: refresh agentbox-managed host skill files in ~/.claude (and Codex/OpenCode)';
      log.info(
        [
          'plan:',
          `  ${selfStep}`,
          `  ${skillsStep}`,
          `  image: docker image rm -f ${DEFAULT_BOX_IMAGE} (rebuilds on next create/claude)`,
          '  relay: stop, then respawn',
          '  app: update the menu-bar app if the published build changed (macOS, when installed)',
        ].join('\n'),
      );

      if (opts.dryRun) {
        outro('dry run — nothing changed');
        return;
      }

      if (!opts.yes) {
        const ok = await confirm({ message: 'Proceed with update?', initialValue: true });
        if (!ok) {
          log.info('cancelled');
          return;
        }
      }

      // Step 1: self-update. selfUpdated stays false unless an npm/pnpm global
      // install actually ran — that's what makes the running process stale.
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

      // Step 2: the post-update refresh (skills, image, relay, tray, version
      // stamp). After a real self-update this process is the old build — its
      // bundled skills are stale and respawning the relay would relaunch the
      // stale bin — so shell out to the freshly-installed binary, which also
      // stamps its own (new) version. Otherwise this process is already
      // current: run in-process.
      if (selfUpdated) {
        const args = ['_post-update-refresh', ...(opts.skipSkills ? ['--skip-skills'] : [])];
        const code = await runInherit('agentbox', args);
        if (code !== 0) {
          // Leave the stamp on the old version: the next run of the new
          // binary detects the mismatch and offers the refresh again.
          log.warn(
            `post-update refresh exited ${String(code)} — run \`agentbox self-update --skip-self\` to retry`,
          );
        }
      } else {
        await runPostUpdateRefresh({ skipSkills: opts.skipSkills });
      }

      await maybePromptStar({ trigger: 'self-update' });
      outro('update complete');
    } catch (err) {
      handleLifecycleError(err);
    }
  });
