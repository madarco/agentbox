/**
 * Decide WHICH HUB a create goes to, and what to send it — the create-side of the
 * plan's "the choice is which hub, not hub-vs-inline" rule (replaces the old
 * `route-create.ts`). Every create now goes through `POST /api/v1/boxes`; this
 * only picks the target and the request shape:
 *
 *   - **local** — a co-located hub builds from the local workspace (file queue).
 *     Send `projectId`; no seed push (the worker reads the local tree directly).
 *     docker / an unshared remote-docker engine / no control box /
 *     `cloud.viaHub=false` / `--local`.
 *   - **remote** — a control box clones the repo VPS-side (control-plane queue).
 *     Send `repoUrl`; **push the project seed first** so `.env`/untracked files a
 *     fresh clone can't provide reach the box. cloud + control box + `cloud.viaHub`
 *     (or `--via-hub`).
 *
 * `--via-hub` forces remote and hard-fails (returns `error`) on a missing
 * prerequisite, matching the old flag. The DEFAULT path falls back to local (with
 * a surfaced reason) rather than failing.
 */
import type { EffectiveConfig } from '@agentbox/config';
import { DEFAULT_ENV_PATTERNS, projectSlugFromOriginUrl } from '@agentbox/sandbox-core';
import {
  adminCustodySink,
  CarrySeedError,
  isCarrySeedError,
  pushProjectSeedToCustody,
  readGitOriginUrl,
  type CarrySeedSource,
} from '@agentbox/sandbox-cloud';
import { hubCanRunEngine, unsharedHostReason } from './remote-docker-share.js';
import { remoteHubConfigured } from './remote-hub.js';

export interface CreateTargetInput {
  /** Bare provider name (post `parseProviderSpec`). */
  providerName: string;
  /** remote-docker only: the engine alias the spec named. */
  remoteHost?: string;
  effective: EffectiveConfig;
  /** Absolute project root — the repo whose `origin` the control box clones. */
  projectRoot: string;
  /** `--via-hub`: force the control box (hard-fail on a missing prereq). */
  forceHub?: boolean;
  /** `--local`: force a local build even when a control box is configured. */
  forceLocal?: boolean;
  /** `--url` override for the control box. */
  urlFlag?: string;
}

export type CreateTarget =
  | { where: 'local'; fellBackReason?: string }
  | { where: 'remote'; repoUrl: string; custody: { url: string; adminToken: string } }
  /** `--via-hub` with a prerequisite missing — the caller aborts with this message. */
  | { where: 'error'; message: string };

export async function resolveCreateTarget(input: CreateTargetInput): Promise<CreateTarget> {
  const { providerName, remoteHost, effective, projectRoot, forceHub, forceLocal, urlFlag } = input;
  if (forceLocal) return { where: 'local' };

  // A bare docker box bind-mounts this machine's checkout, so it can only ever be
  // built here. A remote-docker box can go either way: the control box can build
  // it iff that engine has been SHARED with it (`agentbox remote-docker share`),
  // since otherwise the alias resolves only through the user's own ssh config.
  if (!(await hubCanRunEngine(providerName, remoteHost, effective))) {
    if (forceHub) {
      const msg =
        providerName === 'remote-docker'
          ? `--via-hub cannot run this remote-docker box: the control box has no \`${remoteHost ?? '<host>'}\` engine registered. Share it with \`agentbox remote-docker share ${remoteHost ?? '<alias>'}\`, or run \`agentbox docker:${remoteHost ?? '<host>'} …\` from this machine.`
          : '--via-hub needs a cloud provider (a docker box runs on this machine). Try --provider hetzner|e2b|vercel|daytona.';
      return { where: 'error', message: msg };
    }
    return providerName === 'remote-docker' && remoteHubConfigured(effective)
      ? { where: 'local', fellBackReason: unsharedHostReason(remoteHost) }
      : { where: 'local' };
  }

  if (!forceHub) {
    if (!remoteHubConfigured(effective)) return { where: 'local' };
    if (!effective.cloud.viaHub) return { where: 'local' };
  }

  // Remote is wanted (default-for-cloud or forced). Gather the two things the
  // control-box worker needs: a git origin to clone, and an admin token.
  const repoUrl = await readGitOriginUrl(projectRoot).catch(() => undefined);
  if (!repoUrl) {
    if (forceHub) {
      return {
        where: 'error',
        message:
          '--via-hub needs a git `origin` remote (the control box clones it VPS-side). None found in this project.',
      };
    }
    return {
      where: 'local',
      fellBackReason: 'no git `origin` remote for the control box to clone',
    };
  }
  // Lazy import: control-plane.ts ⇄ hub.ts sit in a module cycle, so keep this
  // edge lazy (Step 0's note) — a load-time import reads `resolveCustodyTarget`
  // as undefined.
  const { resolveCustodyTarget } = await import('../commands/control-plane.js');
  const custody = await resolveCustodyTarget(urlFlag, { quiet: !forceHub });
  if (!custody) {
    if (forceHub) {
      return {
        where: 'error',
        message: 'no control-box admin token (run `agentbox hub setup`)',
      };
    }
    return {
      where: 'local',
      fellBackReason: 'no control-box admin token (run `agentbox hub setup`)',
    };
  }
  return { where: 'remote', repoUrl, custody };
}

