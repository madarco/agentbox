import { spawnSync } from 'node:child_process';
import { log } from '@clack/prompts';
import type { BoxRecord } from '@agentbox/core';
import { hostOpenCommand } from '@agentbox/sandbox-core';
import { openWebAppOnVncScreen } from '@agentbox/sandbox-cloud';
import {
  ensureBoxBrowserShowingApp,
  inspectBox,
  resolveVncViewerUrl,
  startBox,
  unpauseBox,
} from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { resolveBoxOrExit } from '../box-ref.js';
import { withOwningHub } from '../control-plane/with-hub.js';
import { providerForBox } from '../provider/registry.js';
import { handleLifecycleError } from './_errors.js';

interface ScreenOptions {
  print?: boolean;
  loopback?: boolean;
  ttl?: string;
}

/** Daytona's signed-URL ceiling is 24h; mirror `agentbox url`'s clamp. */
const SIGNED_URL_TTL_MIN = 1;
const SIGNED_URL_TTL_MAX = 86400;

function parseTtlOrExit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (
    !Number.isFinite(n) ||
    !Number.isInteger(n) ||
    n < SIGNED_URL_TTL_MIN ||
    n > SIGNED_URL_TTL_MAX
  ) {
    throw new Error(
      `--ttl must be an integer between ${String(SIGNED_URL_TTL_MIN)} and ${String(SIGNED_URL_TTL_MAX)} seconds`,
    );
  }
  return n;
}

/**
 * Point the docker box's in-box browser at its web service so the app shows
 * *inside* the VNC desktop (the host browser only gets the noVNC viewer).
 * Best-effort — never fails `screen`. This is genuine box IO, so it stays on the
 * provider even when the VNC URL comes off the hub payload.
 */
async function dockerBrowserPrep(box: BoxRecord): Promise<void> {
  const br = await ensureBoxBrowserShowingApp(box);
  if (br.up && !br.alreadyRunning) {
    log.info(
      br.target !== 'about:blank'
        ? `opening ${br.target} in the in-box browser (the VNC view shows its progress)`
        : 'starting the in-box browser (the VNC view shows its progress)',
    );
  } else if (br.alreadyRunning) {
    log.info('in-box browser already running; left it untouched');
  } else {
    log.warn(`could not start in-box browser: ${br.reason ?? 'unknown'}`);
  }
}

/**
 * Provider-direct VNC URL resolution — the path for `--loopback` / `--ttl` and
 * the fallback when the payload carries no `vnc` endpoint (cloud boxes, whose
 * signed VNC URL must be resolved live). Handles its own auto-unpause/start and
 * in-box browser prep, same as the historical behavior.
 */
async function resolveViaProvider(box: BoxRecord, opts: ScreenOptions): Promise<string> {
  const ttl = parseTtlOrExit(opts.ttl);
  const p = await providerForBox(box);

  if ((box.provider ?? 'docker') === 'docker') {
    const insp = await inspectBox(box.id);
    if (insp.state === 'paused') {
      log.info('box is paused; unpausing');
      await unpauseBox(box.id);
    } else if (insp.state === 'stopped') {
      log.info('box is stopped; starting');
      await startBox(box.id);
    } else if (insp.state === 'missing') {
      throw new Error(`box ${box.name} has no container; was it destroyed?`);
    }
    await dockerBrowserPrep(box);
  } else {
    const state = await p.probeState(box);
    if (state === 'paused') {
      log.info('box is paused; resuming');
      await p.resume(box);
    } else if (state === 'stopped') {
      log.info('box is stopped; starting');
      await p.start(box);
    } else if (state === 'missing') {
      throw new Error(`cloud sandbox for ${box.name} is missing; was it deleted?`);
    }

    // Open the box's web app *inside* the VNC desktop, mirroring the docker path.
    // Best-effort, never fails `screen`.
    const br = await openWebAppOnVncScreen(box, p);
    if (br.opened) {
      log.info(`opened ${br.target ?? ''} in the in-box browser (visible in the VNC view)`);
    } else if (br.reason && br.reason !== 'no web service') {
      log.warn(`could not open in-box browser (continuing): ${br.reason}`);
    }
  }

  return resolveVncViewerUrl(box, p, {
    ...(opts.loopback ? { loopback: true } : {}),
    ...(ttl === undefined ? {} : { ttl }),
  });
}

function emitUrl(url: string, opts: ScreenOptions): void {
  if (opts.print) {
    process.stdout.write(`${url}\n`);
    return;
  }
  const opened = spawnSync(hostOpenCommand(), [url], { stdio: 'inherit' });
  if (opened.status !== 0) {
    throw new Error(`open ${url} failed (exit ${String(opened.status ?? 'n/a')})`);
  }
  process.stdout.write(`opened ${url}\n`);
}

export const screenCommand = new Command('screen')
  .description("Open a box's VNC (noVNC) viewer in the browser (auto-unpause/start)")
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('--print', 'print the URL to stdout instead of launching the browser')
  .option('--loopback', 'docker only: use the 127.0.0.1 URL instead of the OrbStack .orb.local URL')
  .option('--ttl <seconds>', 'cloud only: signed-URL expiry in seconds (default 3600, max 86400)')
  .action(async (idOrName: string | undefined, opts: ScreenOptions) => {
    try {
      const box = await resolveBoxOrExit(idOrName);

      if (!box.vncEnabled) {
        throw new Error(`VNC is disabled for box ${box.name} — recreate without \`--no-vnc\``);
      }

      // The hub is the default path for every provider: a docker box's URL is
      // already complete on the Box payload, and a cloud box's is minted live by
      // `GET /boxes/:id/vnc` (its signed URL expires, so it can't ride a payload).
      // `--loopback` is the one escape hatch — it means "the 127.0.0.1 URL on THIS
      // machine", which a remote control box cannot answer.
      if (!opts.loopback) {
        const ttl = parseTtlOrExit(opts.ttl);
        // Box-scoped → the box's OWNING hub (withOwningHub); a plain withHubClient
        // would send a docker box's `getBox` to a configured remote control box that
        // never owned it → `not_found`. Resolved URL captured via closure.
        let hubUrl: string | null = null;
        const r = await withOwningHub(box, async (client) => {
          let b = await client.getBox(box.id);
          if (b.state && b.state !== 'running') {
            process.stderr.write(
              `box ${box.name} was ${b.state}; started it to resolve a live URL\n`,
            );
            await client.lifecycle(box.id, 'start');
            b = await client.getBox(box.id);
          }
          // Point the in-box browser at the box's web app so the desktop isn't a
          // blank X screen. The hub does this for docker AND cloud, and it is the
          // only spelling that also works against a remote control box.
          // Best-effort: an older hub 400s on the action; the viewer still works.
          await client.lifecycle(box.id, 'screen').catch(() => {});
          hubUrl = b.vncUrl ?? (b.vncEnabled ? (await client.vncUrl(box.id, { ttl })).url : null);
        });
        if (r === undefined) return; // hub error; withOwningHub set the exit code
        if (hubUrl) {
          emitUrl(hubUrl, opts);
          return;
        }
        // No hub owns this box (or it reports no VNC) — fall through to the provider.
      }

      emitUrl(await resolveViaProvider(box, opts), opts);
    } catch (err) {
      handleLifecycleError(err);
    }
  });
