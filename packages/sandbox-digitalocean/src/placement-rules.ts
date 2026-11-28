/**
 * DigitalOcean's control-box size warnings, kept in this package rather than
 * in any client. A Droplet slug spells its shape (`s-1vcpu-2gb`), so the
 * 2 vCPU / 4 GB floor is read straight off it; an opaque slug (`c-4`) is not
 * second-guessed.
 */
export function controlPlanePlacementWarnings(size: string): string[] {
  const m = /(\d+)vcpu-(\d+)(gb|mb)/.exec(size.trim().toLowerCase());
  if (!m) return [];
  const vcpus = Number(m[1]);
  const memoryGb = m[3] === 'mb' ? Number(m[2]) / 1024 : Number(m[2]);
  if (vcpus >= 2 && memoryGb >= 4) return [];
  return [
    `${size} is below what the control box needs (it runs the hub and docker). Use s-2vcpu-4gb (2 vCPU / 4 GB) or larger.`,
  ];
}
