import type { EffectiveConfig } from '@agentbox/config';
import type { CreateRouting } from '@agentbox/cli-kit';
import { readGitOriginUrl } from '@agentbox/sandbox-cloud';
import { resolveCustodyTarget } from '../commands/control-plane.js';
import { hubCanRunEngine, unsharedHostReason } from './remote-docker-share.js';
import { remoteHubConfigured } from './remote-hub.js';

export interface CreateRoutingInput {
  /** Bare provider name (e.g. `e2b`, `docker`), post `parseProviderSpec`. */
  providerName: string;
  /** remote-docker only: the engine alias the spec named. */
  remoteHost?: string;
  effective: EffectiveConfig;
  /** Absolute project root — the repo whose `origin` the hub worker clones. */
  projectRoot: string;
  /** `--via-hub`: force the hub (the caller then hard-fails on missing prereqs). */
  forceHub?: boolean;
  /** `--local`: force a local build even when a hub is configured. */
  forceLocal?: boolean;
  /** `--url` override for the control box. */
  urlFlag?: string;
}

// Declared on the agent contract in `@agentbox/cli-kit`, because an agent
// package reads `ctx.routing()` and cannot import `apps/cli`. Re-exported here
// so this module stays the obvious home for the routing decision itself.
export type { CreateRouting } from '@agentbox/cli-kit';

/**
 * Decide whether a cloud create runs on the remote hub (the control box) or on
 * this machine. When a control box is configured, cloud creates default to the
 * hub (so the box keeps running with the laptop off); docker always stays local,
 * as does a remote-docker engine the control box has not been given access to,
 * and `--local` / `cloud.viaHub=false` force local.
 *
 * An explicit `--via-hub` returns `hub` unconditionally — the caller
 * (`runCreateViaHub`) validates the prerequisites and hard-fails on a missing
 * one, matching the pre-existing flag behavior. The DEFAULT path instead falls
 * back to a local build (never fails) when the two things the hub worker needs —
 * a git `origin` to clone and a control-box admin token — aren't present.
 */
export async function resolveCreateRouting(input: CreateRoutingInput): Promise<CreateRouting> {
  const { providerName, remoteHost, effective, projectRoot, forceHub, forceLocal, urlFlag } = input;
  if (forceLocal) return { where: 'local' };
  if (forceHub) return { where: 'hub' };
  // Cheap, local answers first: the engine check below can cost a round-trip to
  // the control box, and there is no point paying it when no hub is in play.
  if (!remoteHubConfigured(effective)) return { where: 'local' };
  if (!effective.cloud.viaHub) return { where: 'local' };
  if (!(await hubCanRunEngine(providerName, remoteHost, effective))) {
    return providerName === 'remote-docker'
      ? { where: 'local', fellBackReason: unsharedHostReason(remoteHost) }
      : { where: 'local' };
  }

  const origin = await readGitOriginUrl(projectRoot).catch(() => undefined);
  if (!origin)
    return {
      where: 'local',
      fellBackReason: 'no git `origin` remote for the hub worker to clone',
    };
  const target = await resolveCustodyTarget(urlFlag, { quiet: true });
  if (!target)
    return {
      where: 'local',
      fellBackReason: 'no control-box admin token (run `agentbox hub setup`)',
    };
  return { where: 'hub' };
}
