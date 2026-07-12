import { describe, expect, it } from 'vitest';
import {
  AGENTBOX_EC2_POLICY,
  POLICY_JSON,
  REQUIRED_PROBES,
  preflightPermissions,
} from '../src/setup-iam.js';
import { PROBE_IAM_ACTION, type AwsClient, type AwsDryRunProbe } from '../src/client.js';

/** A client whose `dryRun` answers from a fixture map. */
function fakeClient(answers: Partial<Record<AwsDryRunProbe, boolean | Error>>): AwsClient {
  return {
    async dryRun(probe: AwsDryRunProbe) {
      const a = answers[probe];
      if (a instanceof Error) throw a;
      // Default-allow, so a test only has to name the probes it cares about.
      return a ?? true;
    },
  } as unknown as AwsClient;
}

describe('preflightPermissions', () => {
  it('reports ok when every probe is permitted', async () => {
    const report = await preflightPermissions(fakeClient({}));
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.undetermined).toEqual([]);
  });

  it('maps a denied probe to its IAM action name', async () => {
    const report = await preflightPermissions(fakeClient({ RunInstances: false, CreateImage: false }));
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual(['ec2:RunInstances', 'ec2:CreateImage']);
  });

  it('probes every permission the provider actually needs', async () => {
    // Guards against a probe being dropped from the sweep: the create path
    // exercises all of these, and a missing one resurfaces as an opaque
    // UnauthorizedOperation mid-bake.
    expect([...REQUIRED_PROBES].sort()).toEqual(
      [
        'AuthorizeSecurityGroupIngress',
        'CreateImage',
        'CreateSecurityGroup',
        'CreateTags',
        'RunInstances',
        'StartInstances',
        'StopInstances',
        'TerminateInstances',
      ].sort(),
    );
    for (const probe of REQUIRED_PROBES) {
      expect(PROBE_IAM_ACTION[probe]).toMatch(/^ec2:/);
    }
  });

  it('an unexpected error is undetermined, NOT missing', async () => {
    // The distinction is the whole point: telling someone to grant a permission
    // they already have, because the network hiccuped, is worse than saying
    // "couldn't check".
    const report = await preflightPermissions(
      fakeClient({ CreateTags: new Error('RequestLimitExceeded') }),
    );
    expect(report.missing).not.toContain('ec2:CreateTags');
    expect(report.undetermined).toEqual([
      { action: 'ec2:CreateTags', reason: 'RequestLimitExceeded' },
    ]);
    // No *denied* probe, so the run is still "ok" — the caller surfaces the
    // undetermined list separately.
    expect(report.ok).toBe(true);
  });
});

describe('AGENTBOX_EC2_POLICY', () => {
  it('grants exactly the actions the probes check', () => {
    const granted = new Set(AGENTBOX_EC2_POLICY.Statement.flatMap((s) => [...s.Action]));
    for (const probe of REQUIRED_PROBES) {
      expect(granted).toContain(PROBE_IAM_ACTION[probe]);
    }
  });

  it('grants no IAM, billing or organizations actions', () => {
    // The policy we hand a user must be EC2-only. A stray iam:* would be us
    // asking for the right to escalate our own privileges.
    const granted = AGENTBOX_EC2_POLICY.Statement.flatMap((s) => [...s.Action]);
    for (const action of granted) {
      expect(action.startsWith('ec2:')).toBe(true);
    }
  });

  it('serializes to valid JSON for the console paste', () => {
    expect(() => JSON.parse(POLICY_JSON)).not.toThrow();
    expect(JSON.parse(POLICY_JSON)).toEqual(AGENTBOX_EC2_POLICY);
  });
});
