/**
 * EC2 API client — a thin, typed facade over `@aws-sdk/client-ec2`.
 *
 * Unlike the hetzner / digitalocean clients (hand-rolled `fetch` over a JSON
 * REST API), this one wraps the official SDK. The EC2 API is SigV4-signed and
 * XML-only (the Query protocol), and credentials can come from a profile, SSO
 * cache, env vars or IMDS — all of which the SDK's default provider chain
 * already resolves. Hand-rolling that buys nothing and gets the crypto wrong.
 *
 * The facade exists anyway so the backend never imports SDK command classes
 * directly: it keeps the retry policy in one place, normalizes errors into
 * `AwsApiError`, and gives the tests one seam to mock.
 */

import {
  AuthorizeSecurityGroupIngressCommand,
  CreateDefaultVpcCommand,
  CreateImageCommand,
  CreateSecurityGroupCommand,
  CreateTagsCommand,
  DeleteSecurityGroupCommand,
  DeleteSnapshotCommand,
  DeregisterImageCommand,
  DescribeImagesCommand,
  DescribeInstanceTypeOfferingsCommand,
  DescribeInstanceTypesCommand,
  DescribeInstancesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  EC2Client,
  RevokeSecurityGroupIngressCommand,
  RunInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  TerminateInstancesCommand,
  type Filter,
  type IpPermission,
  type _InstanceType,
} from '@aws-sdk/client-ec2';
import { ensureAwsEnvLoaded } from './env-loader.js';

/** Canonical's AWS account id — the owner of the official Ubuntu AMIs. */
export const CANONICAL_OWNER_ID = '099720109477';

/**
 * Normalized EC2 error. `code` is the SDK's stable error `name`
 * (`InsufficientInstanceCapacity`, `UnauthorizedOperation`, `DryRunOperation`,
 * …) — those are the strings we branch on. `statusCode` comes off the HTTP
 * metadata when present.
 */
export class AwsApiError extends Error {
  readonly code: string;
  readonly statusCode: number;
  override readonly cause?: unknown;

  constructor(message: string, code: string, statusCode: number, cause?: unknown) {
    super(message);
    this.name = 'AwsApiError';
    this.code = code;
    this.statusCode = statusCode;
    this.cause = cause;
  }
}

/** Wrap any thrown SDK error into an `AwsApiError`, preserving the name + status. */
export function toAwsApiError(err: unknown): AwsApiError {
  if (err instanceof AwsApiError) return err;
  if (err && typeof err === 'object') {
    const e = err as {
      name?: unknown;
      message?: unknown;
      $metadata?: { httpStatusCode?: number };
    };
    const code = typeof e.name === 'string' ? e.name : 'UnknownError';
    const message = typeof e.message === 'string' ? e.message : String(err);
    const statusCode = e.$metadata?.httpStatusCode ?? 0;
    return new AwsApiError(message, code, statusCode, err);
  }
  return new AwsApiError(String(err), 'UnknownError', 0, err);
}

/** EC2 instance lifecycle states we care about. */
export type AwsInstanceState =
  | 'pending'
  | 'running'
  | 'shutting-down'
  | 'terminated'
  | 'stopping'
  | 'stopped';

export interface AwsInstance {
  instanceId: string;
  state: AwsInstanceState | string;
  publicIp?: string;
  instanceType?: string;
  imageId?: string;
  launchTime?: string;
  tags: Record<string, string>;
}

export interface AwsImage {
  imageId: string;
  name?: string;
  state?: string;
  architecture?: string;
  creationDate?: string;
  /** EBS snapshot ids backing this AMI — these must be deleted alongside it. */
  snapshotIds: string[];
  /** Size (GB) of the largest backing EBS snapshot; gates the minimum root volume. */
  minDiskGb?: number;
}

export interface AwsSecurityGroup {
  groupId: string;
  groupName?: string;
  ipPermissions: IpPermission[];
  tags: Record<string, string>;
}

export interface AwsInstanceTypeInfo {
  instanceType: string;
  vcpus?: number;
  memoryGb?: number;
  architectures: string[];
}

export interface AwsVpc {
  vpcId: string;
  isDefault: boolean;
  ownerId?: string;
}

