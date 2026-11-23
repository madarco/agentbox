/**
 * What a clone inherits from its source box — `POST /api/v1/boxes/:id/clone`.
 *
 * Every field of the source's record is classified in {@link CLONE_RECORD_POLICY}
 * (and the cloud half in {@link CLONE_CLOUD_POLICY}); both are
 * `satisfies Record<keyof …>`, so a new record field fails `tsc` until someone
 * decides what a clone does with it. That is the point: `prepareClone` used to copy
 * fields one by one, and the skills selection and the LLM egress proxy were added
 * to the record without anyone wiring them, so a clone of a `--no-skills` box got
 * the whole library and a clone of a proxied box egressed direct.
 *
 * The rule: a clone is the same KIND of box (same skills, same egress, same
 * size and limits) with a FRESH identity (no config volumes, credentials, ports,
 * branches or checkpoint), and never more permissive than its source.
 *
 * Pure and import-free at runtime (types only), like `clone-create.ts`.
 */
import type { BoxRecord, CloudBoxFields } from '@agentbox/core';
import type { CreateBoxOpts } from './backend-types';

/**
 * `carry`: becomes a create option for the clone. `drop`: deliberately not
 * inherited (the comment says why). `n/a`: identity or runtime state of THIS box
 * (ids, ports, tokens, volumes, timestamps) — meaningless on another box.
 */
export type ClonePolicy = 'carry' | 'drop' | 'n/a';

export const CLONE_RECORD_POLICY = {
  id: 'n/a',
  name: 'n/a', // the clone's name is the caller's or `<name>-clone`
  displayName: 'n/a',
  provider: 'n/a', // resolved by prepareClone (the caller may change it)
  container: 'n/a',
  // A clone is built fresh from the exported workspace, not from the source's
  // image or checkpoint.
  image: 'drop',
  workspacePath: 'n/a', // the clone's workspace is the export dir
  snapshotDir: 'n/a',
  socketPath: 'n/a',
  // Fresh identity: the agent onboards from scratch, so no config volume.
  claudeConfigVolume: 'drop',
  codexConfigVolume: 'drop',
  agentsConfigVolume: 'drop',
  opencodeConfigVolume: 'drop',
  agentConfigVolumes: 'drop',
  vscodeServerVolume: 'n/a',
  cursorServerVolume: 'n/a',
  relayToken: 'n/a',
  gitWorktrees: 'n/a', // the clone gets its own branch
  withPlaywright: 'carry',
  // The export honours .gitignore, so the env files it would re-copy are not
  // in the clone's project; `carry:` is re-resolved under the inherited grant.
  withEnv: 'drop',
  // Not create options: both come from the hub's config at create. A clone can
  // therefore not be made more permissive by its source (backlog: carry them
  // when they become per-box options).
  autoApproveHostActions: 'drop',
  autoApproveSafeHostActions: 'drop',
  skills: 'carry',
  persistent: 'carry', // an explicit clone input still wins (prepareClone)
  carry: 'drop', // re-resolved for the clone's own project under `carryYes`
  vncEnabled: 'carry',
  vncContainerPort: 'n/a',
  vncHostPort: 'n/a',
  vncPassword: 'n/a',
  webContainerPort: 'n/a',
  webHostPort: 'n/a',
  sshEnabled: 'n/a',
  sshContainerPort: 'n/a',
  sshHostPort: 'n/a',
  ssh: 'n/a',
  portlessAlias: 'carry', // whether the source had a Portless route at all
  portlessUrl: 'n/a',
  portlessVncAlias: 'n/a',
  portlessVncUrl: 'n/a',
  dockerVolume: 'n/a',
  dockerCacheShared: 'carry',
  projectRoot: 'n/a',
  // The source's identity at create (#457); the clone's own create stamps its own.
  originUrl: 'n/a',
  repoKey: 'n/a',
  originMachineId: 'n/a',
  originMachineLabel: 'n/a',
  originFolder: 'n/a',
  projectIndex: 'n/a',
  checkpointImage: 'drop',
  checkpointSource: 'drop',
  resourceLimits: 'carry',
  docker: 'n/a', // mirrors of the flat docker fields above
  cloud: 'carry', // see CLONE_CLOUD_POLICY
  // A TUI agent is not cloned (documented: `agentbox claude <box>` adds it);
  // a service agent is resolved by prepareClone from the box itself.
  lastAgent: 'drop',
  agents: 'drop',
  borrowedCredentials: 'carry',
  accounts: 'carry',
  llmProxy: 'carry',
  createdAt: 'n/a',
  // The source's repo identity and origin-machine stamp: the clone is its own
  // project (the exported dir is registered fresh) and gets its own at create.
  originUrl: 'n/a',
  repoKey: 'n/a',
  originMachineId: 'n/a',
  originMachineLabel: 'n/a',
  originFolder: 'n/a',
} as const satisfies Record<keyof BoxRecord, ClonePolicy>;

