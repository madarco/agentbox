import { describe, expect, it, vi } from 'vitest';
import type { EC2Client } from '@aws-sdk/client-ec2';
import { AwsApiError, makeAwsClient, toAwsApiError } from '../src/client.js';

/**
 * Build a fake EC2Client whose `send` is driven by a handler keyed on the
 * command's class name. The real SDK dispatches on the command object, so this
 * is the natural seam — `makeAwsClient({ ec2 })` takes the injection.
 */
function fakeEc2(handler: (name: string, input: Record<string, unknown>) => unknown): EC2Client {
  return {
    send: vi.fn(async (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const out = handler(cmd.constructor.name, cmd.input);
      if (out instanceof Error) throw out;
      return out;
    }),
  } as unknown as EC2Client;
}

/** An error shaped like the SDK's: the code lives on `name`. */
function sdkError(name: string, httpStatusCode = 400): Error {
  const e = new Error(`${name}: simulated`);
  e.name = name;
  (e as unknown as { $metadata: unknown }).$metadata = { httpStatusCode };
  return e;
}

describe('toAwsApiError', () => {
  it('lifts the SDK error name into `code` and the status off $metadata', () => {
    const e = toAwsApiError(sdkError('InsufficientInstanceCapacity', 500));
    expect(e).toBeInstanceOf(AwsApiError);
    expect(e.code).toBe('InsufficientInstanceCapacity');
    expect(e.statusCode).toBe(500);
  });
});

describe('dryRun', () => {
  // EC2 signals "you are permitted" by THROWING DryRunOperation, and "you are
  // not" by throwing UnauthorizedOperation. Nothing ever resolves normally.
  // Getting this backwards would silently invert the whole permission report,
  // so it is pinned here.
  it('treats a thrown DryRunOperation as PERMITTED', async () => {
    const client = makeAwsClient({ ec2: fakeEc2(() => sdkError('DryRunOperation', 412)) });
    await expect(client.dryRun('RunInstances')).resolves.toBe(true);
  });

  it('treats a thrown UnauthorizedOperation as DENIED', async () => {
    const client = makeAwsClient({ ec2: fakeEc2(() => sdkError('UnauthorizedOperation', 403)) });
    await expect(client.dryRun('RunInstances')).resolves.toBe(false);
  });

  it('propagates any other error rather than reporting "denied"', async () => {
    const client = makeAwsClient({ ec2: fakeEc2(() => sdkError('RequestLimitExceeded', 503)) });
    await expect(client.dryRun('CreateImage')).rejects.toThrow(/RequestLimitExceeded/);
  });

  it('sends DryRun:true so nothing is ever created', async () => {
    const seen: Record<string, unknown>[] = [];
    const client = makeAwsClient({
      ec2: fakeEc2((_n, input) => {
        seen.push(input);
        return sdkError('DryRunOperation', 412);
      }),
    });
    await client.dryRun('TerminateInstances');
    expect(seen[0]?.DryRun).toBe(true);
  });
});

describe('describeInstance', () => {
  it('maps a reservation into the flat shape, with tags as a record', async () => {
    const client = makeAwsClient({
      ec2: fakeEc2(() => ({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: 'i-0abc',
                State: { Name: 'running' },
                PublicIpAddress: '203.0.113.7',
                InstanceType: 't3.medium',
                Tags: [{ Key: 'agentbox.firewall', Value: 'sg-0xyz' }],
              },
            ],
          },
        ],
      })),
    });
    const inst = await client.describeInstance('i-0abc');
    expect(inst).toMatchObject({
      instanceId: 'i-0abc',
      state: 'running',
      publicIp: '203.0.113.7',
      tags: { 'agentbox.firewall': 'sg-0xyz' },
    });
  });

  it('returns null for a garbage-collected instance instead of throwing', async () => {
    // A terminated instance 404s after ~1h. "Gone" is a state, not a failure —
    // `state()` must be able to report `missing`.
    const client = makeAwsClient({
      ec2: fakeEc2(() => sdkError('InvalidInstanceID.NotFound', 400)),
    });
    await expect(client.describeInstance('i-0gone')).resolves.toBeNull();
  });
});

