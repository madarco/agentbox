/**
 * Push a PC-created cloud box's per-box SSH key material up to the control box's
 * custody store, so the hub/worker/mobile can also reach and manage a box the PC
 * minted (the reverse of `agentbox hub pull`, which downloads a hub-created box's
 * keys onto the PC).
 *
 * Keyed by the provider sandbox id — the same id the on-disk ssh dir and the
 * `hub pull` destination use — so a download lands the bytes back at the exact
 * path attach/cp read. Best-effort: a failed push never breaks create.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { boxSshDirForProvider } from '@agentbox/sandbox-core';

export interface PushBoxSshArgs {
  controlPlaneUrl: string;
  adminToken: string;
  provider: string;
  sandboxId: string;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
}

/**
 * Upload every file in the box's on-disk ssh dir to custody
 * `boxes/<sandboxId>/ssh/<file>`. No-op when the provider mints no per-box key
 * (e2b/vercel/daytona/docker) or the dir is absent. Returns the number of files
 * pushed.
 */
export async function pushBoxSshToCustody(args: PushBoxSshArgs): Promise<number> {
  const log = args.log ?? (() => {});
  const sshDir = boxSshDirForProvider(args.provider, args.sandboxId);
  if (!sshDir) return 0;
  const entries = await readdir(sshDir, { withFileTypes: true }).catch(() => []);
  const files = entries.filter((e) => e.isFile());
  if (files.length === 0) return 0;

  const fetchImpl = args.fetchImpl ?? fetch;
  const base = args.controlPlaneUrl.replace(/\/+$/, '');
  let pushed = 0;
  for (const f of files) {
    try {
      const data = await readFile(join(sshDir, f.name));
      const path = `boxes/${args.sandboxId}/ssh/${f.name}`;
      const res = await fetchImpl(`${base}/admin/custody/${path}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${args.adminToken}`,
        },
        body: JSON.stringify({ data: data.toString('base64') }),
      });
      if (res.ok) {
        pushed += 1;
      } else {
        log(`custody push ${f.name} → ${String(res.status)} (continuing)`);
      }
    } catch (err) {
      log(`custody push ${f.name} failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return pushed;
}