export const CLONE_CLOUD_POLICY = {
  backend: 'n/a',
  sandboxId: 'carry', // remote-docker: the engine's ssh destination lives here
  image: 'drop',
  webPort: 'n/a',
  previewUrls: 'n/a',
  relayPreviewUrl: 'n/a',
  relayPreviewToken: 'n/a',
  bridgeToken: 'n/a',
  snapshotRef: 'drop',
  lastState: 'n/a',
  sessionTimeoutMs: 'n/a',
  sessionDeadlineEpochMs: 'n/a',
  resources: 'n/a', // what the backend reported; `size` is what was asked
  publicHost: 'n/a',
  inbound: 'carry',
  // Reaches the create on the control-plane path; the local queue has no
  // per-create class yet (backlog), so there it follows config.
  sandboxClass: 'carry',
  size: 'carry',
  location: 'carry',
  hostSeeded: 'n/a',
  workspaceBranch: 'n/a',
  sanctionedBranch: 'n/a',
  topology: 'n/a',
  controlPlaneUrl: 'n/a',
  // The hub's current push routing applies to a new box (intentional).
  gitPushMode: 'drop',
  hubGitAuth: 'drop',
} as const satisfies Record<keyof CloudBoxFields, ClonePolicy>;

/** The source fields the clone reads. */
export type CloneSource = Pick<
  BoxRecord,
  {
    [K in keyof typeof CLONE_RECORD_POLICY]: (typeof CLONE_RECORD_POLICY)[K] extends 'carry'
      ? K
      : never;
  }[keyof typeof CLONE_RECORD_POLICY]
> & { provider?: BoxRecord['provider'] };

function inboundSpec(p: NonNullable<CloudBoxFields['inbound']>): string | undefined {
  if (p.mode === 'locked' || p.mode === 'open') return p.mode;
  return p.sources.length > 0 ? `whitelist:${p.sources.join(',')}` : 'locked';
}

/**
 * The create options a clone of `src` gets on `targetProvider`. Engine-shaped
 * settings (resource limits, size, location, firewall, sandbox class, the
 * remote engine, the docker cache, Portless) carry only when the clone stays on
 * the source's provider — they mean nothing, or something else, on another.
 */
export function cloneCarryOpts(src: CloneSource, targetProvider: string): CreateBoxOpts {
  const sourceProvider = src.provider ?? 'docker';
  const same = sourceProvider === targetProvider;
  const out: CreateBoxOpts = {};

  if (src.skills) {
    out.skills = {
      ...(src.skills.none ? { none: true } : {}),
      ...(src.skills.include ? { include: [...src.skills.include] } : {}),
      ...(src.skills.exclude ? { exclude: [...src.skills.exclude] } : {}),
    };
  }
  if (src.withPlaywright !== undefined) out.withPlaywright = src.withPlaywright;
  if (src.vncEnabled !== undefined) out.vnc = src.vncEnabled;
  if (src.persistent === true) out.persistent = true;
  if (src.borrowedCredentials?.length) out.borrowCredentials = [...src.borrowedCredentials];
  if (src.accounts && Object.keys(src.accounts).length > 0) out.accounts = { ...src.accounts };

  if (!same) return out;

  // Explicit both ways, so the hub's config can neither turn a proxied box's
  // clone direct nor proxy a direct one behind the user's back. Same provider
  // only: the upstream is engine-shaped (a docker box dials host.docker.internal,
  // a cloud box needs `llm.proxyUrl`), so on another provider config decides.
  out.llmProxy = src.llmProxy ? 'forward' : 'off';

  if (src.dockerCacheShared !== undefined) out.sharedDockerCache = src.dockerCacheShared;
  if (src.portlessAlias !== undefined) out.portless = true;
  const lim = src.resourceLimits;
  if (lim?.memoryBytes) out.memory = String(lim.memoryBytes); // bare number = bytes
  if (lim?.cpus) out.cpus = String(lim.cpus);
  if (lim?.pidsLimit) out.pidsLimit = String(lim.pidsLimit);
  if (lim?.disk) out.disk = lim.disk;

  const cloud = src.cloud;
  if (cloud) {
    if (cloud.size) out.size = cloud.size;
    if (cloud.location) out.location = cloud.location;
    const inbound = cloud.inbound ? inboundSpec(cloud.inbound) : undefined;
    if (inbound) out.inbound = inbound;
    if (cloud.sandboxClass) out.providerOptions = { sandboxClass: cloud.sandboxClass };
    // `<ssh-destination>/<container>`: the clone runs on the same engine.
    if (sourceProvider === 'remote-docker') {
      const id = cloud.sandboxId ?? '';
      const slash = id.lastIndexOf('/');
      if (slash > 0) out.remoteHost = id.slice(0, slash);
    }
  }
  return out;
}
