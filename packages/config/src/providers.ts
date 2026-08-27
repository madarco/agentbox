/**
 * Single source of truth for the set of sandbox providers.
 *
 * Adding one row to `PROVIDERS` is the *only* place a new provider's identity
 * has to be registered. This table drives, by derivation:
 *   - the `ProviderKind` union (below),
 *   - the `box.provider` enum + its description (see `types.ts`),
 *   - the per-provider `box.image<P>` / `box.size<P>` / `box.defaultCheckpoint<P>`
 *     entries in `KEY_REGISTRY` (generated in `types.ts`),
 *   - the CLI's known/cloud provider lists, the install-wizard picker
 *     labels/hints, the wizard's rebuild-time estimate, and the doctor groups.
 *
 * The interface fields on `UserConfig`/`EffectiveConfig` and the JSON schema
 * still list the per-provider keys explicitly (static types can't be generated
 * from a runtime array); a test (`test/providers.test.ts`) fails if either
 * drifts from this table.
 */

/** One credential a UI prompts for, keyed as `ProviderModule.setCredentials` expects. */
export interface ProviderCredentialField {
  /** Field key passed to `setCredentials` (e.g. `apiKey`, `token`, `teamId`). */
  readonly key: string;
  readonly label: string;
  readonly optional?: boolean;
  /**
   * Mask in UIs and never echo back. Defaults to true when omitted — a field is
   * a secret unless it says otherwise. DigitalOcean's `project` is the exception:
   * it lands in the `box.digitaloceanProject` config key, not `secrets.env`.
   */
  readonly secret?: boolean;
  readonly hint?: string;
}

/**
 * What a provider can do. Every flag is DECLARED, not inferred from method
 * presence: `createCloudProvider` defines `setInbound`/`repairReachability`/
 * `enableDirectGit`/`checkpoint` on every cloud provider (delegating to an
 * optional backend method at call time), so `Provider` method presence says
 * which scaffold was used, not what the provider supports. Docker is the sharp
 * case — it has no `provider.checkpoint` at all, yet `docker commit` checkpoints
 * are the oldest feature in the repo.
 *
 * `CloudBackend` methods, being written by the provider author, ARE honest —
 * `prune`, `inbound` and `timeoutModel` below must agree with `backend.list`,
 * `backend.setInbound` and `backend.timeoutModel`, and a test asserts it.
 */
export interface ProviderCapabilities {
  /** Checkpoint capture/restore is supported at all. */
  readonly checkpoints: boolean;
  /** Capturing a checkpoint stops and reboots the box (the capture prompt). */
  readonly checkpointReboots: boolean;
  /** Real SSH into the box: `agentbox code` (IDE) and `agentbox open` (sshfs mount). */
  readonly ssh: boolean;
  /**
   * The per-box SSH identity outlives the CLI call, so an app that connects on
   * its own later works (`open --in claude|codex`). An expiring token gateway
   * (daytona) does not qualify.
   */
  readonly persistentSsh: boolean;
  /**
   * `buildAttach` yields a plain `ssh … user@host` pointing AT the box — the only
   * shape `resolveCloudSshTarget` can parse a target out of. A provider with its
   * own `sshTarget` needs this false.
   */
  readonly directBoxSsh: boolean;
  /** Per-box inbound firewall policy (`--inbound`). Must match `!!backend.setInbound`. */
  readonly inbound: boolean;
  /** `git.pushMode=direct` can be switched on post-create (`--with-credentials`). */
  readonly directGit: boolean;
  /** Host-to-box workspace resync. */
  readonly resync: boolean;
  /** Orphan sandboxes are enumerable + deletable. Must match `!!backend.list`. */
  readonly prune: boolean;
  readonly vnc: boolean;
  /** Nested containers (in-box dockerd) work. */
  readonly dind: boolean;
  /**
   * What `pause` actually does. 'freeze' preserves the running process tree
   * (docker pause, daytona linux-vm, vercel/e2b snapshot-resume); 'stop' powers
   * the box off so only the disk survives (hetzner and digitalocean are both
   * literally `pause ≡ stop`).
   *
   * NOT a gate on offering a pause control — powering a VPS down is useful, it
   * stops billing. A UI should relabel on 'stop', never hide.
   */
  readonly pauseSemantics: 'freeze' | 'stop';
  /** Creates can be handed to a remote control box (`cloud.viaHub`). */
  readonly hubRoutable: boolean;
  /** Session-lifetime model. Must match `backend.timeoutModel`. */
  readonly timeoutModel?: 'absolute' | 'inactivity';
}

