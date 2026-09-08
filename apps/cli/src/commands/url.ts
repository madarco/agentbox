import { spawnSync } from 'node:child_process';
import { log } from '@clack/prompts';
import type { BoxRecord } from '@agentbox/core';
import {
  findAgentSpec,
  hostOpenCommand,
  readServiceUrlFields,
  serviceSignInUrl,
} from '@agentbox/sandbox-core';
import {
  detectEngine,
  getBoxHostPaths,
  inspectBox,
  portlessGetUrl,
  startBox,
  unpauseBox,
} from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { resolveBoxOrExit } from '../box-ref.js';
import { withOwningHub } from '../control-plane/with-hub.js';
import { providerForBox } from '../provider/registry.js';
import { handleLifecycleError } from './_errors.js';

interface UrlOptions {
  print?: boolean;
  loopback?: boolean;
  ttl?: string;
}

/** Daytona's signed-URL ceiling is 24h; clamp the CLI flag to the same. */
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
 * Provider-direct URL resolution — the path for `--loopback` / `--ttl` (which the
 * enriched Box payload can't express: a loopback URL, the docker host port, or a
 * custom-TTL signed URL) and the fallback when the payload carries no `web` endpoint.
 * Handles its own auto-unpause/start, same as the historical behavior.
 */
async function resolveViaProvider(box: BoxRecord, opts: UrlOptions): Promise<string> {
  const provider = box.provider ?? 'docker';
  if (provider === 'docker') {
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

    // Re-read after a possible start: startBox re-resolves & persists the
    // reallocated webHostPort (lifecycle.ts).
    const { record } = await getBoxHostPaths(box.id);
    if (record.webContainerPort === undefined) {
      throw new Error(
        `box ${box.name} predates the reserved web port; recreate it to use \`agentbox url\``,
      );
    }

    const engine = await detectEngine();
    if (engine === 'orbstack' && !opts.loopback) {
      // OrbStack auto-routes <container>.orb.local to the container; :80 is
      // declared (EXPOSE 80) so no port suffix is needed.
      return `http://${record.container}.orb.local`;
    }
    if (record.portlessAlias && !opts.loopback) {
      // A Portless route was registered — use the URL resolved at
      // create/start; fall back to a live `portless get` for older records.
      return record.portlessUrl ?? (await portlessGetUrl(record.portlessAlias));
    }
    if (record.webHostPort === undefined) {
      throw new Error(
        `web port not resolved for box ${box.name}; is the container running? try \`agentbox inspect ${box.name}\``,
      );
    }
    return `http://127.0.0.1:${String(record.webHostPort)}`;
  }

  // Cloud provider: probeState + lifecycle handled by the provider; URL is a
  // signed preview URL (token embedded in the URL itself) so the host browser
  // can open it without a custom header.
  const ttl = parseTtlOrExit(opts.ttl);
  const p = await providerForBox(box);
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
  // `loopback` has to ride along: the cloud resolver honours it (it is what
  // skips a registered Portless alias), and dropping it here made
  // `agentbox url --loopback` silently return the proxied URL for every cloud
  // box — the flag's one job.
  return p.resolveUrl(box, { kind: 'web', ttl, ...(opts.loopback ? { loopback: true } : {}) });
}

/**
 * Open (or print) a box's web URL.
 *
 * When the box runs a service agent whose UI wants a token the box generated
 * for itself, `signInUrl` is the one that actually gets you IN, so that is what
 * the browser is handed. `--print` still prints the BARE url: it is the
 * pipeable surface, and a fragment on it would break anything that appends a
 * path — the sign-in link goes to stderr beside it, where this command already
 * puts its notices.
 */
function emitUrl(url: string, signInUrl: string | null, opts: UrlOptions): void {
  if (opts.print) {
    process.stdout.write(`${url}\n`);
    if (signInUrl) process.stderr.write(`open: ${signInUrl}\n`);
    return;
  }
  const target = signInUrl ?? url;
  const opened = spawnSync(hostOpenCommand(), [target], { stdio: 'inherit' });
  if (opened.status !== 0) {
    throw new Error(`open ${target} failed (exit ${String(opened.status ?? 'n/a')})`);
  }
  process.stdout.write(`opened ${target}\n`);
}

/**
 * The sign-in link for a box resolved through the PROVIDER path (`--loopback`
 * / `--ttl`, which the hub route cannot express).
 *
 * The hub answers this itself on the ordinary path; here the CLI holds the
 * provider already, so it reads the agent's declared url fields the same way
 * the hub would. Never fatal: a daemon that is down has no token, and the plain
 * URL plus its own prompt is a better answer than a failed command.
 */
async function signInUrlViaProvider(box: BoxRecord, url: string): Promise<string | null> {
  try {
    const spec = findAgentSpec(box.lastAgent ?? box.agents?.[0] ?? '');
    const fields = spec?.service?.urlFields ?? [];
    if (fields.length === 0) return null;
    const provider = await providerForBox(box);
    return serviceSignInUrl(url, await readServiceUrlFields(provider, box, fields));
  } catch {
    return null;
  }
}

export const urlCommand = new Command('url')
  .description(
    "Open a box's web app URL in the browser, even when no service declares `expose:` (auto-unpause/start)",
  )
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('--print', 'print the URL to stdout instead of launching the browser')
  .option(
    '--loopback',
    'use the 127.0.0.1 URL instead of the OrbStack .orb.local / Portless .localhost URL',
  )
  .option('--ttl <seconds>', 'cloud only: signed-URL expiry in seconds (default 3600, max 86400)')
  .action(async (idOrName: string | undefined, opts: UrlOptions) => {
    try {
      const box = await resolveBoxOrExit(idOrName);

      // The hub resolves this LIVE (`GET /boxes/:id/web`) and reads a service
      // agent's own token while it is in there, so every provider takes this
      // path — not just docker, and never the Box payload's recorded `webUrl`,
      // whose port belongs to whatever forward existed when it was written.
      //
      // `--loopback` / `--ttl` are the exception: they need provider-level URL
      // computation the route does not express, so they fall through below.
      if (!opts.loopback && opts.ttl === undefined) {
        // Box-scoped, so it goes to the box's OWNING hub (withOwningHub); a plain
        // withHubClient would send a docker box's request to a configured remote
        // control box that never owned it → `not_found`. Captured via closure
        // (the op returns void); `null` falls through to the provider path, as
        // does a `not-found` outcome.
        let resolved: { url: string; signInUrl: string | null } | null = null;
        const r = await withOwningHub(box, async (client) => {
          const b = await client.getBox(box.id);
          if (b.state && b.state !== 'running') {
            // The route refuses a box that is not running, and this command's
            // contract is to auto-start. Notice on STDERR so `--print` stays
            // pipeable while the side effect stays visible.
            process.stderr.write(
              `box ${box.name} was ${b.state}; started it to resolve a live URL\n`,
            );
            await client.lifecycle(box.id, 'start');
          }
          resolved = await client.webUrl(box.id);
        });
        if (r === undefined) return; // hub error; withOwningHub set the exit code
        if (resolved) {
          const { url, signInUrl } = resolved as { url: string; signInUrl: string | null };
          emitUrl(url, signInUrl, opts);
          return;
        }
        // No hub owns this box — fall through to the provider path.
      }

      const url = await resolveViaProvider(box, opts);
      emitUrl(url, await signInUrlViaProvider(box, url), opts);
    } catch (err) {
      handleLifecycleError(err);
    }
  });
