/**
 * `agentbox hub pull <box>` — download a hub-created box's per-box SSH key
 * material from the control box's custody store into the PC's on-disk ssh dir
 * (`~/.agentbox/[<namespace>/]boxes/<sandboxId>/ssh/`), so `attach` / port
 * forwards / `cp` work exactly as for a PC-created box.
 *
 * Keyed by the provider sandbox id (from the box's control-box registration),
 * which is the id both the on-disk ssh dir and the custody `boxes/<id>/ssh/`
 * subtree use — so the bytes land at the exact path attach/cp read.
 */
import { basename } from 'node:path';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { boxSshDirForProvider, defaultBoxSshDir } from '@agentbox/sandbox-core';
import type { CustodyClient } from './custody-client.js';
import type { HubApiBox } from './hub-api-client.js';

export interface HubPullResult {
  /** The id the keys are stored under (sandboxId, or the box id as a fallback). */
  key: string;
  /** On-disk directory the keys were written to. */
  dest: string;
  /** Basenames of the files written. */
  files: string[];
}

export interface HubPullArgs {
  custody: CustodyClient;
  /** The box as `GET /api/v1/boxes?ref=` resolved it (the ref is matched server-side). */
  box: HubApiBox;
}

/**
 * Download every file under custody `boxes/<key>/ssh/` for a resolved hub box
 * into the matching on-disk ssh dir. Keyed by the box's sandbox id + provider,
 * from the SAME resolved payload adoption uses — so a ref that resolves to a box
 * can't land its keys under a different id's dir/custody subtree. Pure of any
 * command-layer concern (logging/exit codes) so it is unit-testable with a fake
 * custody client + a temp HOME.
 */
export async function pullBoxSshKeys(args: HubPullArgs): Promise<HubPullResult> {
  const provider = args.box.provider;
  const key = args.box.sandboxId ?? args.box.id;
  const files = await downloadBoxSshKeys({ custody: args.custody, provider, key });
  return { key, dest: sshDestFor(provider, key), files };
}

/** The on-disk ssh dir for a box, provider-namespaced when the provider has one. */
function sshDestFor(provider: string | undefined, key: string): string {
  return (provider ? boxSshDirForProvider(provider, key) : null) ?? defaultBoxSshDir(key);
}

/**
 * Download every file under custody `boxes/<key>/ssh/` into the box's on-disk
 * ssh dir. Takes the ALREADY-RESOLVED provider + key rather than a ref, so a
 * caller that has the registration in hand (adoption) can't re-resolve it
 * differently — and doesn't pay for a second registry fetch.
 */
export async function downloadBoxSshKeys(args: {
  custody: CustodyClient;
  /** Backend name from the registration; undefined → the un-namespaced default dir. */
  provider: string | undefined;
  /** Sandbox id (the id both the ssh dir and the custody subtree are keyed by). */
  key: string;
}): Promise<string[]> {
  const dest = sshDestFor(args.provider, args.key);
  const entries = await args.custody.list(`boxes/${args.key}/ssh`);
  const files: string[] = [];
  if (entries.length > 0) await mkdir(dest, { recursive: true, mode: 0o700 });
  for (const e of entries) {
    const data = await args.custody.get(e.path);
    if (data === null) continue;
    const name = basename(e.path);
    const out = `${dest}/${name}`;
    await writeFile(out, data, { mode: 0o600 });
    await chmod(out, 0o600);
    files.push(name);
  }
  return files;
}
