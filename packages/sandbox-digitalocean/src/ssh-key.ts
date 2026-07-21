/**
 * Per-box (and per-prepare-run) SSH key minting.
 *
 * AgentBox mints a fresh ed25519 keypair per box at provision time. The
 * private key never leaves the host; the public key is shipped to the VPS
 * via cloud-init `users:` (NOT the DigitalOcean SSH-keys-import API, which
 * would make the same pubkey available to attach to other VPSes the user
 * provisions — see the plan's §"Key & key-lifecycle hygiene").
 *
 * Storage layout (per the plan):
 *   ~/.agentbox/boxes/<box-id>/ssh/
 *     id_ed25519        (private, 0600)
 *     id_ed25519.pub    (public, 0644)
 *     known_hosts       (per-box, populated post-first-connect)
 *     control.sock      (ssh ControlMaster socket — created at runtime)
 *
 * For the temp prepare VPS we use a parallel path:
 *   ~/.agentbox/digitalocean/prepare-<timestamp>/
 * deleted after the snapshot completes.
 */

import { dirname, resolve } from 'node:path';
import { mintSshKey, type MintedSshKey } from '@agentbox/sandbox-core';

// `mintSshKey` / `MintedSshKey` are provider-neutral and now live in
// `@agentbox/sandbox-core` (shared with the docker localhost sshd and the
// Hetzner backend). Re-exported here so the DigitalOcean-internal call sites
// keep importing from `./ssh-key.js`.
export { mintSshKey, type MintedSshKey };

/**
 * Mint a temporary keypair for the prepare orchestrator. Returns the same
 * shape as `mintSshKey` plus a `cleanup()` that rm -rf's the directory.
 * The caller is expected to call `cleanup()` in a `finally` block.
 */
export async function mintPrepareKey(): Promise<MintedSshKey & { cleanup: () => Promise<void> }> {
  const root = resolve(homedirOrCwd(), '.agentbox', 'digitalocean', `prepare-${Date.now().toString(36)}`);
  const key = await mintSshKey(root, `agentbox-prepare-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  return {
    ...key,
    cleanup: async () => {
      try {
        const { rm } = await import('node:fs/promises');
        await rm(dirname(key.privatePath), { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}

function homedirOrCwd(): string {
  try {
    // Lazy require so this module is import-safe even if `os` is shimmed
    // away in some weird bundle environment.
    return process.env.HOME ?? process.cwd();
  } catch {
    return process.cwd();
  }
}
