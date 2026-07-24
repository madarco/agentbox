import type { EffectiveConfig } from '@agentbox/config';
import { isHubRoutableProvider } from '@agentbox/config';
import { readGitOriginUrl } from '@agentbox/sandbox-cloud';
import { resolveCustodyTarget } from '../commands/control-plane.js';
import { remoteHubConfigured } from './remote-hub.js';

export interface CreateRoutingInput {
  /** Bare provider name (e.g. `e2b`, `docker`), post `parseProviderSpec`. */
  providerName: string;
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

export type CreateRouting =
  | { where: 'hub' }
  // `fellBackReason` is set only when the hub WAS the default but a prerequisite
  // was missing — the caller surfaces it so the local build isn't silent.
  | { where: 'local'; fellBackReason?: string };

/**
 * Decide whether a cloud create runs on the remote hub (the control box) or on
 * this machine. When a control box is configured, cloud creates default to the
 * hub (so the box keeps running with the laptop off); docker / remote-docker
 * always stay local, and `--local` / `cloud.viaHub=false` force local.
 *
 * An explicit `--via-hub` returns `hub` unconditionally — the caller
 * (`runCreateViaHub`) validates the prerequisites and hard-fails on a missing
 * one, matching the pre-existing flag behavior. The DEFAULT path instead falls
 * back to a local build (never fails) when the two things the hub worker needs —
 * a git `origin` to clone and a control-box admin token — aren't present.
 */
export async function resolveCreateRouting(input: CreateRoutingInput): Promise<CreateRouting> {
  const { providerName, effective, projectRoot, forceHub, forceLocal, urlFlag } = input;
  if (forceLocal) return { where: 'local' };
  if (forceHub) return { where: 'hub' };
  if (!isHubRoutableProvider(providerName)) return { where: 'local' };
  if (!remoteHubConfigured(effective)) return { where: 'local' };
  if (!effective.cloud.viaHub) return { where: 'local' };

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
      fellBackReason: 'no control-box admin token (run `agentbox control-plane setup`)',
    };
  return { where: 'hub' };
}