export interface AwsSubnet {
  subnetId: string;
  vpcId?: string;
  availabilityZone?: string;
  defaultForAz: boolean;
  mapPublicIpOnLaunch: boolean;
}

export interface RunInstanceRequest {
  name: string;
  imageId: string;
  instanceType: string;
  subnetId: string;
  securityGroupId: string;
  userData: string;
  diskGb: number;
  tags: Record<string, string>;
}

function tagsToRecord(tags: { Key?: string; Value?: string }[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of tags ?? []) {
    if (typeof t.Key === 'string') out[t.Key] = t.Value ?? '';
  }
  return out;
}

export interface AwsClientOptions {
  region?: string;
  /** Injected by tests; production always builds a real `EC2Client`. */
  ec2?: EC2Client;
}

export interface AwsClient {
  readonly region: string;
  /** Credential + default-VPC probe in one call. Returns the account's default VPC, or null. */
  describeDefaultVpc(): Promise<AwsVpc | null>;
  describeSubnets(vpcId: string): Promise<AwsSubnet[]>;
  createDefaultVpc(): Promise<string>;

  describeInstance(instanceId: string): Promise<AwsInstance | null>;
  listInstances(filters?: Filter[]): Promise<AwsInstance[]>;
  runInstance(req: RunInstanceRequest): Promise<AwsInstance>;
  startInstance(instanceId: string): Promise<void>;
  stopInstance(instanceId: string): Promise<void>;
  terminateInstance(instanceId: string): Promise<void>;
  createTags(resourceId: string, tags: Record<string, string>): Promise<void>;

  createSecurityGroup(name: string, description: string, vpcId: string, tags: Record<string, string>): Promise<string>;
  describeSecurityGroup(groupId: string): Promise<AwsSecurityGroup | null>;
  deleteSecurityGroup(groupId: string): Promise<void>;
  /** Allow inbound SSH from each CIDR. Idempotent (a duplicate rule is a no-op). */
  authorizeSshIngress(groupId: string, cidrs: string[]): Promise<void>;
  revokeSshIngress(groupId: string, cidrs: string[]): Promise<void>;

  createImage(instanceId: string, name: string, description: string): Promise<string>;
  describeImage(imageId: string): Promise<AwsImage | null>;
  findImageByName(name: string): Promise<AwsImage | null>;
  latestUbuntuAmi(arch?: 'x86_64' | 'arm64'): Promise<AwsImage>;
  deregisterImage(imageId: string): Promise<void>;
  deleteSnapshot(snapshotId: string): Promise<void>;

  describeInstanceType(instanceType: string): Promise<AwsInstanceTypeInfo | null>;
  instanceTypeOfferedInRegion(instanceType: string): Promise<boolean>;

  /**
   * Run a `DryRun: true` probe of one mutating API. Resolves `true` when the
   * caller is permitted (EC2 signals that with the `DryRunOperation` error —
   * a *success* despite being thrown) and `false` on `UnauthorizedOperation`.
   * Any other error propagates: an unexpected failure must not read as
   * "permission missing".
   */
  dryRun(probe: AwsDryRunProbe): Promise<boolean>;
}

/** The mutating APIs the provider needs permission for, probed via DryRun. */
export type AwsDryRunProbe =
  | 'RunInstances'
  | 'CreateSecurityGroup'
  | 'AuthorizeSecurityGroupIngress'
  | 'CreateTags'
  | 'CreateImage'
  | 'TerminateInstances'
  | 'StopInstances'
  | 'StartInstances';

/** IAM action name for each probe — what we print when the probe says "denied". */
export const PROBE_IAM_ACTION: Record<AwsDryRunProbe, string> = {
  RunInstances: 'ec2:RunInstances',
  CreateSecurityGroup: 'ec2:CreateSecurityGroup',
  AuthorizeSecurityGroupIngress: 'ec2:AuthorizeSecurityGroupIngress',
  CreateTags: 'ec2:CreateTags',
  CreateImage: 'ec2:CreateImage',
  TerminateInstances: 'ec2:TerminateInstances',
  StopInstances: 'ec2:StopInstances',
  StartInstances: 'ec2:StartInstances',
};

const SSH_PORT = 22;

