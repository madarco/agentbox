/**
 * Ask OpenSSH what it would do for a destination.
 *
 * An `~/.ssh/config` alias (`buildbox`) is a perfectly good destination on the
 * machine that owns that config, and meaningless anywhere else. Sharing a
 * remote-docker host with a control box therefore has to EXPAND it first:
 * `ssh -G` prints the fully-resolved settings — hostname, user, port, identity
 * files — which is exactly the portable form another machine can dial.
 *
 * `ssh -G` never connects, so this is cheap and safe to run on any input; an
 * unresolvable destination simply comes back as itself.
 */

import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { execa } from 'execa';

export interface SshConfigTarget {
  /** The real hostname/IP ssh would dial (`hostname` in `ssh -G`). */
  host: string;
  user?: string;
  port?: number;
  /** First `identityfile` that actually exists on disk, tilde-expanded. */
  identityFile?: string;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Expand `destination` through `ssh -G`. Returns `null` when ssh is unavailable
 * or the destination doesn't resolve — callers fall back to the raw string,
 * which is what every pre-existing registry entry already relies on.
 *
 * `port` is omitted when it is the default 22 so the expansion stays as close to
 * what the user wrote as possible.
 */
export async function resolveSshConfigTarget(destination: string): Promise<SshConfigTarget | null> {
  let stdout: string;
  try {
    const res = await execa('ssh', ['-G', destination], { reject: false, timeout: 10_000 });
    if (res.exitCode !== 0) return null;
    stdout = res.stdout ?? '';
  } catch {
    return null;
  }

  const fields = new Map<string, string[]>();
  for (const line of stdout.split('\n')) {
    const m = /^([a-z0-9]+)\s+(.+)$/i.exec(line.trim());
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const list = fields.get(key);
    if (list) list.push(m[2]!);
    else fields.set(key, [m[2]!]);
  }

  const host = fields.get('hostname')?.[0]?.trim();
  if (!host) return null;
  const out: SshConfigTarget = { host };

  const user = fields.get('user')?.[0]?.trim();
  if (user) out.user = user;

  const port = Number.parseInt(fields.get('port')?.[0]?.trim() ?? '', 10);
  if (Number.isInteger(port) && port > 0 && port !== 22) out.port = port;

  // ssh prints every candidate identity, including the built-in defaults it
  // would try. Take the first that exists so we name a key the user actually
  // has, rather than `~/.ssh/id_rsa` because ssh always lists it.
  for (const raw of fields.get('identityfile') ?? []) {
    const path = raw.trim().replace(/^~(?=\/)/, homedir());
    if (await fileExists(path)) {
      out.identityFile = path;
      break;
    }
  }
  return out;
}
