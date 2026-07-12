import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AwsClient } from '../src/client.js';
import { mapState, resolveImageRef } from '../src/backend.js';

describe('mapState', () => {
  it('reports a booting instance as running, so callers do not ping-pong', () => {
    expect(mapState('pending')).toBe('running');
    expect(mapState('running')).toBe('running');
  });

  it('maps a stopped instance to paused (an EC2 stop is a power-off)', () => {
    expect(mapState('stopping')).toBe('paused');
    expect(mapState('stopped')).toBe('paused');
  });

  it('maps a terminated instance to missing', () => {
    // `shutting-down` is already unusable — treating it as running would make
    // callers wait on a box that is never coming back.
    expect(mapState('shutting-down')).toBe('missing');
    expect(mapState('terminated')).toBe('missing');
    expect(mapState(undefined)).toBe('missing');
  });
});

describe('resolveImageRef', () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    // Isolate HOME: prepared-state reads ~/.agentbox/aws-prepared.json, and this
    // suite must never touch (or depend on) the real one.
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), 'agentbox-aws-test-'));
    process.env.HOME = home;
    mkdirSync(join(home, '.agentbox'), { recursive: true });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  function writeBase(amiId: string, region = 'us-east-1'): void {
    writeFileSync(
      join(home, '.agentbox', 'aws-prepared.json'),
      JSON.stringify({
        schema: 1,
        base: { amiId, region, description: 'base', createdAt: '2026-01-01T00:00:00Z' },
      }),
    );
  }

  const c = (findImageByName: AwsClient['findImageByName']) =>
    ({ region: 'us-east-1', findImageByName }) as unknown as AwsClient;

  const never = c(async () => {
    throw new Error('should not have been called');
  });

  it('resolves the base AMI from the docker-provider fallback tag', async () => {
    // The cloud scaffolding defaults req.image to `agentbox/box:dev`, which is
    // meaningless on EC2. It has to mean "the prepared base AMI", not a lookup.
    writeBase('ami-base');
    await expect(
      resolveImageRef(never, { name: 'b', image: 'agentbox/box:dev' }),
    ).resolves.toBe('ami-base');
  });

  it('resolves the base AMI from our own sentinel and from nothing at all', async () => {
    writeBase('ami-base');
    await expect(resolveImageRef(never, { name: 'b', image: 'agentbox-base' })).resolves.toBe(
      'ami-base',
    );
    await expect(resolveImageRef(never, { name: 'b', image: '' })).resolves.toBe('ami-base');
  });

  it('uses an explicit ami- id verbatim', async () => {
    await expect(resolveImageRef(never, { name: 'b', image: 'ami-explicit' })).resolves.toBe(
      'ami-explicit',
    );
  });

  it('prefers req.snapshot over req.image (the checkpoint path)', async () => {
    writeBase('ami-base');
    const client = c(async (name: string) =>
      name === 'ckpt-1' ? { imageId: 'ami-ckpt', snapshotIds: [], state: 'available' } : null,
    );
    await expect(
      resolveImageRef(client, { name: 'b', image: 'agentbox-base', snapshot: 'ckpt-1' }),
    ).resolves.toBe('ami-ckpt');
  });

  it('resolves a checkpoint by AMI name', async () => {
    const client = c(async () => ({ imageId: 'ami-ckpt', snapshotIds: [], state: 'available' }));
    await expect(resolveImageRef(client, { name: 'b', image: 'my-checkpoint' })).resolves.toBe(
      'ami-ckpt',
    );
  });

  it('names the region trap when a checkpoint is not found', async () => {
    // The single most confusing failure this provider has: an AMI taken in
    // another region simply is not visible here.
    const client = c(async () => null);
    await expect(resolveImageRef(client, { name: 'b', image: 'gone' })).rejects.toThrow(
      /region-scoped/,
    );
  });
});