/**
 * Everything a UI or CLI can know about a provider WITHOUT loading its module.
 *
 * Built-ins declare this in the `PROVIDERS` table below. External plugins
 * declare the same shape on `ProviderModule.descriptor`, which `agentbox plugin
 * add` snapshots into `~/.agentbox/plugins.json` — so every consumer resolves a
 * descriptor synchronously and offline, whichever kind of provider it is.
 */
export interface ProviderDescriptor {
  /** Canonical name — MUST equal the `@agentbox/sandbox-<name>` package suffix. */
  readonly name: string;
  /** 'local' = docker; 'cloud' = has a CloudBackend + a prepared base snapshot. */
  readonly kind: 'local' | 'cloud';
  /** Human label for the install-wizard picker. */
  readonly label: string;
  /** One-line hint for the install-wizard picker. */
  readonly loginHint: string;
  readonly credentials: {
    /**
     * `secrets.env` key names whose presence means "credentials configured".
     * Only the NAME is ever read, never the value. Empty = none needed.
     */
    readonly envKeys: readonly string[];
    /** Fields a credential form prompts for. Empty = none needed. */
    readonly fields: readonly ProviderCredentialField[];
  };
  readonly bake: {
    /**
     * Whether a base image/snapshot must exist before the provider is usable.
     * False for docker (its base self-heals on create) and remote-docker (the
     * image builds lazily on first create). Note this is NOT `!!provider.prepare`
     * — all seven built-ins have a `prepare`.
     */
    readonly required: boolean;
    /** Rough bake time in minutes, shown by the install wizard. */
    readonly approxMinutes: string;
    /** Typical streamed create-log line count, for client progress pacing. */
    readonly createProgressSteps?: number;
    /** Typical streamed bake-log line count. Bakes are far more verbose. */
    readonly bakeProgressSteps?: number;
  };
  readonly capabilities: ProviderCapabilities;
  /** Known VM sizes. Absent = free-form string the backend interprets. */
  readonly sizes?: readonly { readonly key: string; readonly label: string }[];
  /** Known regions/datacenters. Absent = the provider has no region choice. */
  readonly regions?: readonly { readonly key: string; readonly label: string }[];
  /** Fragment describing this backend, joined into the `box.provider` enum description. */
  readonly blurb: string;
  /** Description of the per-provider `box.size<P>` KEY_REGISTRY entry. */
  readonly sizeDesc: string;
  /** Description of the per-provider `box.image<P>` KEY_REGISTRY entry. */
  readonly imageDesc: string;
}

