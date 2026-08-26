import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEPLOY_REPO_URL,
  deployRefForVersion,
  describeHubDeploySource,
  resolveHubDeploySource,
} from '../src/control-plane/deploy-ref.js';

/**
 * The deploy ref used to be a hardcoded `main`, which silently mismatched every
 * nightly CLI: the host wrote a full-hub `.env` + `reverse_proxy app:8787` while
 * the VPS built v0.27.1, whose container listens on :3000 behind Postgres. Caddy
 * then 502'd for the whole healthz window against a hub that was perfectly fine.
 */
describe('deployRefForVersion', () => {
  it('deploys the nightly branch for a nightly build', () => {
    expect(deployRefForVersion('0.28.0-nightly.202607251816')).toBe('nightly');
  });

  it('deploys its own tag for a released build', () => {
    expect(deployRefForVersion('0.27.1')).toBe('v0.27.1');
    expect(deployRefForVersion('1.0.0')).toBe('v1.0.0');
  });

  it('deploys nightly for a dev build with no injected version', () => {
    expect(deployRefForVersion('0.0.0-dev')).toBe('nightly');
  });

  it('never returns a bare branch name for a release (that was the bug)', () => {
    expect(deployRefForVersion('0.27.1')).not.toBe('main');
  });
});

/**
 * The control box installs the published package by default — the npm tarball
 * already carries the standalone hub `agentbox hub` spawns locally, so building
 * 14 workspace packages on the VPS bought nothing but a version-skew surface.
 * Source mode stays reachable for deploying unreleased code.
 */
describe('resolveHubDeploySource', () => {
  it("installs this CLI's exact version by default", () => {
    expect(resolveHubDeploySource('0.27.1')).toEqual({ kind: 'package', spec: '0.27.1' });
    expect(resolveHubDeploySource('0.28.0-nightly.202607260716')).toEqual({
      kind: 'package',
      spec: '0.28.0-nightly.202607260716',
    });
  });

  it('builds from source when --ref names one', () => {
    expect(resolveHubDeploySource('0.27.1', { ref: 'feat/x' })).toEqual({
      kind: 'source',
      repoUrl: DEFAULT_DEPLOY_REPO_URL,
      repoRef: 'feat/x',
    });
  });

  it('builds from source when --repo names a fork, defaulting the ref to this CLI', () => {
    expect(resolveHubDeploySource('0.27.1', { repoUrl: 'https://github.com/me/fork.git' })).toEqual(
      {
        kind: 'source',
        repoUrl: 'https://github.com/me/fork.git',
        repoRef: 'v0.27.1',
      },
    );
  });

  it('installs an explicit --package spec, even a dist-tag', () => {
    expect(resolveHubDeploySource('0.27.1', { packageSpec: 'nightly' })).toEqual({
      kind: 'package',
      spec: 'nightly',
    });
  });

  it('falls back to source for a dev build — its version was never published', () => {
    expect(resolveHubDeploySource('0.0.0-dev')).toEqual({
      kind: 'source',
      repoUrl: DEFAULT_DEPLOY_REPO_URL,
      repoRef: 'nightly',
    });
  });

  it('lets --package win over --ref (the explicit spec is the more specific ask)', () => {
    expect(resolveHubDeploySource('0.0.0-dev', { ref: 'nightly', packageSpec: 'latest' })).toEqual({
      kind: 'package',
      spec: 'latest',
    });
  });

  it('describes both modes for the progress log', () => {
    expect(describeHubDeploySource({ kind: 'package', spec: '0.27.1' })).toContain(
      '@madarco/agentbox@0.27.1',
    );
    expect(describeHubDeploySource({ kind: 'source', repoUrl: 'u', repoRef: 'r' })).toContain(
      'u@r',
    );
  });
});
