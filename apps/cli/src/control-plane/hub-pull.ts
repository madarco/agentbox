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
  const reg = boxes.find((b) => b.boxId === args.box || b.name === args.box);
  const key = reg?.sandboxId ?? reg?.boxId ?? args.box;
  const provider = reg?.backend;
  const dest = (provider ? boxSshDirForProvider(provider, key) : null) ?? defaultBoxSshDir(key);

  const entries = await args.custody.list(`boxes/${key}/ssh`);
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
  return { key, dest, files, registered: reg !== undefined };
}