describe('latestUbuntuAmi', () => {
  it('picks the newest by creation date, and carries the backing snapshot ids', async () => {
    const client = makeAwsClient({
      ec2: fakeEc2(() => ({
        Images: [
          {
            ImageId: 'ami-old',
            CreationDate: '2025-01-01T00:00:00.000Z',
            Architecture: 'x86_64',
            BlockDeviceMappings: [{ Ebs: { SnapshotId: 'snap-old', VolumeSize: 8 } }],
          },
          {
            ImageId: 'ami-new',
            CreationDate: '2026-06-01T00:00:00.000Z',
            Architecture: 'x86_64',
            BlockDeviceMappings: [{ Ebs: { SnapshotId: 'snap-new', VolumeSize: 12 } }],
          },
        ],
      })),
    });
    const ami = await client.latestUbuntuAmi();
    expect(ami.imageId).toBe('ami-new');
    // Load-bearing for delete: deregistering an AMI without deleting these
    // leaks (and bills for) the snapshots forever.
    expect(ami.snapshotIds).toEqual(['snap-new']);
    expect(ami.minDiskGb).toBe(12);
  });

  it('fails loud when the region has no Ubuntu AMI', async () => {
    const client = makeAwsClient({ ec2: fakeEc2(() => ({ Images: [] })) });
    await expect(client.latestUbuntuAmi()).rejects.toThrow(/no Ubuntu 24\.04/);
  });
});

describe('idempotent deletes', () => {
  it('terminateInstance swallows an already-gone instance', async () => {
    const client = makeAwsClient({
      ec2: fakeEc2(() => sdkError('InvalidInstanceID.NotFound')),
    });
    await expect(client.terminateInstance('i-0gone')).resolves.toBeUndefined();
  });

  it('deregisterImage swallows an already-gone AMI', async () => {
    const client = makeAwsClient({ ec2: fakeEc2(() => sdkError('InvalidAMIID.NotFound')) });
    await expect(client.deregisterImage('ami-gone')).resolves.toBeUndefined();
  });

  it('authorizeSshIngress swallows a duplicate rule, so `firewall sync` is idempotent', async () => {
    const client = makeAwsClient({
      ec2: fakeEc2(() => sdkError('InvalidPermission.Duplicate')),
    });
    await expect(client.authorizeSshIngress('sg-0', ['1.2.3.4/32'])).resolves.toBeUndefined();
  });
});

describe('runInstance', () => {
  it('forces a public IP, an explicit root volume and IMDSv2', async () => {
    let input: Record<string, unknown> = {};
    const client = makeAwsClient({
      ec2: fakeEc2((name, i) => {
        if (name === 'RunInstancesCommand') {
          input = i;
          return { Instances: [{ InstanceId: 'i-0new', State: { Name: 'pending' } }] };
        }
        return {};
      }),
    });

    await client.runInstance({
      name: 'smoke',
      imageId: 'ami-1',
      instanceType: 't3.medium',
      subnetId: 'subnet-1',
      securityGroupId: 'sg-1',
      userData: '#cloud-config\n',
      diskGb: 40,
      tags: { 'agentbox.box': 'smoke' },
    });

    const nic = (input.NetworkInterfaces as { AssociatePublicIpAddress?: boolean; Groups?: string[] }[])[0];
    // Without a public IP the host cannot reach the box at all; the SG rides on
    // the NIC because the NetworkInterfaces form forbids top-level SecurityGroupIds.
    expect(nic?.AssociatePublicIpAddress).toBe(true);
    expect(nic?.Groups).toEqual(['sg-1']);
    expect(input.SubnetId).toBeUndefined();
    expect(input.SecurityGroupIds).toBeUndefined();

    const ebs = (input.BlockDeviceMappings as { Ebs?: { VolumeSize?: number } }[])[0]?.Ebs;
    // EC2's own default is 8 GB, which cannot hold the base image.
    expect(ebs?.VolumeSize).toBe(40);
    expect((input.MetadataOptions as { HttpTokens?: string }).HttpTokens).toBe('required');
    // user-data must be base64 for EC2.
    expect(Buffer.from(String(input.UserData), 'base64').toString('utf8')).toBe('#cloud-config\n');
  });
});