function sshPermission(cidrs: string[]): IpPermission {
  return {
    IpProtocol: 'tcp',
    FromPort: SSH_PORT,
    ToPort: SSH_PORT,
    IpRanges: cidrs.map((CidrIp) => ({ CidrIp, Description: 'agentbox inbound' })),
  };
}

export function makeAwsClient(opts: AwsClientOptions = {}): AwsClient {
  ensureAwsEnvLoaded();
  const region = opts.region ?? process.env.AWS_REGION ?? 'us-east-1';
  // The SDK's default credential chain resolves AWS_PROFILE / AWS_ACCESS_KEY_ID
  // / SSO cache / IMDS on its own — we deliberately pass no `credentials`.
  const ec2 = opts.ec2 ?? new EC2Client({ region });

  async function send<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw toAwsApiError(err);
    }
  }

  const client: AwsClient = {
    region,

    async describeDefaultVpc() {
      const res = await send(() =>
        ec2.send(
          new DescribeVpcsCommand({ Filters: [{ Name: 'isDefault', Values: ['true'] }] }),
        ),
      );
      const vpc = res.Vpcs?.[0];
      if (!vpc?.VpcId) return null;
      return { vpcId: vpc.VpcId, isDefault: true, ownerId: vpc.OwnerId };
    },

    async describeSubnets(vpcId) {
      const res = await send(() =>
        ec2.send(new DescribeSubnetsCommand({ Filters: [{ Name: 'vpc-id', Values: [vpcId] }] })),
      );
      return (res.Subnets ?? [])
        .filter((s): s is typeof s & { SubnetId: string } => typeof s.SubnetId === 'string')
        .map((s) => ({
          subnetId: s.SubnetId,
          vpcId: s.VpcId,
          availabilityZone: s.AvailabilityZone,
          defaultForAz: s.DefaultForAz === true,
          mapPublicIpOnLaunch: s.MapPublicIpOnLaunch === true,
        }));
    },

    async createDefaultVpc() {
      const res = await send(() => ec2.send(new CreateDefaultVpcCommand({})));
      const id = res.Vpc?.VpcId;
      if (!id) throw new AwsApiError('CreateDefaultVpc returned no VPC id', 'UnknownError', 0);
      return id;
    },

    async describeInstance(instanceId) {
      let res;
      try {
        res = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
      } catch (err) {
        const e = toAwsApiError(err);
        // A terminated instance is garbage-collected after ~1h and then 404s.
        // "Gone" is a state, not a failure — mirrors the DO getDroplet(404) path.
        if (e.code === 'InvalidInstanceID.NotFound') return null;
        throw e;
      }
      const inst = res.Reservations?.[0]?.Instances?.[0];
      if (!inst?.InstanceId) return null;
      return {
        instanceId: inst.InstanceId,
        state: inst.State?.Name ?? 'unknown',
        publicIp: inst.PublicIpAddress,
        instanceType: inst.InstanceType,
        imageId: inst.ImageId,
        launchTime: inst.LaunchTime?.toISOString(),
        tags: tagsToRecord(inst.Tags),
      };
    },

    async listInstances(filters) {
      const res = await send(() =>
        ec2.send(new DescribeInstancesCommand(filters ? { Filters: filters } : {})),
      );
      const out: AwsInstance[] = [];
      for (const r of res.Reservations ?? []) {
        for (const inst of r.Instances ?? []) {
          if (!inst.InstanceId) continue;
          out.push({
            instanceId: inst.InstanceId,
            state: inst.State?.Name ?? 'unknown',
            publicIp: inst.PublicIpAddress,
            instanceType: inst.InstanceType,
            imageId: inst.ImageId,
            launchTime: inst.LaunchTime?.toISOString(),
            tags: tagsToRecord(inst.Tags),
          });
        }
      }
      return out;
    },

    async runInstance(req) {
      const res = await send(() =>
        ec2.send(
          new RunInstancesCommand({
            ImageId: req.imageId,
            InstanceType: req.instanceType as _InstanceType,
            MinCount: 1,
            MaxCount: 1,
            UserData: Buffer.from(req.userData, 'utf8').toString('base64'),
            // The NetworkInterfaces form is the only way to force a public IP on
            // a subnet whose MapPublicIpOnLaunch is false. It is mutually
            // exclusive with top-level SubnetId / SecurityGroupIds — passing both
            // is an InvalidParameterCombination.
            NetworkInterfaces: [
              {
                DeviceIndex: 0,
                AssociatePublicIpAddress: true,
                SubnetId: req.subnetId,
                Groups: [req.securityGroupId],
                DeleteOnTermination: true,
              },
            ],
            BlockDeviceMappings: [
              {
                DeviceName: '/dev/sda1',
                Ebs: {
                  VolumeSize: req.diskGb,
                  VolumeType: 'gp3',
                  Encrypted: true,
                  DeleteOnTermination: true,
                },
              },
            ],
            // IMDSv2 only — an SSRF in an in-box service must not be able to read
            // instance metadata with a plain GET.
            MetadataOptions: { HttpTokens: 'required', HttpEndpoint: 'enabled' },
            TagSpecifications: [
              {
                ResourceType: 'instance',
                Tags: Object.entries(req.tags).map(([Key, Value]) => ({ Key, Value })),
              },
            ],
          }),
        ),
      );
      const inst = res.Instances?.[0];
      if (!inst?.InstanceId) {
        throw new AwsApiError('RunInstances returned no instance', 'UnknownError', 0);
      }
      return {
        instanceId: inst.InstanceId,
        state: inst.State?.Name ?? 'pending',
        publicIp: inst.PublicIpAddress,
        instanceType: inst.InstanceType,
        imageId: inst.ImageId,
        launchTime: inst.LaunchTime?.toISOString(),
        tags: tagsToRecord(inst.Tags),
      };
    },

    async startInstance(instanceId) {
      await send(() => ec2.send(new StartInstancesCommand({ InstanceIds: [instanceId] })));
    },

    async stopInstance(instanceId) {
      await send(() => ec2.send(new StopInstancesCommand({ InstanceIds: [instanceId] })));
    },

    async terminateInstance(instanceId) {
      try {
        await ec2.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
      } catch (err) {
        const e = toAwsApiError(err);
        // Already gone — destroy() is idempotent.
        if (e.code === 'InvalidInstanceID.NotFound') return;
        throw e;
      }
    },

    async createTags(resourceId, tags) {
      await send(() =>
        ec2.send(
          new CreateTagsCommand({
            Resources: [resourceId],
            Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
          }),
        ),
      );
    },

    async createSecurityGroup(name, description, vpcId, tags) {
      const res = await send(() =>
        ec2.send(
          new CreateSecurityGroupCommand({
            GroupName: name,
            Description: description,
            VpcId: vpcId,
            TagSpecifications: [
              {
                ResourceType: 'security-group',
                Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })),
              },
            ],
          }),
        ),
      );
      const id = res.GroupId;
      if (!id) throw new AwsApiError('CreateSecurityGroup returned no group id', 'UnknownError', 0);
      return id;
    },

    async describeSecurityGroup(groupId) {
      try {
        const res = await ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: [groupId] }));
        const sg = res.SecurityGroups?.[0];
        if (!sg?.GroupId) return null;
        return {
          groupId: sg.GroupId,
          groupName: sg.GroupName,
          ipPermissions: sg.IpPermissions ?? [],
          tags: tagsToRecord(sg.Tags),
        };
      } catch (err) {
        const e = toAwsApiError(err);
        if (e.code === 'InvalidGroup.NotFound') return null;
        throw e;
      }
    },

    async deleteSecurityGroup(groupId) {
      try {
        await ec2.send(new DeleteSecurityGroupCommand({ GroupId: groupId }));
      } catch (err) {
        const e = toAwsApiError(err);
        if (e.code === 'InvalidGroup.NotFound') return;
        throw e;
      }
    },

    async authorizeSshIngress(groupId, cidrs) {
      if (cidrs.length === 0) return;
      try {
        await ec2.send(
          new AuthorizeSecurityGroupIngressCommand({
            GroupId: groupId,
            IpPermissions: [sshPermission(cidrs)],
          }),
        );
      } catch (err) {
        const e = toAwsApiError(err);
        // Re-authorizing the same rule is a no-op, not a failure — this keeps
        // `firewall sync` idempotent. NB: EC2 rejects the WHOLE call when ANY
        // range duplicates, so callers must not mix new + existing CIDRs in one
        // request; `syncSecurityGroupSources` only ever sends the missing ones.
        if (e.code === 'InvalidPermission.Duplicate') return;
        throw e;
      }
    },

    async revokeSshIngress(groupId, cidrs) {
      if (cidrs.length === 0) return;
      try {
        await ec2.send(
          new RevokeSecurityGroupIngressCommand({
            GroupId: groupId,
            IpPermissions: [sshPermission(cidrs)],
          }),
        );
      } catch (err) {
        const e = toAwsApiError(err);
        if (e.code === 'InvalidPermission.NotFound') return;
        throw e;
      }
    },

    async createImage(instanceId, name, description) {
      const res = await send(() =>
        ec2.send(
          new CreateImageCommand({
            InstanceId: instanceId,
            Name: name,
            Description: description,
            // Live snapshot, matching `docker commit` / DO's snapshot semantics.
            // The caller runs `sync` first so the filesystem is consistent.
            NoReboot: true,
          }),
        ),
      );
      const id = res.ImageId;
      if (!id) throw new AwsApiError('CreateImage returned no image id', 'UnknownError', 0);
      return id;
    },

    async describeImage(imageId) {
      try {
        const res = await ec2.send(new DescribeImagesCommand({ ImageIds: [imageId] }));
        return toImage(res.Images?.[0]);
      } catch (err) {
        const e = toAwsApiError(err);
        if (e.code === 'InvalidAMIID.NotFound' || e.code === 'InvalidAMIID.Malformed') return null;
        throw e;
      }
    },

    async findImageByName(name) {
      const res = await send(() =>
        ec2.send(
          new DescribeImagesCommand({
            Owners: ['self'],
            Filters: [{ Name: 'name', Values: [name] }],
          }),
        ),
      );
      return toImage(res.Images?.[0]);
    },

    async latestUbuntuAmi(arch = 'x86_64') {
      const res = await send(() =>
        ec2.send(
          new DescribeImagesCommand({
            Owners: [CANONICAL_OWNER_ID],
            Filters: [
              {
                Name: 'name',
                Values: [`ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-${arch === 'arm64' ? 'arm64' : 'amd64'}-server-*`],
              },
              { Name: 'state', Values: ['available'] },
            ],
          }),
        ),
      );
      const images = (res.Images ?? [])
        .map((i) => toImage(i))
        .filter((i): i is AwsImage => i !== null)
        .sort((a, b) => (b.creationDate ?? '').localeCompare(a.creationDate ?? ''));
      const newest = images[0];
      if (!newest) {
        throw new AwsApiError(
          `no Ubuntu 24.04 (${arch}) AMI found in ${region} — Canonical publishes them in every commercial region, so this usually means the region name is wrong`,
          'InvalidAMIID.NotFound',
          0,
        );
      }
      return newest;
    },

    async deregisterImage(imageId) {
      try {
        await ec2.send(new DeregisterImageCommand({ ImageId: imageId }));
      } catch (err) {
        const e = toAwsApiError(err);
        if (e.code === 'InvalidAMIID.NotFound' || e.code === 'InvalidAMIID.Unavailable') return;
        throw e;
      }
    },

    async deleteSnapshot(snapshotId) {
      try {
        await ec2.send(new DeleteSnapshotCommand({ SnapshotId: snapshotId }));
      } catch (err) {
        const e = toAwsApiError(err);
        if (e.code === 'InvalidSnapshot.NotFound') return;
        throw e;
      }
    },

    async describeInstanceType(instanceType) {
      try {
        const res = await ec2.send(
          new DescribeInstanceTypesCommand({ InstanceTypes: [instanceType as _InstanceType] }),
        );
        const t = res.InstanceTypes?.[0];
        if (!t?.InstanceType) return null;
        const mib = t.MemoryInfo?.SizeInMiB;
        return {
          instanceType: t.InstanceType,
          vcpus: t.VCpuInfo?.DefaultVCpus,
          memoryGb: typeof mib === 'number' ? Math.round(mib / 1024) : undefined,
          architectures: t.ProcessorInfo?.SupportedArchitectures ?? [],
        };
      } catch (err) {
        const e = toAwsApiError(err);
        // A bogus type is reported as a validation error, not an empty list.
        if (e.code === 'InvalidInstanceType' || e.code === 'InvalidParameterValue') return null;
        throw e;
      }
    },

    async instanceTypeOfferedInRegion(instanceType) {
      const res = await send(() =>
        ec2.send(
          new DescribeInstanceTypeOfferingsCommand({
            LocationType: 'region',
            Filters: [{ Name: 'instance-type', Values: [instanceType] }],
          }),
        ),
      );
      return (res.InstanceTypeOfferings ?? []).length > 0;
    },

    async dryRun(probe) {
      try {
        await sendDryRun(ec2, probe);
        // EC2 is supposed to ALWAYS throw on a DryRun (DryRunOperation when
        // permitted). A clean resolve means the API ignored the flag — treat it
        // as permitted rather than inventing a failure.
        return true;
      } catch (err) {
        const e = toAwsApiError(err);
        if (e.code === 'DryRunOperation') return true;
        if (e.code === 'UnauthorizedOperation') return false;
        throw e;
      }
    },
  };

  return client;
}