export const PROVIDERS = [
  {
    name: 'docker',
    kind: 'local',
    label: 'Docker (local)',
    loginHint: 'builds a ~1GB local image; no login needed',
    credentials: { envKeys: [], fields: [] },
    // The base self-heals: `ensureImage` pulls or builds on create, so a missing
    // base is a slow first create, never a blocked one.
    bake: { required: false, approxMinutes: '1', createProgressSteps: 52, bakeProgressSteps: 420 },
    capabilities: {
      // `docker commit` — the oldest checkpoint implementation in the repo. It
      // does NOT hang off `provider.checkpoint` (see the interface doc).
      checkpoints: true,
      checkpointReboots: false,
      ssh: true,
      persistentSsh: true,
      // Its localhost sshd is reached by published port, not a direct `ssh
      // user@host` attach argv.
      directBoxSsh: false,
      inbound: false,
      directGit: false,
      resync: true,
      prune: false,
      vnc: true,
      dind: true,
      pauseSemantics: 'freeze',
      // Local engine — there is no hub to route a create to.
      hubRoutable: false,
    },
    blurb: 'local Docker containers',
    sizeDesc:
      'Per-provider override of `box.size` for docker. Reserved — docker sizing is controlled via `box.memory` / `box.cpus` / `box.disk`.',
    imageDesc:
      'Per-provider override of `box.image` for docker (local docker image ref, e.g. `agentbox/box:dev`). Wins over the generic when set.',
  },
  {
    name: 'daytona',
    kind: 'cloud',
    label: 'Daytona (cloud sandbox)',
    loginHint: 'paste an API key from the Daytona dashboard',
    credentials: {
      envKeys: ['DAYTONA_API_KEY', 'DAYTONA_JWT_TOKEN'],
      fields: [{ key: 'apiKey', label: 'API key' }],
    },
    bake: {
      required: true,
      approxMinutes: '7',
      createProgressSteps: 1900,
      bakeProgressSteps: 1500,
    },
    capabilities: {
      checkpoints: true,
      // `sb._experimental_createSnapshot` stops the sandbox to capture it.
      checkpointReboots: true,
      ssh: true,
      // The SSH gateway is reached with an expiring token, so an app that dials
      // in on its own later (codex) finds a dead credential.
      persistentSsh: false,
      directBoxSsh: true,
      inbound: false,
      directGit: true,
      resync: true,
      prune: true,
      vnc: true,
      dind: true,
      // linux-vm `pause()` freezes CPU + memory. The `container` class has no
      // pause primitive and archives instead (filesystem only) — see backend.ts.
      pauseSemantics: 'freeze',
      hubRoutable: true,
      timeoutModel: 'inactivity',
    },
    blurb: 'Daytona Cloud sandboxes',
    sizeDesc:
      'Per-provider override of `box.size` for daytona. `cpu-memory-disk` GB spec (e.g. `4-8-20`). Only honored on the image/Dockerfile create path; on the snapshot path the size is fixed at bake time (Daytona rejects custom resources on snapshot-resume).',
    imageDesc:
      'Per-provider override of `box.image` for daytona (named snapshot, e.g. `agentbox-base-<fingerprint>`). Written by `agentbox prepare --provider daytona`.',
  },
  {
    name: 'hetzner',
    kind: 'cloud',
    label: 'Hetzner (cloud VPS)',
    loginHint: 'paste an API token from the Hetzner Console',
    credentials: {
      envKeys: ['HCLOUD_TOKEN'],
      fields: [{ key: 'token', label: 'API token' }],
    },
    bake: {
      required: true,
      approxMinutes: '7-10',
      createProgressSteps: 41,
      bakeProgressSteps: 900,
    },
    capabilities: {
      checkpoints: true,
      // `create_image` defaults to no-pause, matching `docker commit`.
      checkpointReboots: false,
      ssh: true,
      persistentSsh: true,
      directBoxSsh: true,
      inbound: true,
      directGit: true,
      resync: true,
      prune: true,
      vnc: true,
      dind: true,
      // "Hetzner has no archive primitive. Pause ≡ stop." (backend.ts)
      pauseSemantics: 'stop',
      hubRoutable: true,
    },
    blurb: 'Hetzner Cloud VPSes',
    sizeDesc:
      'Per-provider override of `box.size` for hetzner. Server type string (e.g. `cx23`, `cx33`, `cx43`).',
    imageDesc:
      'Per-provider override of `box.image` for hetzner (image description, e.g. `agentbox-base-<fingerprint>`). Written by `agentbox prepare --provider hetzner`.',
  },
  {
    name: 'vercel',
    kind: 'cloud',
    label: 'Vercel (cloud microVM)',
    loginHint: 'installs the Vercel sandbox CLI, then a browser sign-in',
    credentials: {
      envKeys: ['VERCEL_TOKEN', 'VERCEL_OIDC_TOKEN', 'VERCEL_AUTH_SOURCE'],
      fields: [
        { key: 'token', label: 'Access token' },
        { key: 'teamId', label: 'Team ID', optional: true },
        { key: 'projectId', label: 'Project ID', optional: true },
      ],
    },
    bake: {
      required: true,
      approxMinutes: '5-10',
      createProgressSteps: 33,
      bakeProgressSteps: 400,
    },
    capabilities: {
      checkpoints: true,
      // `sb.snapshot()` stops the box; the live agent process doesn't survive.
      checkpointReboots: true,
      // No SSH at all — attach is a custom tmux bridge over the SDK.
      ssh: false,
      persistentSsh: false,
      directBoxSsh: false,
      inbound: false,
      directGit: true,
      resync: true,
      prune: true,
      vnc: true,
      // Nested containers verified working 2026-06-30 (`launchDockerd: true`).
      dind: true,
      pauseSemantics: 'freeze',
      hubRoutable: true,
    },
    blurb: 'Vercel Sandboxes',
    sizeDesc:
      'Per-provider override of `box.size` for vercel. vCPU count — one of `1`, `2`, `4`, `8` (Vercel couples RAM at 2048 MB/vCPU). Default 2.',
    imageDesc:
      'Per-provider override of `box.image` for vercel (snapshot id, e.g. `snap_…`). Written by `agentbox prepare --provider vercel`.',
  },
  {
    name: 'e2b',
    kind: 'cloud',
    label: 'E2B (cloud microVM)',
    loginHint: 'paste an API key from the E2B dashboard',
    credentials: {
      envKeys: ['E2B_API_KEY'],
      fields: [{ key: 'apiKey', label: 'API key' }],
    },
    bake: { required: true, approxMinutes: '2', createProgressSteps: 34, bakeProgressSteps: 500 },
    capabilities: {
      checkpoints: true,
      checkpointReboots: false,
      // No SSH — attach is an SDK-streaming PTY bridge.
      ssh: false,
      persistentSsh: false,
      directBoxSsh: false,
      inbound: false,
      directGit: true,
      resync: true,
      prune: true,
      vnc: true,
      // Full root + cap_sys_admin, verified 2026-06-23.
      dind: true,
      pauseSemantics: 'freeze',
      hubRoutable: true,
      timeoutModel: 'inactivity',
    },
    blurb: 'E2B microVMs',
    sizeDesc:
      'Per-provider override of `box.size` for e2b. `cpu-memory` GB spec (e.g. `4-8`). Template-level: baked by `agentbox prepare --provider e2b --size <spec>`; E2B rejects per-create resources.',
    imageDesc:
      'Per-provider override of `box.image` for e2b (template id or `name:tag`, e.g. `agentbox-base:latest`). Written by `agentbox prepare --provider e2b`.',
  },
  {
    name: 'digitalocean',
    kind: 'cloud',
    label: 'DigitalOcean (cloud VPS)',
    loginHint: 'paste a Personal Access Token from the DigitalOcean Console',
    credentials: {
      envKeys: ['DIGITALOCEAN_TOKEN'],
      fields: [
        { key: 'token', label: 'API token' },
        // Not a secret: the host writes it to `box.digitaloceanProject`. Blank
        // means "leave unchanged", never "clear" — clearing is a `config unset`.
        {
          key: 'project',
          label: 'Project',
          optional: true,
          secret: false,
          hint: 'blank leaves it unchanged',
        },
      ],
    },
    bake: {
      required: true,
      approxMinutes: '7-10',
      createProgressSteps: 41,
      bakeProgressSteps: 900,
    },
    capabilities: {
      checkpoints: true,
      checkpointReboots: false,
      // A VPS with a real sshd, same shape as hetzner. The pre-descriptor
      // `IDE_PROVIDERS` / `SSH_MOUNT_PROVIDERS` arrays omitted digitalocean while
      // listing it in `PROVIDERS_WITH_DIRECT_BOX_SSH` — an oversight, not a
      // limitation, so `agentbox code` / `open` start working here.
      ssh: true,
      persistentSsh: true,
      directBoxSsh: true,
      inbound: true,
      directGit: true,
      resync: true,
      prune: true,
      vnc: true,
      dind: true,
      // "DigitalOcean has no archive primitive. Pause ≡ stop (power off)."
      pauseSemantics: 'stop',
      hubRoutable: true,
    },
    blurb: 'DigitalOcean Droplets',
    sizeDesc:
      'Per-provider override of `box.size` for digitalocean. Droplet size slug (e.g. `s-2vcpu-4gb`, `s-4vcpu-8gb`).',
    imageDesc:
      'Per-provider override of `box.image` for digitalocean (numeric snapshot id). Written by `agentbox prepare --provider digitalocean`.',
  },
  {
    name: 'remote-docker',
    kind: 'cloud',
    label: 'Remote Docker (your own machine over SSH)',
    // It connects as you, over your own ~/.ssh/config — there is no credential
    // to store, so there is none to check.
    loginHint: 'point it at an SSH host you can already reach (no login needed)',
    credentials: { envKeys: [], fields: [] },
    // Usable as soon as one host alias is registered: the image builds lazily on
    // first create. Readiness is the alias count, not a base marker.
    bake: { required: false, approxMinutes: '1-3' },
    capabilities: {
      checkpoints: true,
      checkpointReboots: false,
      ssh: true,
      persistentSsh: true,
      // Reached by ProxyJump through the engine, via its own `sshTarget`.
      directBoxSsh: false,
      inbound: false,
      directGit: true,
      resync: true,
      prune: true,
      vnc: true,
      dind: true,
      pauseSemantics: 'freeze',
      // Docker on YOUR OWN machine — a control box can't reach it.
      hubRoutable: false,
    },
    blurb: 'Docker on a remote machine over SSH',
    sizeDesc:
      "Per-provider override of `box.size` for remote-docker. `cpu-memory` GB spec (e.g. `4-8`) mapped to the container's `--cpus` / `--memory`. Empty = unlimited (the remote engine's defaults).",
    imageDesc:
      'Per-provider override of `box.image` for remote-docker (a docker image ref on the REMOTE engine). Normally left empty: the provider derives a fingerprint-tagged ref (`agentbox/box:<sha12>`) and ensures it on the remote itself.',
  },
] as const satisfies readonly ProviderDescriptor[];

