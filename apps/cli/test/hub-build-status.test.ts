import { describe, expect, it } from 'vitest';
import { describeRemoteHubBuild } from '../src/commands/hub.js';
import type { ControlPlaneDeployRecord } from '@agentbox/sandbox-core';

const CLI = '0.28.0-nightly.202607260716';

function record(source: ControlPlaneDeployRecord['source']): ControlPlaneDeployRecord {
  return { provider: 'hetzner', url: 'https://h.example', ...(source ? { source } : {}) };
}

/**
 * `hub status` reconciles two sources of truth. The live version has to win: the
 * deploy record only says what was last *deployed*, which is wrong after a failed
 * update and absent entirely for a hub someone else set up.
 */
describe('describeRemoteHubBuild', () => {
  it('prefers the version the hub reports over the one that was deployed', () => {
    const b = describeRemoteHubBuild({
      liveVersion: '0.27.1',
      record: record({ kind: 'package', spec: '0.28.0-nightly.202607260716' }),
      cliVersion: CLI,
    });
    expect(b.version).toBe('0.27.1');
    expect(b.versionSource).toBe('live');
    expect(b.channel).toBe('stable');
  });

  it('falls back to the deployed spec for a control box too old to report one', () => {
    const b = describeRemoteHubBuild({
      liveVersion: undefined,
      record: record({ kind: 'package', spec: '0.27.1' }),
      cliVersion: CLI,
    });
    expect(b.version).toBe('0.27.1');
    expect(b.versionSource).toBe('deployed');
  });

  it('derives the nightly channel from the version', () => {
    const b = describeRemoteHubBuild({
      liveVersion: CLI,
      record: record({ kind: 'package', spec: CLI }),
      cliVersion: CLI,
    });
    expect(b.channel).toBe('nightly');
  });

  it('reports the ref as the channel for a source build', () => {
    const b = describeRemoteHubBuild({
      liveVersion: '0.28.0-nightly.202607260716',
      record: record({
        kind: 'source',
        repoUrl: 'https://github.com/madarco/agentbox.git',
        repoRef: 'my-branch',
      }),
      cliVersion: CLI,
    });
    expect(b.channel).toBe('source (my-branch)');
    expect(b.build).toContain('built from source');
  });

  it('nudges to update only when the LIVE version differs from this CLI', () => {
    const drifted = describeRemoteHubBuild({
      liveVersion: '0.27.1',
      record: record({ kind: 'package', spec: '0.27.1' }),
      cliVersion: CLI,
    });
    expect(drifted.drift).toContain('hub update');

    const matched = describeRemoteHubBuild({
      liveVersion: CLI,
      record: record({ kind: 'package', spec: CLI }),
      cliVersion: CLI,
    });
    expect(matched.drift).toBeNull();
  });

  it('never nudges off a stale record alone — that would nag forever', () => {
    // No live version: the record says 0.27.1 but we have no evidence that is
    // what is actually running, so suggesting an update would be a guess.
    const b = describeRemoteHubBuild({
      liveVersion: undefined,
      record: record({ kind: 'package', spec: '0.27.1' }),
      cliVersion: CLI,
    });
    expect(b.drift).toBeNull();
  });

  it('survives a hub with no local deploy record at all', () => {
    const b = describeRemoteHubBuild({ liveVersion: '0.27.1', record: null, cliVersion: CLI });
    expect(b.version).toBe('0.27.1');
    expect(b.channel).toBe('stable');
    expect(b.build).toBeNull();
  });

  it('reports nothing at all when neither side knows', () => {
    const b = describeRemoteHubBuild({ liveVersion: undefined, record: null, cliVersion: CLI });
    expect(b).toEqual({
      version: null,
      versionSource: null,
      channel: null,
      build: null,
      drift: null,
    });
  });
});

/**
 * `--package nightly` records the literal dist-tag, not a version. Reading it as
 * one printed `version: nightly` and — worse — classified it `stable`, since
 * `channelOfVersion` only looks for a `-nightly.` suffix.
 */
describe('describeRemoteHubBuild with a dist-tag spec', () => {
  it('does not present a dist-tag as the running version', () => {
    const b = describeRemoteHubBuild({
      liveVersion: undefined,
      record: record({ kind: 'package', spec: 'nightly' }),
      cliVersion: CLI,
    });
    expect(b.version).toBeNull();
    expect(b.channel).toBeNull();
    // The build line still shows what was asked for.
    expect(b.build).toContain('@madarco/agentbox@nightly');
  });

  it('still classifies correctly once the hub reports a real version', () => {
    const b = describeRemoteHubBuild({
      liveVersion: CLI,
      record: record({ kind: 'package', spec: 'nightly' }),
      cliVersion: CLI,
    });
    expect(b.version).toBe(CLI);
    expect(b.channel).toBe('nightly');
  });

  it('treats `latest` the same way — unknown, not stable-by-accident', () => {
    const b = describeRemoteHubBuild({
      liveVersion: undefined,
      record: record({ kind: 'package', spec: 'latest' }),
      cliVersion: CLI,
    });
    expect(b.channel).toBeNull();
  });
});
