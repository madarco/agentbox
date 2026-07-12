/**
 * Pure AWS create preflight — no network. The backend fetches the instance-type
 * info / offering / AMI and calls in here, BEFORE it creates any billable
 * resource (security group, instance), so a bad `--size t99.mega` or an x86 AMI
 * on a Graviton type fails fast with an actionable message instead of a late,
 * opaque API error after cleanup churn.
 *
 * Kept side-effect-free so it unit-tests against fixtures. Mirrors the Hetzner /
 * DigitalOcean `preflight.ts`.
 */

import { UserFacingError } from '@agentbox/core';
import { AwsApiError, type AwsImage, type AwsInstanceTypeInfo } from './client.js';

export interface InstanceChoice {
  instanceType: string;
  region: string;
  diskGb: number;
}

/**
 * Validate an instance-type + region + disk choice against the live catalog and
 * the base AMI, throwing a `UserFacingError` with a fix on the first problem.
 *
 * Checks, in order: the type exists → is offered in the region → its
 * architecture matches the AMI's → the root volume fits the AMI's snapshot.
 *
 * `ami` is null when we're booting a stock image we haven't described (the
 * arch + disk checks are skipped then — we have nothing to compare against).
 */
export function validateInstanceChoice(
  choice: InstanceChoice,
  typeInfo: AwsInstanceTypeInfo | null,
  offeredInRegion: boolean,
  ami: AwsImage | null,
): void {
  const { instanceType, region, diskGb } = choice;

  if (!typeInfo) {
    throw new UserFacingError(
      `AWS instance type "${instanceType}" does not exist.\n` +
        'Pick a real type (e.g. `t3.medium`, `t3.large`, `m7i.large`) with `--size <type>` ' +
        'or `agentbox config set box.sizeAws <type>`.',
    );
  }

  if (!offeredInRegion) {
    throw new UserFacingError(
      `AWS instance type "${instanceType}" is not offered in region "${region}".\n` +
        'Pick another type with `--size <type>`, or another region with `--location <region>` ' +
        'or `agentbox config set box.awsRegion <region>`.',
    );
  }

  // The architecture guard. A Graviton type (t4g/c7g/…) only boots an arm64 AMI,
  // and our base AMI is baked x86_64 by default — without this check the failure
  // surfaces as an opaque `InvalidParameterValue` from RunInstances, long after
  // the security group exists.
  if (ami?.architecture && typeInfo.architectures.length > 0) {
    if (!typeInfo.architectures.includes(ami.architecture)) {
      throw new UserFacingError(
        `AWS instance type "${instanceType}" is ${typeInfo.architectures.join('/')}, but the base ` +
          `AMI ${ami.imageId} is ${ami.architecture}.\n` +
          `Pick a ${ami.architecture} instance type, or re-bake the base for ` +
          `${typeInfo.architectures.join('/')} with \`agentbox prepare --provider aws\`.`,
      );
    }
  }

  if (ami?.minDiskGb !== undefined && diskGb < ami.minDiskGb) {
    throw new UserFacingError(
      `The root volume (${String(diskGb)} GB) is smaller than the base AMI's snapshot ` +
        `(${String(ami.minDiskGb)} GB).\n` +
        `Raise it with \`agentbox config set box.awsDiskGb ${String(ami.minDiskGb)}\` (or higher).`,
    );
  }
}

/**
 * Map a late EC2 provision error into actionable guidance, preserving the
 * original message. Unrecognized errors pass through unchanged — we never hide
 * an unexpected failure behind a guess.
 *
 * Keyed on the SDK's stable error `name`, not on message text (unlike
 * DigitalOcean, which reports its droplet limit as prose).
 */
export function mapAwsProvisionError(err: unknown, choice: InstanceChoice): unknown {
  if (!(err instanceof AwsApiError)) return err;
  const { instanceType, region } = choice;

  switch (err.code) {
    case 'VcpuLimitExceeded':
    case 'InstanceLimitExceeded':
      return new UserFacingError(
        `AWS refused to launch the instance: your account's EC2 quota is exhausted (${err.message}).\n` +
          'New accounts start with a low vCPU limit. Request an increase in the AWS console under ' +
          'Service Quotas -> AWS services -> Amazon EC2 -> "Running On-Demand Standard instances", ' +
          'then retry.',
      );

    case 'InsufficientInstanceCapacity':
      return new UserFacingError(
        `AWS has no capacity for "${instanceType}" in "${region}" right now (${err.message}).\n` +
          'This is transient and specific to the instance type + availability zone. Retry, pick ' +
          'another type with `--size <type>`, or another region with `--location <region>`.',
      );

    case 'Unsupported':
      return new UserFacingError(
        `AWS does not support "${instanceType}" in "${region}" (${err.message}).\n` +
          'Some instance types are only offered in a subset of availability zones. Pick another ' +
          'type with `--size <type>` or another region with `--location <region>`.',
      );

    case 'InvalidAMIID.NotFound':
    case 'InvalidAMIID.Unavailable':
      return new UserFacingError(
        `The base AMI recorded for AWS no longer exists (${err.message}).\n` +
          'It was probably deregistered out of band. Re-bake it with ' +
          '`agentbox prepare --provider aws --force`.\n' +
          'Note that AMIs are region-scoped: an AMI baked in one region cannot boot an instance ' +
          'in another.',
      );

    case 'UnauthorizedOperation':
      return new UserFacingError(
        `AWS denied the request — the credentials are missing an IAM permission (${err.message}).\n` +
          'Run `agentbox aws login` to see exactly which actions are missing and get the policy ' +
          'to attach.',
      );

    case 'AuthFailure':
    case 'ExpiredToken':
    case 'ExpiredTokenException':
    case 'InvalidClientTokenId':
      return new UserFacingError(
        `AWS rejected the credentials (${err.message}).\n` +
          'If you use SSO, the session has expired: run `aws sso login --profile ' +
          `${process.env.AWS_PROFILE ?? '<profile>'}\`.\n` +
          'Otherwise re-run `agentbox aws login`.',
      );

    default:
      return err;
  }
}
