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
 * read or written, and the box image is never deleted (it is fingerprinted;
 * `ensureImage` rebuilds it on the next create iff the build context changed).
 */

import {
  DEFAULT_BOX_IMAGE,
  ensureHub,
  ensureRelay,
  evaluateDockerBaseFreshness,
  getHubStatus,
  stopHub,
  stopRelay,
} from '@agentbox/sandbox-docker';
import { installHostSkills } from '../commands/install.js';
import {
  decideTrayUpdate,
  fetchTraySidecarSha,
  installTray,
  readInstalledTrayVersion,
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
    installedVersion: await readInstalledTrayVersion(),
    latestVersion: state.remoteCheck?.trayLatestVersion,
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

  // The box image used to be DELETED here — a blunt "be sure it's fresh" from before
  // the image was fingerprinted. It is redundant now: `ensureImage` hashes the build
  // context on every create and rebuilds when that hash differs from the one stamped
  // in docker-prepared.json, *even if the image already exists*. So deleting it never
  // caused a rebuild that wouldn't have happened anyway — it only threw away an image
  // whose context was byte-identical, making the next create re-pull (or rebuild) for
  // nothing. A CLI update that doesn't touch the build context now costs nothing.
  //
  // Report the comparison instead. It is a local file hash — no docker, no network.
  try {
    // The same evaluator the hub/app use for their "stale — re-bake" pill, so the
    // CLI and the app can never disagree about whether a re-bake is coming.
    const freshness = await evaluateDockerBaseFreshness();
    say(
      freshness.state === 'fresh'
        ? `box image ${DEFAULT_BOX_IMAGE} already current (build context unchanged)`
        : freshness.state === 'stale'
          ? `box image ${DEFAULT_BOX_IMAGE}: build context changed — rebuilds on next create`
          : freshness.state === 'unprepared'
            ? `box image ${DEFAULT_BOX_IMAGE} not present — pulled on next create`
            : `box image ${DEFAULT_BOX_IMAGE}: freshness unknown — left alone`,
    );
  } catch (err) {
    warn('box image check', err);
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
    // `running` is NOT the test: it only means /healthz answered on the shared
    // port, which a bare relay does too. Gating on it would send a relay-only
    // host down the hub branch and let `ensureHub` quietly promote it to a full
    // hub on update. `ui` (healthz reported the Next UI) and a live hub pid are
    // what actually identify a hub.
    if (hub.ui || hub.pidAlive) {
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
