/**
 * Which providers are "a VPS we reach over our own SSH ControlMaster".
 *
 * These three share a shape that matters to several commands: a real sshd, a
 * per-box private key held on this host, and a per-box cloud firewall locked to
 * the host's egress IP. That combination is what makes persistent-SSH attach,
 * Remote-SSH / Dev Containers, sshfs mounts, the Portless default, and the
 * egress-IP self-heal all applicable — and it is exactly what the public-URL
 * clouds (daytona / vercel / e2b) do NOT have.
 *
 * Before this existed each of those call sites hardcoded `=== 'hetzner'`, so
 * DigitalOcean silently lost `agentbox open --codex`, Remote-SSH, the sshfs
 * mount and the firewall self-heal despite being the same kind of box. Adding a
 * provider here is now the one edit.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';

export const VPS_PROVIDERS: readonly string[] = ['hetzner', 'digitalocean', 'aws'];

export function isVpsProvider(provider: string | undefined): boolean {
  return VPS_PROVIDERS.includes(provider ?? '');
}

/**
 * The per-box SSH private key for a VPS provider, or null for anything else.
 *
 * Mirrors each package's `defaultBoxSshDir`, kept inline so `recover` doesn't
 * statically pull a provider SDK just to check whether a file exists. A missing
 * key means the box was created on a different host and cannot be driven from
 * here.
 *
 * NB the paths are NOT uniform: hetzner predates the per-provider namespace and
 * still lives at `~/.agentbox/boxes/…`, while the newer providers namespace
 * under `~/.agentbox/<provider>/boxes/…` so two providers' ids can't collide.
 */
export function vpsBoxKeyPath(provider: string | undefined, sandboxId: string): string | null {
  switch (provider) {
    case 'hetzner':
      return join(homedir(), '.agentbox', 'boxes', sandboxId, 'ssh', 'id_ed25519');
    case 'digitalocean':
    case 'aws':
      return join(homedir(), '.agentbox', provider, 'boxes', sandboxId, 'ssh', 'id_ed25519');
    default:
      return null;
  }
}
