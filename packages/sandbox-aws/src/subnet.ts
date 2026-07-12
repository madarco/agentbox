/**
 * Where does a box's instance actually live?
 *
 * AgentBox never creates a VPC. It uses the account's **default VPC** and one of
 * its public subnets — which is what every AWS account has had by default since
 * 2013, and what `aws ec2 create-default-vpc` restores in one call.
 *
 * The escape hatch is `box.awsSubnetId` (threaded in as `subnetId`), for
 * accounts whose default VPC was deliberately removed, or that run everything in
 * a custom VPC. We take it on faith: if you name a subnet, you own its routing.
 *
 * When there is no default VPC and no explicit subnet, we fail loud with the fix
 * rather than inventing network topology in someone's account.
 */

import { UserFacingError } from '@agentbox/core';
import type { AwsClient } from './client.js';

export interface ResolvedSubnet {
  subnetId: string;
  vpcId: string;
  availabilityZone?: string;
}

/**
 * Resolve the subnet to launch into.
 *
 * With an explicit `subnetId` we look it up only to learn its VPC (the security
 * group has to be created in the same VPC, or `RunInstances` rejects the pair).
 *
 * Otherwise: the default VPC, then its subnets, preferring one that already
 * auto-assigns public IPs. That preference is a nicety, not a requirement — we
 * pass `AssociatePublicIpAddress: true` explicitly at launch, which overrides the
 * subnet's own setting either way.
 */
export async function resolveDefaultSubnet(
  client: AwsClient,
  subnetId?: string,
): Promise<ResolvedSubnet> {
  const explicit = subnetId?.trim();

  if (explicit) {
    const vpc = await client.describeDefaultVpc();
    // Look through every subnet of the default VPC first (the common case), then
    // fall back to trusting the id as-is for a custom-VPC subnet.
    if (vpc) {
      const subnets = await client.describeSubnets(vpc.vpcId);
      const match = subnets.find((s) => s.subnetId === explicit);
      if (match?.vpcId) {
        return { subnetId: match.subnetId, vpcId: match.vpcId, availabilityZone: match.availabilityZone };
      }
    }
    throw new UserFacingError(
      `box.awsSubnetId is set to "${explicit}", but that subnet is not in this account's default VPC ` +
        'in this region.\n' +
        'A subnet in a custom VPC is not supported yet (the per-box security group has to be created ' +
        'in the same VPC).\n' +
        'Unset it with `agentbox config unset box.awsSubnetId` to use the default VPC.',
    );
  }

  const vpc = await client.describeDefaultVpc();
  if (!vpc) {
    throw new UserFacingError(
      `this AWS account has no default VPC in ${client.region}, so a box has nowhere to launch.\n` +
        'Fix it either way:\n' +
        '  - recreate the default VPC:  aws ec2 create-default-vpc --region ' + client.region + '\n' +
        '    (or re-run `agentbox aws login`, which offers to do it for you)\n' +
        '  - or point AgentBox at an existing public subnet:\n' +
        '    agentbox config set box.awsSubnetId subnet-…',
    );
  }

  const subnets = await client.describeSubnets(vpc.vpcId);
  if (subnets.length === 0) {
    throw new UserFacingError(
      `the default VPC (${vpc.vpcId}) in ${client.region} has no subnets.\n` +
        'Add one, or set an explicit subnet with `agentbox config set box.awsSubnetId subnet-…`.',
    );
  }

  const preferred =
    subnets.find((s) => s.mapPublicIpOnLaunch) ??
    subnets.find((s) => s.defaultForAz) ??
    subnets[0];

  if (!preferred) {
    throw new UserFacingError(
      `could not pick a subnet in the default VPC (${vpc.vpcId}) in ${client.region}.`,
    );
  }

  return {
    subnetId: preferred.subnetId,
    vpcId: vpc.vpcId,
    availabilityZone: preferred.availabilityZone,
  };
}
