import { describe, expect, it } from 'vitest';
import { UserFacingError } from '@agentbox/core';
import { AwsApiError, type AwsImage, type AwsInstanceTypeInfo } from '../src/client.js';
import { mapAwsProvisionError, validateInstanceChoice } from '../src/preflight.js';

const T3_MEDIUM: AwsInstanceTypeInfo = {
  instanceType: 't3.medium',
  vcpus: 2,
  memoryGb: 4,
  architectures: ['x86_64'],
};

const T4G_MEDIUM: AwsInstanceTypeInfo = {
  instanceType: 't4g.medium',
  vcpus: 2,
  memoryGb: 4,
  architectures: ['arm64'],
};

const X86_AMI: AwsImage = {
  imageId: 'ami-x86',
  architecture: 'x86_64',
  snapshotIds: ['snap-1'],
  minDiskGb: 20,
};

const CHOICE = { instanceType: 't3.medium', region: 'us-east-1', diskGb: 40 };

describe('validateInstanceChoice', () => {
  it('accepts a valid x86 type + x86 AMI', () => {
    expect(() => validateInstanceChoice(CHOICE, T3_MEDIUM, true, X86_AMI)).not.toThrow();
  });

  it('rejects an unknown instance type', () => {
    expect(() => validateInstanceChoice(CHOICE, null, true, X86_AMI)).toThrow(UserFacingError);
    expect(() => validateInstanceChoice(CHOICE, null, true, X86_AMI)).toThrow(/does not exist/);
  });

  it('rejects a type not offered in the region', () => {
    expect(() => validateInstanceChoice(CHOICE, T3_MEDIUM, false, X86_AMI)).toThrow(
      /not offered in region/,
    );
  });

  it('rejects a Graviton type against an x86 AMI', () => {
    // The guard that matters: without it RunInstances fails with an opaque
    // InvalidParameterValue long after the security group exists.
    const choice = { ...CHOICE, instanceType: 't4g.medium' };
    expect(() => validateInstanceChoice(choice, T4G_MEDIUM, true, X86_AMI)).toThrow(
      /is arm64, but the base AMI ami-x86 is x86_64/,
    );
  });

  it('rejects a root volume smaller than the AMI snapshot', () => {
    const choice = { ...CHOICE, diskGb: 10 };
    expect(() => validateInstanceChoice(choice, T3_MEDIUM, true, X86_AMI)).toThrow(
      /smaller than the base AMI's snapshot/,
    );
  });

  it('skips the arch + disk checks when there is no AMI to compare against', () => {
    expect(() => validateInstanceChoice({ ...CHOICE, diskGb: 1 }, T4G_MEDIUM, true, null)).not.toThrow();
  });
});

describe('mapAwsProvisionError', () => {
  function err(code: string): AwsApiError {
    return new AwsApiError(`${code}: simulated`, code, 400);
  }

  it('explains a vCPU quota exhaustion', () => {
    const mapped = mapAwsProvisionError(err('VcpuLimitExceeded'), CHOICE);
    expect(mapped).toBeInstanceOf(UserFacingError);
    expect((mapped as Error).message).toMatch(/Service Quotas/);
  });

  it('explains a capacity shortfall as transient + type/AZ-specific', () => {
    const mapped = mapAwsProvisionError(err('InsufficientInstanceCapacity'), CHOICE);
    expect((mapped as Error).message).toMatch(/no capacity for "t3\.medium" in "us-east-1"/);
  });

  it('points a missing AMI at a re-bake and names the region trap', () => {
    const mapped = mapAwsProvisionError(err('InvalidAMIID.NotFound'), CHOICE);
    expect((mapped as Error).message).toMatch(/prepare --provider aws --force/);
    expect((mapped as Error).message).toMatch(/region-scoped/);
  });

  it('points an expired SSO token at `aws sso login`', () => {
    const mapped = mapAwsProvisionError(err('ExpiredToken'), CHOICE);
    expect((mapped as Error).message).toMatch(/aws sso login/);
  });

  it('sends UnauthorizedOperation to the permission sweep', () => {
    const mapped = mapAwsProvisionError(err('UnauthorizedOperation'), CHOICE);
    expect((mapped as Error).message).toMatch(/agentbox aws login/);
  });

  it('passes an unrecognized error through untouched', () => {
    // Never hide an unexpected failure behind a guess.
    const original = err('SomethingNobodyPredicted');
    expect(mapAwsProvisionError(original, CHOICE)).toBe(original);
  });

  it('passes a non-AWS error through untouched', () => {
    const boom = new Error('boom');
    expect(mapAwsProvisionError(boom, CHOICE)).toBe(boom);
  });
});
