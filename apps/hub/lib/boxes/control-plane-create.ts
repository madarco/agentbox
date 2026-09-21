// Turn a hub web-UI create into a control-plane create-job request.
//
// The UI's create normally enqueues a local queue job that builds a box from a
// host working copy. A control box has none — its projects are repos, not
// folders — so those creates go to the control-plane queue instead, the one path
// that leases a push token, clones the repo and overlays the custody seed.
//
// Kept pure (no fs, no store) so the mapping is testable; the caller supplies the
// repo URL it resolved and does the enqueueing.
import {
  PORTABLE_CREATE_OPT_KEYS,
  type CreateJobRequest,
  type CreateJobRequestOpts,
} from '@agentbox/relay/control-plane';

export interface ControlPlaneCreateInput {
  provider?: string;
  agent?: string;
  name?: string;
  prompt?: string;
  fromBranch?: string;
  // Fully-processed agent argv (post-`--`, incl. skip-permissions). Carried so a
  // hub-routed `-i` run keeps the same args a local one does; the old mapping
  // silently dropped this, so e.g. --dangerously-skip-permissions stopped working.
  agentArgs?: string[];
  // Start the agent even without a seed prompt (web-UI "create a box").
  startAgent?: boolean;
  // Box-shaping create flags the CLI resolved (image/snapshot/env/...). Only the
  // cloud-relevant subset (mapped below) reaches the worker; docker/agent-only
  // knobs (carry/portless/limits/...) are inapplicable to a control-box clone.
  opts?: {
    image?: string;
    snapshot?: string;
    withPlaywright?: boolean;
    withEnv?: boolean;
    vnc?: boolean;
    persistent?: boolean;
    bundleDepth?: number;
    build?: boolean;
    credentialSync?: boolean;
    /**
     * Only ever refused here (see below). Declared so the refusal is typed
     * rather than reaching into an untyped bag.
     */
    gitPushMode?: string;
    /**
     * VM size and location for a cloud box.
     *
     * Resolved by the machine that SUBMITS, because only it has the project's
     * config: this box holds no checkout and no
     * `~/.agentbox/projects/<hash>/config.yaml`, so a size left out of the
     * request is not "the project's", it is the provider's default.
     */
    size?: string;
    location?: string;
    inbound?: string;
    useBranch?: string;
    sessionName?: string;
    imageRegistry?: string;
    providerOptions?: Record<string, string | number | boolean>;
    /**
     * `--model-auth`: which host logins the box is seeded with. Resolved on the
     * machine that HOLDS them (the CLI) and only named here, so this carries a
     * selection and never a secret.
     */
    borrowCredentials?: string[];
  };
}