function toImage(i: { ImageId?: string; Name?: string; State?: string; Architecture?: string; CreationDate?: string; BlockDeviceMappings?: { Ebs?: { SnapshotId?: string; VolumeSize?: number } }[] } | undefined): AwsImage | null {
  if (!i?.ImageId) return null;
  const ebs = (i.BlockDeviceMappings ?? []).map((b) => b.Ebs).filter((e): e is NonNullable<typeof e> => !!e);
  const sizes = ebs.map((e) => e.VolumeSize).filter((s): s is number => typeof s === 'number');
  return {
    imageId: i.ImageId,
    name: i.Name,
    state: i.State,
    architecture: i.Architecture,
    creationDate: i.CreationDate,
    snapshotIds: ebs.map((e) => e.SnapshotId).filter((s): s is string => typeof s === 'string'),
    minDiskGb: sizes.length > 0 ? Math.max(...sizes) : undefined,
  };
}

/**
 * Send a minimal, side-effect-free `DryRun` probe for each permission we need.
 * The parameters only have to be well-formed enough to pass shape validation —
 * with `DryRun: true` EC2 evaluates IAM and then stops, so nothing is created
 * and the placeholder resource ids are never dereferenced.
 *
 * Each arm sends its own concrete command rather than building a union and
 * sending that: `ec2.send()` is generic over one command type, so a union of
 * commands does not typecheck.
 */
