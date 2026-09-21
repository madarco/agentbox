export type TargetId =
  | 'docker@mac'
  | 'docker@linux'
  | 'remote-docker'
  | 'daytona'
  | 'hetzner'
  | 'vercel'
  | 'e2b';

export interface Target {
  id: TargetId;
  /** Short tag used in box names; cloud names have length limits. */
  slug: string;
  /** Provider name as `prepare --provider` / `ls` report it. */
  provider: string;
  /** The value passed to `--provider` on create (remote-docker carries the host alias). */
  providerArg: string;
  kind: 'docker' | 'cloud' | 'remote-docker';
  /** Where the runner executes; `linux` targets run on the Hetzner test VM. */
  host: 'mac' | 'linux';
  /** Concurrent boxes this target may hold (the Mac's Docker VM OOMs at ~3 build-heavy boxes). */
  maxBoxes: number;
}

/** SSH alias the e2e home's ~/.ssh/config gives the Linux test VM. */
export const LINUX_VM_ALIAS = 'e2e-linux';

export const TARGETS: Record<TargetId, Target> = {
  'docker@mac': {
    id: 'docker@mac',
    slug: 'dm',
    provider: 'docker',
    providerArg: 'docker',
    kind: 'docker',
    host: 'mac',
    maxBoxes: 2,
  },
  'docker@linux': {
    id: 'docker@linux',
    slug: 'dl',
    provider: 'docker',
    providerArg: 'docker',
    kind: 'docker',
    host: 'linux',
    maxBoxes: 3,
  },
  'remote-docker': {
    id: 'remote-docker',
    slug: 'rd',
    provider: 'remote-docker',
    providerArg: `docker:${LINUX_VM_ALIAS}`,
    kind: 'remote-docker',
    host: 'mac',
    maxBoxes: 2,
  },
  daytona: {
    id: 'daytona',
    slug: 'dt',
    provider: 'daytona',
    providerArg: 'daytona',
    kind: 'cloud',
    host: 'mac',
    maxBoxes: 3,
  },
  hetzner: {
    id: 'hetzner',
    slug: 'hz',
    provider: 'hetzner',
    providerArg: 'hetzner',
    kind: 'cloud',
    host: 'mac',
    maxBoxes: 3,
  },
  vercel: {
    id: 'vercel',
    slug: 'vc',
    provider: 'vercel',
    providerArg: 'vercel',
    kind: 'cloud',
    host: 'mac',
    maxBoxes: 3,
  },
  e2b: {
    id: 'e2b',
    slug: 'eb',
    provider: 'e2b',
    providerArg: 'e2b',
    kind: 'cloud',
    host: 'mac',
    maxBoxes: 3,
  },
};

export const ALL_TARGETS = Object.keys(TARGETS) as TargetId[];

export function parseTargets(list: string): Target[] {
  const ids =
    list === 'all'
      ? ALL_TARGETS
      : list
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
  return ids.map((id) => {
    const t = TARGETS[id as TargetId];
    if (!t) throw new Error(`unknown target "${id}" (known: ${ALL_TARGETS.join(', ')})`);
    return t;
  });
}
