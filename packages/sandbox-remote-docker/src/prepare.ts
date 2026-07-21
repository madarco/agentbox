/**
 * `agentbox prepare --provider docker:<host>` — bake the box image on a remote
 * engine.
 *
 * Unlike the VPS providers, this is not a mandatory gate: a remote engine can
 * build from a Dockerfile, so `create` ensures the image itself and prepare is
 * simply the eager form ("do the slow part now, not when I'm waiting for a
 * box"). It is also the only place that writes `remote-docker-prepared.json`,
 * which exists purely so `prepare --status` / `doctor` can report what has been
 * baked where.
 */

import type { PrepareOptions, PrepareResult } from '@agentbox/core';
import { ensureRemoteImage } from './image.js';
import { ensureTunnel } from './remote-docker.js';
import { recordPreparedHost } from './prepared-state.js';
import { requireHostAlias } from './hosts-registry.js';
import { parseRemoteTarget } from './target.js';

export async function prepareRemoteDocker(
  opts: PrepareOptions & { host?: string },
): Promise<PrepareResult> {
  const log = opts.onLog ?? ((): void => {});
  const spec = (opts.host ?? '').trim();
  if (!spec) {
    throw new Error(
      'remote-docker: prepare needs a host alias — `agentbox prepare --provider docker:<alias>`, ' +
        'or set `box.remoteDockerHost`.',
    );
  }
  requireHostAlias(spec);
  const remote = parseRemoteTarget(spec);
  const target = await ensureTunnel(`engine:${remote.spec}`, remote);

  log(`[prepare] ensuring the box image on ${remote.spec}`);
  const res = await ensureRemoteImage(target, {
    ...(opts.claudeInstall ? { claudeInstall: opts.claudeInstall } : {}),
    ...(opts.registry !== undefined ? { registry: opts.registry } : {}),
    ...(opts.allowPull !== undefined ? { allowPull: opts.allowPull } : {}),
    ...(opts.force ? { force: true } : {}),
    onLog: log,
  });

  if (res.contextSha256) {
    recordPreparedHost(remote.spec, { imageRef: res.ref, contextSha256: res.contextSha256 });
  }
  log(`[prepare] ${remote.spec} ready — ${res.ref} (${res.source})`);

  // Deliberately no `snapshotName`: returning one makes the CLI pin
  // `box.imageRemoteDocker` to it, which would freeze every future create on
  // today's fingerprint and defeat the self-updating ref.
  return {};
}
