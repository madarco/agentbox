/**
 * The shared IPv4-only egress detector (`@agentbox/sandbox-core`) plus the
 * override hints its failure message ends with. A hint names only what the
 * calling command really honours, so each call site passes its own; a step
 * with no override (prepare, control-plane deploy) passes none.
 */

export {
  detectEgressCidr,
  detectEgressIp,
  type DetectEgressIpOptions,
} from '@agentbox/sandbox-core';

/** `create`: the env override and `--inbound open` both skip detection. */
export const CREATE_EGRESS_HINT =
  'Override with AGENTBOX_HETZNER_FIREWALL_SOURCE=<ipv4-cidr>, or create the box with --inbound open.';

/** `agentbox hetzner firewall sync`: its own flag. */
export const SYNC_EGRESS_HINT = 'Pass the address yourself with --source <ipv4-cidr>.';

/** `agentbox inbound <box> lock|whitelist`: only `open` skips detection. */
export const INBOUND_EGRESS_HINT =
  'Use `agentbox inbound <box> open`, or set the rule by hand with `agentbox hetzner firewall sync <box> --source <ipv4-cidr>`.';

/** Automatic firewall repair on a connection failure. */
export const REPAIR_EGRESS_HINT =
  'Set the rule by hand with `agentbox hetzner firewall sync <box> --source <ipv4-cidr>`.';
