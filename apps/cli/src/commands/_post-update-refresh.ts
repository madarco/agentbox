/**
 * Hidden worker `agentbox self-update` shells out to after a real npm/pnpm
 * package update: the old (still-running) build can't refresh skills or stamp
 * the new version itself, so the freshly-installed binary does the whole
 * post-update refresh — skills, box image, relay respawn, tray app — and
 * stamps its own version into `~/.agentbox/update-state.json`.
 */

import { Command } from 'commander';
import { runPostUpdateRefresh } from '../lib/post-update-refresh.js';
import { handleLifecycleError } from './_errors.js';

export const postUpdateRefreshCommand = new Command('_post-update-refresh')
  .description('internal: refresh skills, box image, relay, and tray after a package update')
  .option('--skip-skills', 'skip refreshing the host skill files')
  .action(async (opts: { skipSkills?: boolean }) => {
    try {
      await runPostUpdateRefresh({ skipSkills: opts.skipSkills });
    } catch (err) {
      handleLifecycleError(err);
    }
  });