/** Sandbox backend new boxes are created on. Derived from the `PROVIDERS` table. */
export type ProviderKind = (typeof PROVIDERS)[number]['name'];

/** All provider names, in canonical order. */
export const PROVIDER_NAMES: readonly ProviderKind[] = PROVIDERS.map((p) => p.name);

/** Cloud provider names only (everything except docker). */
export const CLOUD_PROVIDER_NAMES: readonly ProviderKind[] = PROVIDERS.filter(
  (p) => p.kind === 'cloud',
).map((p) => p.name);

/**
 * Providers whose box creates can run on a remote hub (the deployed control box):
 * the true clouds only. Excludes `docker` (local engine — no hub to route to) and
 * `remote-docker` (docker on YOUR OWN machine over SSH — the control box can't
 * reach it, and the create-via-hub path rejects it). NOT the same as
 * {@link CLOUD_PROVIDER_NAMES}, which counts `remote-docker` as cloud for the
 * git-bundle staging / SSH-sync it shares with the real clouds.
 */
export const HUB_ROUTABLE_PROVIDER_NAMES: readonly ProviderKind[] = PROVIDERS.filter(
  (p) => p.capabilities.hubRoutable,
).map((p) => p.name);

/** True when `name`'s creates can be handed to a remote control box. */
export function isHubRoutableProvider(name: string): boolean {
  return (HUB_ROUTABLE_PROVIDER_NAMES as readonly string[]).includes(name);
}

