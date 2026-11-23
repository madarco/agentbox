import { describe, expect, it } from 'vitest';
import type { BoxRecord } from '@agentbox/core';
import { CLONE_CLOUD_POLICY, CLONE_RECORD_POLICY, cloneCarryOpts } from '../lib/boxes/clone-carry';

// A clone used to inherit only `persistent`, borrowed logins and accounts: a
// `--no-skills` box's clone got the whole library, and a proxied box's clone
// egressed direct with no warning. Every record field is now classified (tsc
// fails on an unclassified one); these check that every field classified
// `carry` actually reaches the clone's create.

const base = {
  id: 'b1',
  name: 'src',
  container: 'c',
  image: 'img',
  workspacePath: '/w',
  createdAt: '2026-01-01T00:00:00Z',
  skills: { none: true, include: ['a'], exclude: ['b'] },
  persistent: true,
  withPlaywright: true,
  vncEnabled: true,
  borrowedCredentials: ['codex'],
  accounts: { claude: 'work' },
  llmProxy: { mode: 'forward', upstream: '10.0.0.1:8899' },
} satisfies Partial<BoxRecord>;

const docker: BoxRecord = {
  ...base,
  provider: 'docker',
  dockerCacheShared: true,
  portlessAlias: 'src',
  resourceLimits: { memoryBytes: 4 * 1024 ** 3, cpus: 2, pidsLimit: 512, disk: '20G' },
} as BoxRecord;

const hetzner: BoxRecord = {
  ...base,
  provider: 'hetzner',
  cloud: {
    backend: 'hetzner',
    sandboxId: '42',
    size: 'cx43',
    location: 'fsn1',
    inbound: { mode: 'whitelist', sources: ['203.0.113.5/32'] },
    sandboxClass: 'linux-vm',
  },
} as BoxRecord;

const remote: BoxRecord = {
  ...base,
  provider: 'remote-docker',
  cloud: { backend: 'remote-docker', sandboxId: 'me@gpu-box/agentbox-src' },
} as BoxRecord;

const scenarios = [docker, hetzner, remote].map((r) => ({ r, p: r.provider ?? 'docker' }));

function without<T extends object>(o: T, key: string): T {
  const copy = { ...o } as Record<string, unknown>;
  delete copy[key];
  return copy as T;
}

describe('cloneCarryOpts', () => {
  it('every record field classified carry changes the clone', () => {
    for (const [key, policy] of Object.entries(CLONE_RECORD_POLICY)) {
      if (policy !== 'carry') continue;
      const changes = scenarios.some(
        ({ r, p }) =>
          JSON.stringify(cloneCarryOpts(r, p)) !==
          JSON.stringify(cloneCarryOpts(without(r, key), p)),
      );
      expect(changes, `${key} is classified carry but never reaches the create`).toBe(true);
    }
  });

  it('every cloud field classified carry changes the clone', () => {
    for (const [key, policy] of Object.entries(CLONE_CLOUD_POLICY)) {
      if (policy !== 'carry') continue;
      const changes = scenarios.some(({ r, p }) => {
        if (!r.cloud) return false;
        const stripped = { ...r, cloud: without(r.cloud, key) } as BoxRecord;
        return JSON.stringify(cloneCarryOpts(r, p)) !== JSON.stringify(cloneCarryOpts(stripped, p));
      });
      expect(changes, `cloud.${key} is classified carry but never reaches the create`).toBe(true);
    }
  });

  it('keeps the skills selection and the LLM proxy, explicitly either way', () => {
    expect(cloneCarryOpts(docker, 'docker')).toMatchObject({
      skills: { none: true, include: ['a'], exclude: ['b'] },
      llmProxy: 'forward',
    });
    // A direct box's clone is pinned direct, so the hub's config can't proxy it.
    expect(cloneCarryOpts(without(docker, 'llmProxy'), 'docker').llmProxy).toBe('off');
  });

  it('carries docker limits on the same provider', () => {
    expect(cloneCarryOpts(docker, 'docker')).toMatchObject({
      memory: String(4 * 1024 ** 3),
      cpus: '2',
      pidsLimit: '512',
      disk: '20G',
      sharedDockerCache: true,
      portless: true,
    });
  });

  it('carries size, location, firewall and class on the same cloud', () => {
    expect(cloneCarryOpts(hetzner, 'hetzner')).toMatchObject({
      size: 'cx43',
      location: 'fsn1',
      inbound: 'whitelist:203.0.113.5/32',
      providerOptions: { sandboxClass: 'linux-vm' },
    });
    expect(cloneCarryOpts(remote, 'remote-docker').remoteHost).toBe('me@gpu-box');
  });

  it('drops engine-shaped settings when the clone moves provider', () => {
    const moved = cloneCarryOpts(hetzner, 'daytona');
    for (const k of ['size', 'location', 'inbound', 'providerOptions', 'remoteHost', 'memory']) {
      expect(moved).not.toHaveProperty(k);
    }
    // The proxy upstream is engine-shaped too: config decides on a new provider.
    expect(moved).not.toHaveProperty('llmProxy');
    // What the box IS still carries.
    expect(moved).toMatchObject({ skills: { none: true }, accounts: { claude: 'work' } });
  });
});
