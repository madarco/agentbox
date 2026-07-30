import { spawnSync } from 'node:child_process';
import { log } from '@clack/prompts';
import type { BoxRecord } from '@agentbox/core';
import { hostOpenCommand } from '@agentbox/sandbox-core';
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
import { withHubClient } from '../control-plane/with-hub.js';
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
  return p.resolveUrl(box, { kind: 'web', ttl });
}

function emitUrl(url: string, opts: UrlOptions): void {
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

      // The default docker URL comes off the enriched Box payload the hub already
      // computes (the same field the web UI links to), so `url` doesn't probe the
      // provider from the laptop. Cloud stays on the provider path: a cloud box's
      // payload `webUrl` is the NON-signed `previewUrl` (a header-token URL for
      // Daytona — not openable from a browser click), while `resolveUrl` mints a
      // browser-safe SIGNED URL. `--loopback` / `--ttl` also need provider-level
      // URL computation the payload can't express, so they take the provider path.
      if (!opts.loopback && opts.ttl === undefined && (box.provider ?? 'docker') === 'docker') {
        // Returns the payload URL, or null to fall back to the provider; the
        // callback never returns undefined, so undefined uniquely means the hub
        // call itself failed (withHubClient already reported it).
        const payloadUrl = await withHubClient({}, async (client): Promise<string | null> => {
          let b = await client.getBox(box.id);
          if (b.state && b.state !== 'running') {
            // A paused/stopped box serves nothing and a cached preview URL can be
            // stale, so start it (idempotent) — the hub's start refreshes the
            // box's endpoints server-side. Notice on STDERR so `--print` stays
            // pipeable while the side effect stays visible.
            process.stderr.write(
              `box ${box.name} was ${b.state}; started it to resolve a live URL\n`,
            );
            await client.lifecycle(box.id, 'start');
            b = await client.getBox(box.id);
          }
          return b.webUrl ?? null;
        });
        if (payloadUrl === undefined) return; // hub error; withHubClient set the exit code
        if (payloadUrl) {
          emitUrl(payloadUrl, opts);
          return;
        }
        // The payload carried no web endpoint — fall through to the provider.
      }

      emitUrl(await resolveViaProvider(box, opts), opts);
    } catch (err) {
      handleLifecycleError(err);
    }
  });
