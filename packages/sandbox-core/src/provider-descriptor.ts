/**
 * Resolve a {@link ProviderDescriptor} for ANY runtime provider — built-in or
 * registered plugin — synchronously and offline.
 *
 * Built-ins declare their descriptor in `@agentbox/config`'s `PROVIDERS` table.
 * A plugin declares one on `ProviderModule.descriptor`, which `agentbox plugin
 * add` snapshots into `~/.agentbox/plugins.json`. Both are plain data by the
 * time anything asks, which is the point: the CLI's `open --targets` probe and
 * the hub's `listProviders` are hot, sync paths that must never `import()` an
 * external package to answer "does this provider support checkpoints?".
 *
 * A plugin that predates descriptors (or simply declares none) still resolves —
 * see {@link deriveDescriptor} for the fallback and why each default is what it
 * is.
 */

import { PROVIDERS, isProviderKind, providerMeta } from '@agentbox/config';
import type { ProviderCapabilities, ProviderDescriptor } from '@agentbox/config';
import type { ProviderModule } from './doctor.js';
import {
  PLUGINS_FILE,
  pluginForProvider,
  readPluginRegistrySync,
  recordPluginDescriptor,
} from './plugin-registry.js';

/**
 * The descriptor for `name`, or undefined when nothing provides it.
 *
 * Built-in table first — a plugin can never shadow a built-in (`plugin add`
 * rejects that), so the order is a formality that also keeps the common case
 * off the filesystem.
 */
export function resolveProviderDescriptor(
  name: string,
  path: string = PLUGINS_FILE,
): ProviderDescriptor | undefined {
  if (isProviderKind(name)) return providerMeta(name);
  return pluginForProvider(name, path)?.descriptors?.[name];
}

/** Every resolvable descriptor: built-ins in canonical order, then plugins. */
export function listProviderDescriptors(path: string = PLUGINS_FILE): ProviderDescriptor[] {
  // PROVIDERS is already in canonical order (docker first).
  const builtIns: ProviderDescriptor[] = [...PROVIDERS];
  const plugins: ProviderDescriptor[] = [];
  for (const rec of readPluginRegistrySync(path).plugins) {
    for (const providerName of rec.providers) {
      const d = rec.descriptors?.[providerName];
      // A plugin with no snapshot yet is still a real, creatable provider — list
      // it on a placeholder rather than hiding it until something back-fills.
      plugins.push(d ?? placeholderDescriptor(providerName));
    }
  }
  return [...builtIns, ...plugins];
}

/**
 * Defaults for a provider we know exists but have no descriptor for. Every value
 * is chosen to reproduce what AgentBox did for a plugin BEFORE descriptors — a
 * "safe = false" default would silently delete working UI (see `vnc`/`dind`/
 * `pauseSemantics`).
 */
const FALLBACK_CAPABILITIES: ProviderCapabilities = {
  // Cloud plugins are near-universally built on `createCloudProvider`, which
  // gives them a working `checkpoint`. `deriveDescriptor` refines this from the
  // real module when one is available.
  checkpoints: false,
  checkpointReboots: false,
  ssh: false,
  // Plugins were excluded from PERSISTENT_SSH_PROVIDERS / the direct-ssh list,
  // so false IS the status quo — a plugin opts in by declaring a descriptor.
  persistentSsh: false,
  directBoxSsh: false,
  inbound: false,
  directGit: false,
  resync: true,
  prune: false,
  // TRUE on purpose: `createCloudProvider` wires VNC unconditionally and
  // degrades best-effort, and `launchDockerd` defaults true. Defaulting these
  // false would remove a VNC button / DinD that works today.
  vnc: true,
  dind: true,
  // The pre-descriptor UI showed an unqualified Pause for every running box.
  pauseSemantics: 'freeze',
  hubRoutable: true,
};

function placeholderDescriptor(name: string): ProviderDescriptor {
  return {
    name,
    kind: 'cloud',
    label: name,
    loginHint: '',
    credentials: { envKeys: [], fields: [] },
    // NOT `true`: the hub's create gate deliberately skips the configured check
    // for plugins, so demanding a bake here would newly block creates that work.
    bake: { required: false, approxMinutes: '1' },
    capabilities: { ...FALLBACK_CAPABILITIES },
    blurb: `the ${name} provider`,
    sizeDesc: `Per-provider override of \`box.size\` for ${name}.`,
    imageDesc: `Per-provider override of \`box.image\` for ${name}.`,
  };
}

/**
 * Build a descriptor for a LOADED plugin module: what it declares, else what can
 * be honestly derived from it, else the fallback defaults.
 *
 * Derivation reads `CloudBackend` methods, never `Provider` ones. Provider
 * methods are supplied by `createCloudProvider` for every cloud provider
 * (`setInbound`, `repairReachability`, `enableDirectGit`, `checkpoint`), so their
 * presence says which scaffold was used, not what the provider supports. Backend
 * methods are written by the provider author, so they mean something.
 *
 * `provider.checkpoint` and `provider.sshTarget` are the two exceptions worth
 * reading: unlike the built-in table (where docker has working checkpoints and no
 * `provider.checkpoint`), a plugin that has the scaffold-supplied `checkpoint`
 * really does get working checkpoints from it.
 */
export function deriveDescriptor(name: string, mod: ProviderModule): ProviderDescriptor {
  const declared = mod.descriptor;
  if (declared) return declared;
  const base = placeholderDescriptor(name);
  const { provider, backend } = mod;
  return {
    ...base,
    kind: backend ? 'cloud' : 'local',
    credentials: {
      envKeys: [],
      // Only offer a credential form when the module can actually consume one.
      fields: mod.setCredentials ? [{ key: 'apiKey', label: 'API key' }] : [],
    },
    capabilities: {
      ...base.capabilities,
      checkpoints: !!provider.checkpoint,
      ssh: !!provider.sshTarget,
      resync: !!provider.resyncWorkspace,
      prune: !!backend?.list,
      inbound: !!backend?.setInbound,
      ...(backend?.timeoutModel ? { timeoutModel: backend.timeoutModel } : {}),
    },
  };
}

/**
 * Resolve `name`'s descriptor, deriving and back-filling the registry snapshot
 * when the plugin has none. Call this from paths that are loading the module
 * anyway; everything else should use the sync {@link resolveProviderDescriptor}.
 *
 * The write is best-effort: a lost snapshot only costs the next caller another
 * derivation, so a read-only HOME or a concurrent writer must not fail a create.
 */
export async function ensureProviderDescriptor(
  name: string,
  mod: ProviderModule,
  path: string = PLUGINS_FILE,
): Promise<ProviderDescriptor> {
  const existing = resolveProviderDescriptor(name, path);
  if (existing) return existing;
  const derived = deriveDescriptor(name, mod);
  await recordPluginDescriptor(name, derived, path).catch(() => {});
  return derived;
}
