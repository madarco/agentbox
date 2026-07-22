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

export interface ProviderMeta {
  /** Canonical name — MUST equal the `@agentbox/sandbox-<name>` package suffix. */
  readonly name: string;
  /** 'local' = docker; 'cloud' = has a CloudBackend + a prepared base snapshot. */
  readonly kind: 'local' | 'cloud';
  /** Human label for the install-wizard picker. */
  readonly label: string;
  /** One-line hint for the install-wizard picker. */
  readonly loginHint: string;
  /** Rough base-image/snapshot bake time (minutes) shown by the install wizard. */
  readonly rebuildMinutes: string;
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
    rebuildMinutes: '1',
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
    rebuildMinutes: '7',
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
    rebuildMinutes: '7-10',
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
    rebuildMinutes: '5-10',
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
    rebuildMinutes: '2',
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
    rebuildMinutes: '7-10',
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
    loginHint: 'point it at an SSH host you can already reach (no login needed)',
    rebuildMinutes: '1-3',
    blurb: 'Docker on a remote machine over SSH',
    sizeDesc:
      'Per-provider override of `box.size` for remote-docker. `cpu-memory` GB spec (e.g. `4-8`) mapped to the container\'s `--cpus` / `--memory`. Empty = unlimited (the remote engine\'s defaults).',
    imageDesc:
      'Per-provider override of `box.image` for remote-docker (a docker image ref on the REMOTE engine). Normally left empty: the provider derives a fingerprint-tagged ref (`agentbox/box:<sha12>`) and ensures it on the remote itself.',
  },
  {
    name: 'tenki',
    kind: 'cloud',
    label: 'Tenki (cloud microVM)',
    loginHint: 'paste an auth token from the Tenki dashboard',
    rebuildMinutes: '5-10',
    blurb: 'Tenki sandboxes',
    sizeDesc:
      'Per-provider override of `box.size` for tenki. A `cpu-memory` or `cpu-memory-disk` GB spec (e.g. `4-8` or `4-8-20`), applied at create (Tenki `createAndWait` cpuCores / memoryMb / diskSizeGb).',
    imageDesc:
      'Per-provider override of `box.image` for tenki (a Tenki workspace registry ref, e.g. `<workspace>/agentbox-box:latest`). Written by `agentbox prepare --provider tenki`.',
  },
] as const satisfies readonly ProviderMeta[];

/** Sandbox backend new boxes are created on. Derived from the `PROVIDERS` table. */
export type ProviderKind = (typeof PROVIDERS)[number]['name'];

/** All provider names, in canonical order. */
export const PROVIDER_NAMES: readonly ProviderKind[] = PROVIDERS.map((p) => p.name);

/** Cloud provider names only (everything except docker). */
export const CLOUD_PROVIDER_NAMES: readonly ProviderKind[] = PROVIDERS.filter(
  (p) => p.kind === 'cloud',
).map((p) => p.name);

export function isProviderKind(name: string): name is ProviderKind {
  return (PROVIDER_NAMES as readonly string[]).includes(name);
}

export function providerMeta(name: ProviderKind): ProviderMeta {
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