/** Undefined-free pick of the portable keys; `{}` when nothing was asked for. */
function pickPortableOpts(opts: ControlPlaneCreateInput['opts']): CreateJobRequestOpts {
  const out: Record<string, unknown> = {};
  if (!opts) return out;
  for (const key of PORTABLE_CREATE_OPT_KEYS) {
    const value = (opts as Record<string, unknown>)[key];
    if (value === undefined) continue;
    // An empty borrow list says exactly what an absent field says, and the
    // worker's fallback is the same — sending it would add a field with no
    // meaning.
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

export type ControlPlaneCreateMapping =
  | {
      ok: true;
      request: CreateJobRequest;
      /**
       * Box-shaping keys the caller sent that this hub does not forward.
       *
       * Reported rather than silently swallowed: a newer CLI sending a field an
       * older hub has never heard of is invisible to any client-side check, and
       * that is precisely the failure this whole mapping keeps producing.
       * Host-local keys are not listed — the client already knows they stay
       * home, and naming them on every create would be noise.
       */
      dropped: string[];
    }
  | { ok: false; error: string };

/**
 * Keys a client legitimately sends that are NOT meant to travel: docker-only
 * knobs and decisions whose result reaches the box another way (carry bytes ride
 * the custody seed, the env files ride it too).
 */
const HOST_LOCAL_OPT_KEYS = new Set([
  'memory',
  'cpus',
  'pidsLimit',
  'disk',
  'sharedDockerCache',
  'hostSnapshot',
  'portless',
  'carry',
  'carryYes',
  'carrySkip',
  'carryAsk',
  'envFiles',
  'promptAnswers',
  'gitPushMode',
  'remoteHost',
  'resync',
  'dangerouslySkipPermissions',
]);

/**
 * A docker box bind-mounts a host folder, so it can only ever be built where that
 * folder is. On a control box there is no such folder — the request is a mistake
 * worth naming rather than a clone to attempt.
 *
 * BARE `docker` only. A `docker:<alias>` spec is remote-docker, which bind-mounts
 * nothing: it seeds the box from a git bundle over SSH exactly like the cloud
 * providers, so the clone path is precisely how it should be built here.
 */
function isDocker(provider: string): boolean {
  return provider === 'docker';
}

export function controlPlaneCreateRequest(
  input: ControlPlaneCreateInput,
  repoUrl: string,
): ControlPlaneCreateMapping {
  const provider = (input.provider ?? 'docker').trim();
  if (isDocker(provider)) {
    return {
      ok: false,
      error:
        'docker boxes need a local checkout — pick a cloud provider, or a `docker:<host>` engine this hub can reach',
    };
  }
  // Refused HERE, not only at the CLI's own gate: once `gitPushMode` travels,
  // any API client could hand a control box a `direct` create. `direct` copies a
  // git credential into the box and its snapshots, which is exactly what token
  // leasing exists to avoid — and the box lives on a machine the user does not
  // own.
  if (input.opts?.gitPushMode === 'direct') {
    return {
      ok: false,
      error:
        'git.pushMode=direct is refused for a control-box create: it copies a git credential into a box on a machine you do not own. Leave it on auto — the box leases a short-lived, repo-scoped token per push instead.',
    };
  }
  const noAgent = input.agent === 'none';
  const agent = noAgent ? undefined : (input.agent ?? 'claude');
  const branch = input.fromBranch?.trim();
  const name = input.name?.trim();
  const prompt = noAgent ? undefined : input.prompt?.trim();
  const agentArgs = noAgent ? undefined : input.agentArgs;
  // Start the agent in-box by default when there is one (the web-UI "create a
  // box" means a box with its agent running — otherwise it hands back a dead
  // session). A foreground `createCloudBoxViaHubAndAdopt` builds a COLD box
  // (startAgent:false) because the PC adopts it and the agent launches on attach.
  const startAgent = noAgent ? false : input.startAgent !== false;
  // Carry only the cloud-relevant box-shaping flags (undefined ones are omitted so
  // the worker falls back to the control box's config). Drop an all-empty object.
  // Picked BY the canonical list, never by hand: a field named in one place and
  // forgotten here is exactly how `size` reached every layer but this one and
  // silently did nothing. Undefined entries are omitted so the worker still
  // falls back to the control box's own config for anything unasked.
  const mappedOpts = pickPortableOpts(input.opts);
  const portable = new Set<string>(PORTABLE_CREATE_OPT_KEYS);
  const dropped = Object.entries(input.opts ?? {})
    .filter(([k, v]) => v !== undefined && !portable.has(k) && !HOST_LOCAL_OPT_KEYS.has(k))
    .map(([k]) => k);
  return {
    ok: true,
    dropped,
    request: {
      repoUrl,
      provider,
      ...(branch ? { branch } : {}),
      ...(name ? { name } : {}),
      ...(agent ? { agent } : {}),
      ...(prompt ? { prompt } : {}),
      // The processed agent argv (skip-permissions etc.) must survive to the
      // worker — dropping it here silently broke those flags on the hub path.
      ...(agentArgs && agentArgs.length > 0 ? { agentArgs } : {}),
      ...(startAgent ? { startAgent: true } : {}),
      ...(Object.keys(mappedOpts).length > 0 ? { opts: mappedOpts } : {}),
    },
  };
}
