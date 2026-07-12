import { describe, expect, it, vi } from 'vitest';
import { UserFacingError } from '@agentbox/core';
import { AwsApiError, type AwsClient, type AwsSecurityGroup } from '../src/client.js';
import {
  allowedSshSources,
  deletePerBoxSecurityGroup,
  normalizeSourceCidr,
  resolveFirewallSource,
  securityGroupIdFromTags,
  securityGroupNeedsSync,
  syncSecurityGroupSources,
} from '../src/security-group.js';

function sg(sources: string[]): AwsSecurityGroup {
  return {
    groupId: 'sg-1',
    groupName: 'agentbox-box',
    tags: {},
    ipPermissions: [
      {
        IpProtocol: 'tcp',
        FromPort: 22,
        ToPort: 22,
        IpRanges: sources.map((CidrIp) => ({ CidrIp })),
      },
    ],
  };
}

describe('normalizeSourceCidr', () => {
  it('widens a bare v4 to /32 and a bare v6 to /128', () => {
    expect(normalizeSourceCidr('1.2.3.4')).toBe('1.2.3.4/32');
    expect(normalizeSourceCidr('2001:db8::1')).toBe('2001:db8::1/128');
  });

  it('passes an explicit CIDR through', () => {
    expect(normalizeSourceCidr('10.0.0.0/8')).toBe('10.0.0.0/8');
  });

  it('refuses an empty source rather than silently widening the rule', () => {
    expect(() => normalizeSourceCidr('  ')).toThrow(UserFacingError);
  });
});

describe('securityGroupNeedsSync', () => {
  it('is true when the host egress IP is not allowed', () => {
    expect(securityGroupNeedsSync(['1.1.1.1/32'], '2.2.2.2/32')).toBe(true);
  });

  it('is false when it is already allowed', () => {
    expect(securityGroupNeedsSync(['2.2.2.2/32'], '2.2.2.2/32')).toBe(false);
  });

  it('never "fixes" an explicitly-open group', () => {
    // 0.0.0.0/0 is a deliberate opt-in for a dynamic IP. Narrowing it back to
    // the host IP would silently undo what the user asked for.
    expect(securityGroupNeedsSync(['0.0.0.0/0'], '2.2.2.2/32')).toBe(false);
  });
});

describe('allowedSshSources', () => {
  it('reads only the tcp/22 ranges', () => {
    const group: AwsSecurityGroup = {
      groupId: 'sg-1',
      tags: {},
      ipPermissions: [
        { IpProtocol: 'tcp', FromPort: 22, ToPort: 22, IpRanges: [{ CidrIp: '1.1.1.1/32' }] },
        { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, IpRanges: [{ CidrIp: '0.0.0.0/0' }] },
      ],
    };
    expect(allowedSshSources(group)).toEqual(['1.1.1.1/32']);
  });
});

describe('securityGroupIdFromTags', () => {
  it('reads the id off the agentbox.firewall tag', () => {
    expect(securityGroupIdFromTags({ 'agentbox.firewall': 'sg-9' })).toBe('sg-9');
    expect(securityGroupIdFromTags({})).toBeUndefined();
  });
});

describe('syncSecurityGroupSource', () => {
  it('authorizes the new CIDR BEFORE revoking the old ones', async () => {
    // Order is load-bearing: a failure between the two must leave the box
    // reachable from both IPs, never from neither.
    const calls: string[] = [];
    const client = {
      describeSecurityGroup: async () => sg(['1.1.1.1/32']),
      authorizeSshIngress: async (_g: string, cs: string[]) => {
        for (const c of cs) calls.push(`authorize:${c}`);
      },
      revokeSshIngress: async (_g: string, cs: string[]) => {
        for (const c of cs) calls.push(`revoke:${c}`);
      },
    } as unknown as AwsClient;

    const res = await syncSecurityGroupSources(client, 'sg-1', ['2.2.2.2/32']);
    expect(calls).toEqual(['authorize:2.2.2.2/32', 'revoke:1.1.1.1/32']);
    expect(res).toEqual({ added: ['2.2.2.2/32'], removed: ['1.1.1.1/32'] });
  });

  it('fails loud when the group was deleted out of band', async () => {
    const client = { describeSecurityGroup: async () => null } as unknown as AwsClient;
    await expect(syncSecurityGroupSources(client, 'sg-1', ['2.2.2.2/32'])).rejects.toThrow(
      UserFacingError,
    );
  });
});

describe('deletePerBoxSecurityGroup', () => {
  it('retries through DependencyViolation while the ENI detaches', async () => {
    // After TerminateInstances the instance reaches `terminated` while its NIC
    // is still detaching, and EC2 rejects the delete until it finishes.
    let attempts = 0;
    const client = {
      deleteSecurityGroup: vi.fn(async () => {
        attempts += 1;
        if (attempts < 3) throw new AwsApiError('in use', 'DependencyViolation', 400);
      }),
    } as unknown as AwsClient;

    const res = await deletePerBoxSecurityGroup(client, 'sg-1', {
      deadlineMs: 60_000,
      intervalMs: 1,
    });
    expect(res.deleted).toBe(true);
    expect(attempts).toBe(3);
  });

  it('gives up at the deadline without throwing, so destroy still succeeds', async () => {
    const client = {
      deleteSecurityGroup: async () => {
        throw new AwsApiError('in use', 'DependencyViolation', 400);
      },
    } as unknown as AwsClient;

    const logs: string[] = [];
    // deadlineMs=0 -> one attempt, then give up immediately.
    const res = await deletePerBoxSecurityGroup(client, 'sg-1', {
      deadlineMs: 0,
      onLog: (l) => logs.push(l),
    });
    expect(res.deleted).toBe(false);
    expect(logs.join('\n')).toMatch(/prune --provider aws/);
  });

  it('does not retry a non-dependency error', async () => {
    const client = {
      deleteSecurityGroup: vi.fn(async () => {
        throw new AwsApiError('nope', 'UnauthorizedOperation', 403);
      }),
    } as unknown as AwsClient;

    const res = await deletePerBoxSecurityGroup(client, 'sg-1', { deadlineMs: 60_000 });
    expect(res.deleted).toBe(false);
    expect(client.deleteSecurityGroup).toHaveBeenCalledTimes(1);
  });
});

describe('resolveFirewallSource', () => {
  it('honors an explicit override from the box env', async () => {
    await expect(resolveFirewallSource({ AGENTBOX_AWS_FIREWALL_SOURCE: '9.9.9.9' })).resolves.toBe(
      '9.9.9.9/32',
    );
  });
});
