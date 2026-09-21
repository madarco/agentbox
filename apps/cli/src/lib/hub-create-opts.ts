/**
 * What a create sends to a control box, and what it cannot.
 *
 * ONE builder, because there used to be two hand-written senders with nearly
 * disjoint sets: `agentbox create --via-hub` sent ten fields, the agent commands
 * sent four, and neither sent what the other did. Every option missing from a
 * request is not "use the project's value" — the control box has no checkout and
 * no `~/.agentbox/projects/<hash>/config.yaml` for the repo — it is the
 * provider's default. That is how a project pinned to `cx33` kept getting the
 * default size.
 *
 * So the resolution happens HERE, on the machine that has the config, and the
 * options that cannot travel are named out loud instead of vanishing.
 */
import { resolveBoxImage, resolveDefaultCheckpoint, type EffectiveConfig } from '@agentbox/config';
import type { CreateJobRequestOpts } from '@agentbox/relay';
import { cloudSizingProviderOptions } from './cloud-sizing.js';

/** The flags a caller may have typed. Undefined means "not asked for". */
export interface HubCreateFlags {
  snapshot?: string;
  image?: string;
  size?: string;
  location?: string;
  inbound?: string;
  useBranch?: string;
  bundleDepth?: number;
  withPlaywright?: boolean;
  withEnv?: boolean;
  vnc?: boolean;
  build?: boolean;
  credentialSync?: boolean;
  /** Docker-only or host-local — carried here only so they can be warned about. */
  memory?: string;
  cpus?: string;
  pidsLimit?: string;
  disk?: string;
  sharedDockerCache?: boolean;
  hostSnapshot?: boolean;
  portless?: boolean;
  envFiles?: readonly string[];
}

export interface HubCreateOptsInput {
  /** Bare provider name, post `parseProviderSpec`. */
  providerName: string;
  /** `docker:<alias>` engine alias, when the control box builds a docker box. */
  remoteHost?: string;
  /** Resolved on THIS machine: the control box has no config for this project. */
  cfg: EffectiveConfig;
  flags: HubCreateFlags;
  /** Values the caller already resolved through its own gates. */
  resolved?: {
    persistent?: boolean;
    borrowCredentials?: readonly string[];
    sessionName?: string;
  };
}

export interface HubCreateOpts {
  /** The bag to send. Empty means the caller omits `opts` entirely. */
  opts: CreateJobRequestOpts;
  /** House-style "ignored" lines; the caller `log.warn`s each. Never throws. */
  warnings: string[];
}

interface UnportableRow {
  flag: string;
  asked: (f: HubCreateFlags) => boolean;
  /** Absent = always unportable. */
  applies?: (target: { providerName: string; remoteHost?: string }) => boolean;
  why: (target: { providerName: string; remoteHost?: string }) => string;
}

const isCloudTarget = (t: { remoteHost?: string }): boolean => !t.remoteHost;

/**
 * Options that cannot cross to a control box, each with the reason AND the way
 * to get what the user wanted — a complaint on its own is not actionable.
 */
const UNPORTABLE: UnportableRow[] = [
  ...(['memory', 'cpus', 'pidsLimit', 'disk'] as const).map((key) => ({
    flag: `--${key === 'pidsLimit' ? 'pids-limit' : key}`,
    asked: (f: HubCreateFlags) => f[key] !== undefined,
    applies: isCloudTarget,
    why: (t: { providerName: string }) =>
      `--${key === 'pidsLimit' ? 'pids-limit' : key} sets a docker cgroup ceiling; a ${t.providerName} box is sized with --size (or box.size${t.providerName[0]?.toUpperCase() ?? ''}${t.providerName.slice(1)}). It is still recorded on the box, so \`agentbox show\` will list a limit nothing enforces.`,
  })),
  {
    flag: '--shared-docker-cache',
    asked: (f) => f.sharedDockerCache === true,
    applies: isCloudTarget,
    why: () =>
      '--shared-docker-cache is a docker volume on the build machine; a cloud box has none.',
  },
  {
    flag: '--host-snapshot',
    asked: (f) => f.hostSnapshot === true,
    why: () =>
      "--host-snapshot clones THIS machine's workspace; a control-box create clones the repo instead. Use --local to build here.",
  },
  {
    flag: '--portless',
    asked: (f) => f.portless !== undefined,
    why: () =>
      '--portless would register the box alias on the control box, not on this machine, so it is ignored. Reach the box by its public URL instead.',
  },
  {
    flag: '--build',
    asked: (f) => f.build === true,
    applies: isCloudTarget,
    why: (t) =>
      `--build forces a local docker base build; a ${t.providerName} box boots from a snapshot baked by \`agentbox prepare\` on the control box.`,
  },
  {
    flag: '--with-env',
    asked: (f) => (f.envFiles?.length ?? 0) > 0,
    why: () =>
      'the --with-env file list is resolved on this machine; a control-box create takes those files from the pushed seed, so the explicit list is ignored (the bytes still travel).',
  },
];

