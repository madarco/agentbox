/**
 * `agentbox doctor --json` envelope — the menu-bar app's setup wizard reads it,
 * so the shape is a contract: groups verbatim, status rolled up, and the
 * portless facts as a top-level block that does not depend on the docker group,
 * plus the control box's own inventory as a second top-level block so a consumer
 * can tell the two machines apart.
 */

import { describe, expect, it } from 'vitest';
import { buildDoctorReport, type CheckGroup } from '../src/lib/doctor-checks.js';
import type { ControlBoxInventory } from '../src/control-plane/control-box-inventory.js';

const groups: CheckGroup[] = [
  {
    title: 'system',
    results: [
      { label: 'git', status: 'ok', detail: 'git version 2.46.0' },
      { label: 'gh', status: 'warn', detail: 'not found', hint: 'optional: `brew install gh`' },
    ],
  },
  {
    title: 'docker',
    results: [{ label: 'docker daemon', status: 'warn', detail: 'unreachable' }],
  },
];

const probes = (over: {
  engine?: string;
  installed?: boolean;
  version?: string;
  proxyRunning?: boolean;
  serviceInstalled?: boolean;
  serviceFailing?: boolean;
}) => ({
  engine: () => Promise.resolve(over.engine ?? 'docker-desktop'),
  portless: () =>
    Promise.resolve({
      installed: over.installed ?? true,
      version: over.version,
      proxyRunning: over.proxyRunning ?? true,
    }),
  service: () =>
    Promise.resolve({ installed: over.serviceInstalled ?? false, failing: over.serviceFailing }),
});

describe('buildDoctorReport', () => {
  it('keeps the groups verbatim and rolls the status up to the worst row', async () => {
    const report = await buildDoctorReport(groups, probes({}));
    expect(report.groups).toEqual(groups);
    expect(report.status).toBe('warn');
    expect(typeof report.version).toBe('string');
    expect(report.platform).toEqual({ os: process.platform, arch: process.arch });
  });

  it('reports fail when any row fails', async () => {
    const failing: CheckGroup[] = [
      { title: 'system', results: [{ label: 'node', status: 'fail', detail: 'v18' }] },
    ];
    const report = await buildDoctorReport(failing, probes({}));
    expect(report.status).toBe('fail');
  });

  it('carries the portless facts as a top-level block even with docker down', async () => {
    const report = await buildDoctorReport(
      groups,
      probes({ installed: true, version: '0.13.0', proxyRunning: true, serviceInstalled: false }),
    );
    expect(report.portless).toEqual({
      relevant: true,
      installed: true,
      version: '0.13.0',
      proxyRunning: true,
      serviceInstalled: false,
      serviceFailing: false,
    });
  });

  it('flags an installed startup service that is crash-looping', async () => {
    const report = await buildDoctorReport(
      groups,
      probes({ serviceInstalled: true, serviceFailing: true }),
    );
    expect(report.portless.serviceInstalled).toBe(true);
    expect(report.portless.serviceFailing).toBe(true);
  });

  it('omits version when portless is not installed', async () => {
    const report = await buildDoctorReport(
      groups,
      probes({ installed: false, proxyRunning: false }),
    );
    expect(report.portless.installed).toBe(false);
    expect('version' in report.portless).toBe(false);
  });

  it('marks portless irrelevant on OrbStack', async () => {
    const report = await buildDoctorReport(groups, probes({ engine: 'orbstack' }));
    expect(report.portless.relevant).toBe(false);
  });

  it('degrades a throwing probe to not-installed rather than failing the report', async () => {
    const report = await buildDoctorReport(groups, {
      engine: () => Promise.reject(new Error('no docker')),
      portless: () => Promise.reject(new Error('boom')),
      service: () => Promise.reject(new Error('boom')),
    });
    expect(report.portless).toEqual({
      relevant: true,
      installed: false,
      proxyRunning: false,
      serviceInstalled: false,
      serviceFailing: false,
    });
  });
});

describe('buildDoctorReport — the control box block', () => {
  const inventory: ControlBoxInventory = {
    url: 'https://cp.example',
    reachable: true,
    providers: [{ id: 'e2b', hasCredentials: true, configured: true, state: 'fresh' }],
  };

  it('is absent when no control box is configured', async () => {
    const report = await buildDoctorReport(groups, probes({}));
    expect('controlBox' in report).toBe(false);
  });

  it('is absent when the control box IS this machine (hub expose / a local hub)', async () => {
    // Co-located is the probe's own `null`: the local provider groups already
    // describe that machine, so a second block would only mislabel it.
    const report = await buildDoctorReport(groups, {
      ...probes({}),
      controlBox: () => Promise.resolve(null),
    });
    expect('controlBox' in report).toBe(false);
  });

  it('carries the control box providers when one is configured', async () => {
    const report = await buildDoctorReport(groups, {
      ...probes({}),
      controlBox: () => Promise.resolve(inventory),
    });
    expect(report.controlBox).toEqual(inventory);
    // The laptop's own rows are untouched — that is the point of a second block.
    expect(report.groups).toEqual(groups);
  });

  it('keeps an unreachable control box out of the status and the exit code', async () => {
    const unreachable: ControlBoxInventory = {
      url: 'https://cp.example',
      reachable: false,
      error: 'could not read its baked providers',
      providers: [],
    };
    const report = await buildDoctorReport(groups, {
      ...probes({}),
      controlBox: () => Promise.resolve(unreachable),
    });
    expect(report.controlBox?.reachable).toBe(false);
    expect(report.status).toBe('warn'); // the groups' own worst row, not 'fail'
  });

  it('degrades a THROWING control-box probe to an absent block, never a failure', async () => {
    const report = await buildDoctorReport(groups, {
      ...probes({}),
      controlBox: () => Promise.reject(new Error('network down')),
    });
    expect('controlBox' in report).toBe(false);
    expect(report.status).toBe('warn');
  });
});