async function sendDryRun(ec2: EC2Client, probe: AwsDryRunProbe): Promise<void> {
  switch (probe) {
    case 'RunInstances':
      await ec2.send(
        new RunInstancesCommand({
          DryRun: true,
          MinCount: 1,
          MaxCount: 1,
          InstanceType: 't3.medium' as _InstanceType,
          ImageId: 'ami-00000000000000000',
        }),
      );
      return;
    case 'CreateSecurityGroup':
      await ec2.send(
        new CreateSecurityGroupCommand({
          DryRun: true,
          GroupName: 'agentbox-dryrun',
          Description: 'agentbox permission probe',
        }),
      );
      return;
    case 'AuthorizeSecurityGroupIngress':
      await ec2.send(
        new AuthorizeSecurityGroupIngressCommand({
          DryRun: true,
          GroupId: 'sg-00000000000000000',
          IpPermissions: [sshPermission(['192.0.2.1/32'])],
        }),
      );
      return;
    case 'CreateTags':
      await ec2.send(
        new CreateTagsCommand({
          DryRun: true,
          Resources: ['i-00000000000000000'],
          Tags: [{ Key: 'agentbox.probe', Value: '1' }],
        }),
      );
      return;
    case 'CreateImage':
      await ec2.send(
        new CreateImageCommand({
          DryRun: true,
          InstanceId: 'i-00000000000000000',
          Name: 'agentbox-dryrun',
        }),
      );
      return;
    case 'TerminateInstances':
      await ec2.send(
        new TerminateInstancesCommand({ DryRun: true, InstanceIds: ['i-00000000000000000'] }),
      );
      return;
    case 'StopInstances':
      await ec2.send(
        new StopInstancesCommand({ DryRun: true, InstanceIds: ['i-00000000000000000'] }),
      );
      return;
    case 'StartInstances':
      await ec2.send(
        new StartInstancesCommand({ DryRun: true, InstanceIds: ['i-00000000000000000'] }),
      );
      return;
  }
}
