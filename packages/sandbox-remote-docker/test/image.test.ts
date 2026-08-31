import { describe, expect, it } from 'vitest';
import {
  cleanupContextCommand,
  remoteBuildArgv,
  remoteImageRef,
  stageContextCommand,
} from '../src/image.js';

describe('remoteBuildArgv', () => {
  // The docker-29 regression this exists to prevent: `docker build -` (a tar on
  // stdin) plus `-f` is rejected outright by buildx with "ambiguous Dockerfile
  // source". The context must be a directory path, and `-f` must survive since
  // our context names its Dockerfile `Dockerfile.box`.
  it('builds from a directory context, never from stdin', () => {
    const argv = remoteBuildArgv('agentbox/box:abc123', '/tmp/ctx-1');
    expect(argv).toEqual([
      'build',
      '-t',
      'agentbox/box:abc123',
      '-f',
      '/tmp/ctx-1/Dockerfile.box',
      '/tmp/ctx-1',
    ]);
    expect(argv).not.toContain('-');
  });

  it('folds the claude install mode in as a build arg', () => {
    expect(remoteBuildArgv('r', '/tmp/ctx', 'npm')).toEqual([
      'build',
      '-t',
      'r',
      '-f',
      '/tmp/ctx/Dockerfile.box',
      '--build-arg',
      'AGENTBOX_AGENT_INSTALL=npm',
      '/tmp/ctx',
    ]);
  });
});

describe('stageContextCommand / cleanupContextCommand', () => {
  it('creates the dir and unpacks stdin into it', () => {
    expect(stageContextCommand('/tmp/ctx-1')).toBe(
      'mkdir -p /tmp/ctx-1 && tar -xf - -C /tmp/ctx-1',
    );
  });

  it('quotes a path the shell would otherwise split', () => {
    expect(stageContextCommand("/tmp/a b';touch pwned")).toBe(
      "mkdir -p '/tmp/a b'\\'';touch pwned' && tar -xf - -C '/tmp/a b'\\'';touch pwned'",
    );
    expect(cleanupContextCommand('/tmp/a b')).toBe("rm -rf '/tmp/a b'");
  });
});

describe('remoteImageRef', () => {
  it('tags by the first 16 chars of the context fingerprint', () => {
    expect(remoteImageRef('0123456789abcdef0123456789abcdef')).toBe(
      'agentbox/box:0123456789abcdef',
    );
  });
});
