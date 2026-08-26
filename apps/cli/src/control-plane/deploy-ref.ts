import type { HubDeploySource } from '@agentbox/sandbox-core';
import { channelOfVersion } from '../lib/channel.js';
import { AGENTBOX_VERSION } from '../version.js';

/** The repo a source-mode deploy clones when the caller names no other. */
export const DEFAULT_DEPLOY_REPO_URL = 'https://github.com/madarco/agentbox.git';

/**
 * The git ref a control-box deploy should clone, derived from the CLI running it.
 *
 * The deploy is a two-sided contract: the VPS builds `apps/hub` from the cloned
 * ref, while the HOST generates the pieces that wrap it (the Caddyfile's upstream
 * port, the `.env` keys the compose consumes, the `/root/.agentbox` bind mount).
 * Those only line up when both sides come from the same code — so the ref has to
 * follow the CLI, not a constant.
 *
 * It used to be a hardcoded `main`, which silently broke every deploy from a
 * nightly CLI: `main`'s hub listened on :3000 behind a Postgres compose while the
 * nightly CLI wrote `reverse_proxy app:8787`, so Caddy 502'd against a perfectly
 * healthy hub for the full healthz window.
 *
 * - nightly build  → the `nightly` branch (nightlies are published from it, and
 *   are not tagged, so there is no exact ref to pin).
 * - released build → its own `v<version>` tag, exactly reproducing this CLI.
 * - dev build (`0.0.0-dev`, no version injected at bundle time) → `nightly`,
 *   the branch dev builds are cut from.
 */
export function deployRefForVersion(version: string): string {
  if (channelOfVersion(version) === 'nightly') return 'nightly';
  if (version.startsWith('0.0.0')) return 'nightly';
  return `v${version}`;
}

/** The deploy ref for this process. */
export function defaultDeployRef(): string {
  return deployRefForVersion(AGENTBOX_VERSION);
}

export interface HubDeploySourceOptions {
  /** `--ref` — build from source at this ref instead of installing the package. */
  ref?: string;
  /** `--repo` — clone this repo instead of the public one. Implies source mode. */
  repoUrl?: string;
  /** `--package` — install this npm spec instead of this CLI's own version. */
  packageSpec?: string;
}

/**
 * Where a control-box deploy gets the hub from.
 *
 * The default is the published npm package pinned to this CLI's exact version:
 * `@madarco/agentbox` already ships the standalone hub the local `agentbox hub`
 * spawns, so the VPS installs in seconds instead of building 14 workspace
 * packages, and the two sides of the deploy contract (the image, and the host-
 * generated Caddyfile / `.env` around it) come from one artifact rather than
 * from a branch name that happens to match.
 *
 * Source mode is the escape hatch, and is chosen automatically for a dev build
 * whose version was never published.
 */
export function resolveHubDeploySource(
  version: string,
  opts: HubDeploySourceOptions = {},
): HubDeploySource {
  const repoUrl = opts.repoUrl ?? DEFAULT_DEPLOY_REPO_URL;
  if (opts.packageSpec) return { kind: 'package', spec: opts.packageSpec };
  if (opts.ref !== undefined || opts.repoUrl !== undefined) {
    return { kind: 'source', repoUrl, repoRef: opts.ref ?? deployRefForVersion(version) };
  }
  // A dev build has no counterpart on npm to install — fall back to building the
  // branch dev builds are cut from.
  if (version.startsWith('0.0.0')) {
    return { kind: 'source', repoUrl, repoRef: deployRefForVersion(version) };
  }
  return { kind: 'package', spec: version };
}

/** One line naming what a deploy is about to install, for the progress log. */
export function describeHubDeploySource(source: HubDeploySource): string {
  return source.kind === 'package'
    ? `npm @madarco/agentbox@${source.spec}`
    : `git ${source.repoUrl}@${source.repoRef} (built on the VPS)`;
}