/**
 * The options to send, plus what could not be sent.
 *
 * Config is the primary source and a flag is the override — the agent commands
 * declare no `--size`/`--location` at all, so for them this is purely the
 * project's own config, which is the whole point.
 */
export function buildHubCreateOpts(input: HubCreateOptsInput): HubCreateOpts {
  const { cfg, flags, providerName, remoteHost } = input;
  const resolved = input.resolved ?? {};
  const target = { providerName, ...(remoteHost ? { remoteHost } : {}) };

  // Resolved here because the control box cannot: the per-provider prepare pin
  // (`box.imageDaytona`, …) and the per-provider default checkpoint both live in
  // this project's config.
  const image = flags.image?.trim() || resolveBoxImage(cfg, providerName) || undefined;
  const defaultCheckpoint = resolveDefaultCheckpoint(cfg, providerName);
  const snapshot =
    flags.snapshot?.trim() || (defaultCheckpoint.length > 0 ? defaultCheckpoint : undefined);

  // The provider-shaped bag, minus the two keys the hub owns.
  const sizing = cloudSizingProviderOptions(providerName, cfg, {
    ...(flags.size ? { size: flags.size } : {}),
    ...(flags.location ? { location: flags.location } : {}),
    ...(flags.inbound ? { inbound: flags.inbound } : {}),
    // Handed in because remote-docker refuses to resolve without one — and
    // stripped out below, since the hub derives the engine from the provider
    // spec and must never take it from a client.
    ...(remoteHost ? { remoteHost } : {}),
  });
  const providerOptions: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(sizing)) {
    if (key === 'remoteHost' || key === 'extraInboundCidrs') continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      providerOptions[key] = value;
    }
  }
  const size = typeof sizing.size === 'string' ? sizing.size : undefined;
  const location = typeof sizing.location === 'string' ? sizing.location : undefined;
  const inbound = typeof sizing.inbound === 'string' ? sizing.inbound : undefined;

  const opts: CreateJobRequestOpts = {
    // Absent means "the control box decides", so only what was actually asked
    // for is sent — sending `false` everywhere would override its own config.
    ...(snapshot ? { snapshot } : {}),
    ...(image ? { image } : {}),
    ...(flags.withPlaywright === true ? { withPlaywright: true } : {}),
    ...(flags.withEnv === true ? { withEnv: true } : {}),
    ...(flags.vnc === false ? { vnc: false } : {}),
    ...(resolved.persistent !== undefined ? { persistent: resolved.persistent } : {}),
    ...(flags.bundleDepth !== undefined ? { bundleDepth: flags.bundleDepth } : {}),
    ...(flags.credentialSync === false ? { credentialSync: false } : {}),
    ...(resolved.borrowCredentials?.length
      ? { borrowCredentials: [...resolved.borrowCredentials] }
      : {}),
    ...(flags.useBranch ? { useBranch: flags.useBranch } : {}),
    ...(resolved.sessionName ? { sessionName: resolved.sessionName } : {}),
    ...(size ? { size } : {}),
    ...(location ? { location } : {}),
    ...(inbound ? { inbound } : {}),
    ...(Object.keys(providerOptions).length > 0 ? { providerOptions } : {}),
    // Docker-family only, and only when the control box builds one.
    ...(remoteHost && flags.build === true ? { build: true } : {}),
    ...(remoteHost && cfg.box.imageRegistry ? { imageRegistry: cfg.box.imageRegistry } : {}),
  };

  const warnings = UNPORTABLE.filter(
    (row) => row.asked(flags) && (row.applies?.(target) ?? true),
  ).map((row) => `${row.why(target)} Ignored for a control-box create.`);

  return { opts, warnings };
}
