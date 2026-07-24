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
import type { ControlPlaneAdminClient } from './admin-client.js';
import { matchRegistration } from './match-ref.js';

export interface HubPullResult {
  /** The id the keys are stored under (sandboxId, or the box id as a fallback). */
  key: string;
  /** On-disk directory the keys were written to. */
  dest: string;
  /** Basenames of the files written. */
  files: string[];
  /** True when the box was found in the control box's registry. */
  registered: boolean;
}

export interface HubPullArgs {
  admin: ControlPlaneAdminClient;
  custody: CustodyClient;
  /** Box id or name as shown by `control-plane boxes list`. */
  box: string;
}

/**
 * Resolve the box → its sandbox id + provider, then download every file under
 * custody `boxes/<key>/ssh/` into the matching on-disk ssh dir. Pure of any
 * command-layer concern (logging/exit codes) so it is unit-testable with a fake
 * fetch + a temp HOME.
 */
export async function pullBoxSshKeys(args: HubPullArgs): Promise<HubPullResult> {
  const boxes = await args.admin.listBoxes();
  // The SAME matcher adoption uses. Resolving refs differently here is not a
  // cosmetic inconsistency: a ref this missed but adoption matched lost
  // `provider` and fell back to `args.box` as the key — writing one box's keys
  // into another id's on-disk dir and custody subtree.
  const reg = matchRegistration(boxes, args.box);
  const key = reg?.sandboxId ?? reg?.boxId ?? args.box;
  const files = await downloadBoxSshKeys({
    custody: args.custody,
    provider: reg?.backend,
    key,
  });
  return { key, dest: sshDestFor(reg?.backend, key), files, registered: reg !== undefined };
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
