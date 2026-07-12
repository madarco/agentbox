/**
 * The post-update refresh: everything that must be brought current after the
 * `@madarco/agentbox` package changed version. Shared by `agentbox
 * self-update` (non-self-updated branch), the hidden `_post-update-refresh`
 * command the fresh binary runs after a real npm/pnpm self-update, and the
 * startup "agentbox was updated — refresh now?" prompt in `index.ts`.
 *
 * Every step is best-effort: a failure warns and continues, and never blocks
 * the command the user actually ran. Nothing here touches box state —
 * `~/.agentbox/state.json`, containers, volumes, and checkpoints are never
 * read or written; the box image untag rebuilds/pulls on the next create and
 * leaves running containers on their existing layers.
 */

import {
  DEFAULT_BOX_IMAGE,
  ensureHub,
  ensureRelay,
  getHubStatus,
  removeImage,
  stopHub,
  stopRelay,
} from '@agentbox/sandbox-docker';
import { installHostSkills } from '../commands/install.js';
import {
  decideTrayUpdate,
  fetchTraySidecarSha,
  installTray,
  trayInstalled,
} from '../commands/install-app.js';
import { AGENTBOX_VERSION } from '../version.js';
import { log } from './prompt.js';
import { readUpdateState, remoteCheckFresh, writeUpdateState } from './update-state.js';

export interface PostUpdateRefreshOptions {
  skipSkills?: boolean;
  quiet?: boolean;
}

/** Update the tray app iff the published zip sha differs from the installed one. */
export async function maybeUpdateTray(say: (msg: string) => void): Promise<void> {
  if (!trayInstalled()) return;
  const state = readUpdateState();
  // Reuse today's cached sidecar sha when we have one; otherwise fetch the
  // ~80-byte sidecar now (5s cap) — still never the 450KB zip unless it changed.
  const latestSha =
    remoteCheckFresh(state) && state.remoteCheck?.trayLatestSha !== undefined
      ? state.remoteCheck.trayLatestSha
      : await fetchTraySidecarSha();
  const decision = decideTrayUpdate({
    installed: true,
    stampedSha: state.traySha,
    latestSha,
  });
  if (!decision.update) {
    say(
      decision.reason === 'no-latest-sha'
        ? 'menu-bar app: release sha unavailable — skipped'
        : 'menu-bar app already current',
    );
    return;
  }
  const res = await installTray({ quiet: true });
  say(
    res.ran
      ? 'menu-bar app updated'
      : `menu-bar app not updated (${res.reason ?? 'unknown'}) — run \`agentbox install app\` manually`,
  );
}

/**
 * Refresh skills + box image + relay + tray, then acknowledge the running
 * version in the stamp so the startup prompt stays quiet until the next
 * package update.
 */
export async function runPostUpdateRefresh(
  opts: PostUpdateRefreshOptions = {},
): Promise<void> {
  const say = (msg: string) => {
    if (!opts.quiet) log.info(msg);
  };
  const warn = (step: string, err: unknown) => {
    log.warn(`${step} failed (${err instanceof Error ? err.message : String(err)}) — continuing`);
  };

  if (!opts.skipSkills) {
    try {
      const res = installHostSkills({ quiet: true });
      say(
        res.written.length > 0
          ? `refreshed host skills (${String(res.written.length)} file(s))`
          : `host skills already current (${String(res.skipped)} skipped)`,
      );
      if (res.blocked.length > 0) {
        log.warn(
          `user-modified skill file(s) left in place: ${res.blocked.join(', ')} — run \`agentbox install --skills-only --force\` to overwrite`,
        );
      }
    } catch (err) {
      warn('host skills refresh', err);
    }
  }

  try {
    const removed = await removeImage(DEFAULT_BOX_IMAGE);
    say(
      removed
        ? `removed image ${DEFAULT_BOX_IMAGE} (rebuilds on next create/claude)`
        : `image ${DEFAULT_BOX_IMAGE} not present (nothing to remove)`,
    );
  } catch (err) {
    warn('box image removal', err);
  }

  // The hub and the relay are separate long-lived processes with separate pid
  // files, and BOTH must be restarted here. An update replaces the installed
  // package directory underneath whichever one is still running, which leaves it
  // in a directory that no longer exists — so it fails on anything it loads
  // lazily ("Cannot find module .../dist-<hash>.js", the bundle's chunks were
  // replaced) and any worker it spawns dies on `process.cwd()`. The hub was
  // previously skipped entirely, so a hub running across an update stayed broken
  // until someone restarted it by hand.
  //
  // The hub serves the relay on the same port, so restart the hub when it's the
  // one running and leave the relay path alone — starting a bare relay under a
  // live hub would just fight over the port.
  try {
    const hub = await getHubStatus();
    if (hub.running || hub.pidAlive) {
      const stop = await stopHub();
      say(stop.stopped ? `stopped hub (pid ${String(stop.pid)})` : 'hub was not running');
      const ep = await ensureHub();
      say(`hub back up on ${ep.hostUrl}`);
    } else {
      const stop = await stopRelay();
      say(stop.stopped ? `stopped relay (pid ${String(stop.pid)})` : 'relay was not running');
      const ep = await ensureRelay();
      say(`relay back up on ${ep.hostUrl}`);
    }
  } catch (err) {
    warn('relay/hub reload', err);
  }

  try {
    await maybeUpdateTray(say);
  } catch (err) {
    warn('menu-bar app update', err);
  }

  writeUpdateState({ lastRunVersion: AGENTBOX_VERSION });
}