export function isProviderKind(name: string): name is ProviderKind {
  return (PROVIDER_NAMES as readonly string[]).includes(name);
}

/**
 * The BUILT-IN descriptor for `name`. Throws on an unknown name, so it is only
 * safe behind `isProviderKind`. To resolve a descriptor for any runtime provider
 * — built-in OR registered plugin — use `resolveProviderDescriptor` from
 * `@agentbox/sandbox-core`, which falls back to the plugin registry snapshot.
 */
export function providerMeta(name: ProviderKind): ProviderDescriptor {
  const m = PROVIDERS.find((p) => p.name === name);
  if (!m) throw new Error(`unknown provider: ${String(name)}`);
  return m;
}

/**
 * Capitalize a provider name for its config-key suffix: `e2b` -> `E2b`,
 * `docker` -> `Docker`, `digitalocean` -> `Digitalocean`. First char upper,
 * the rest verbatim — matches the hand-written keys this table replaced.
 *
 * A hyphenated name camelizes across the hyphen (`remote-docker` ->
 * `RemoteDocker`), because `box.imageRemote-docker` is not a legal config key.
 */
export function providerKeyCap(name: string): string {
  return name
    .split('-')
    .filter((seg) => seg.length > 0)
    .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
    .join('');
}

/** Per-provider config key, e.g. `('image','hetzner')` -> `'box.imageHetzner'`. */
export function perProviderConfigKey(
  base: 'image' | 'size' | 'defaultCheckpoint',
  provider: string,
): string {
  return `box.${base}${providerKeyCap(provider)}`;
}
