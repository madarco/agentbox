/**
 * Per-box SSH key minting, shared by every provider that authenticates a box
 * over SSH by identity file: the docker localhost sshd and the Hetzner VPS both
 * mint a fresh ed25519 keypair per box and never let the private key leave the
 * host. The public key is installed into the box's `authorized_keys` (docker via
 * `docker exec`, Hetzner via cloud-init).
 */

import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execa } from 'execa';

export interface MintedSshKey {
  /** Directory holding the key files. */
  dir: string;
  /** Absolute path to the private key. */
  privatePath: string;
  /** Absolute path to the public key. */
  publicPath: string;
  /** Public key contents (one OpenSSH-format line). */
  publicKey: string;
}

/**
 * Mint a fresh ed25519 keypair into `targetDir/id_ed25519` (+ `.pub`). The
 * directory is created if missing (0700). `comment` is embedded in the public
 * key so the key is identifiable in `authorized_keys` on a forensic look.
 *
 * Reuses the existing keypair when `targetDir/id_ed25519` is already present
 * (idempotent across `agentbox start`), reading its `.pub` back — callers on the
 * restart path can call this blindly without clobbering the key the box already
 * trusts.
 */
export async function mintSshKey(targetDir: string, comment: string): Promise<MintedSshKey> {
  const dir = resolve(targetDir);
  const priv = join(dir, 'id_ed25519');
  const pub = `${priv}.pub`;
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const existing = await readFile(pub, 'utf8').catch(() => null);
  if (existing !== null) {
    return { dir, privatePath: priv, publicPath: pub, publicKey: existing.trim() };
  }

  // `ssh-keygen -N ''` for no passphrase; `-q` to suppress the random art.
  await execa('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', comment, '-f', priv, '-q'], {
    stdio: 'pipe',
  });

  const publicKey = (await readFile(pub, 'utf8')).trim();
  return { dir, privatePath: priv, publicPath: pub, publicKey };
}