/**
 * Push a project's seed material (untracked files + env/secrets) to the control
 * box's custody before a remote create, so the clone-side worker can overlay what
 * a fresh `git clone` can't provide (`.env`, gitignored config, untracked files).
 * Hash-skipped, so an unchanged tree costs nothing. Best-effort for seed material
 * — a failed untracked/env push must never fail the create (the box still comes
 * up, just without the overlay) — but NOT for approved `carry:` entries, which
 * throw: a box missing files the user was shown and said yes to is worse than no
 * box. The slug matches what the worker reads (`projectSlugFromOriginUrl`).
 */
export async function pushCreateSeed(args: {
  custody: { url: string; adminToken: string };
  repoUrl: string;
  projectRoot: string;
  maxBodyBytes?: number;
  /**
   * Approved `carry:` entries for this create. A hub-built box gets these from
   * custody; without them it silently comes up missing files the user was shown
   * and said yes to — and, because the untracked tar excludes ignored paths by
   * design, `carry:` is the ONLY way a gitignored file ever reaches one.
   */
  carry?: CarrySeedSource[];
  onLog: (line: string) => void;
}): Promise<void> {
  const slug = projectSlugFromOriginUrl(args.repoUrl);
  if (!slug) {
    args.onLog(
      'seed: could not derive a project slug from the origin URL — skipping the seed push',
    );
    return;
  }
  try {
    const res = await pushProjectSeedToCustody({
      // The create/registration path writes over the internal /admin/custody wire
      // (it holds the admin token) — mirrors cloud-provider.ts. The CLI's client
      // custody commands use the /api/v1 sink instead (Step 10).
      sink: adminCustodySink({
        controlPlaneUrl: args.custody.url,
        adminToken: args.custody.adminToken,
      }),
      probeUrl: args.custody.url,
      slug,
      projectRoot: args.projectRoot,
      envPatterns: DEFAULT_ENV_PATTERNS,
      maxBodyBytes: args.maxBodyBytes,
      ...(args.carry?.length ? { carry: args.carry } : {}),
      log: args.onLog,
    });
    if (res.unreachable) {
      // Approved `carry:` entries make this fatal. "The box may come up without
      // your untracked files" is an acceptable degradation; "the box came up
      // without the files you were shown and said yes to" is not.
      if (args.carry?.length) {
        throw new CarrySeedError(
          `carry: the control box is unreachable, so the ${String(args.carry.length)} approved ` +
            'entry/entries could not be stored for it. Not creating a box without them.',
        );
      }
      args.onLog(
        'seed: control box unreachable — the box may come up without untracked/.env files',
      );
    }
  } catch (err) {
    // Seed material is best-effort; carry is not. This catch is why the throw
    // inside pushProjectSeedToCustody was not enough on its own — it used to
    // turn every failure, including an approved carry, back into a log line.
    if (isCarrySeedError(err)) throw err;
    args.onLog(
      `seed: push failed (continuing without it): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
