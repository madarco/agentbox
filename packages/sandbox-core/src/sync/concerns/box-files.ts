/**
 * Concern: box files — the two primitives every workspace file operation needs
 * from a box (run a shell script, move one tar in or out), expressed over the
 * `Provider` surface rather than over a provider-native transport.
 *
 * `agentbox sync` / `download` / `clone` all move whole trees, and every
 * provider already implements `exec` + `uploadPath` + `downloadPath`. Driving
 * them through those three keeps the non-git sync leg and the cloud pull as ONE
 * implementation instead of a docker copy and a cloud copy — which is exactly
 * the drift `docs/sync-architecture.md` exists to prevent.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BoxRecord, ExecResult, Provider } from '@agentbox/core';
import { NON_REGULAR_TOKEN } from './git.js';
import type { WorkspaceOverlayPorts } from './workspace-files.js';

/** Remote staging path for one tar hop. Reused per call; removed in-box after. */
const REMOTE_TAR = '/tmp/agentbox-workspace-xfer.tar';

export interface BoxFilePorts {
  /** Run a shell script in the box. `asRoot` for read-only probes (see below). */
  run(script: string, opts?: { asRoot?: boolean }): Promise<ExecResult>;
  /** Extract a tar buffer into `boxDir` inside the box. */
  pushTar(boxDir: string, tar: Buffer): Promise<void>;
  /** Pack `relPaths` (relative to `boxDir`) in the box and return the tar. */
  pullTar(boxDir: string, relPaths: string[]): Promise<Buffer>;
}

/** NUL-SEPARATED and NUL-TERMINATED — the shape `read -d ''` / `tar --null` want. */
function nulTerminated(paths: string[]): string {
  return paths.length === 0 ? '' : `${paths.join('\0')}\0`;
}

/** Single-quote a value for the POSIX shell. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the ports for one box over its provider.
 *
 * `asRoot` matters on Vercel and E2B: those backends wrap a non-root exec in
 * `sudo -u vscode -H bash -lc`, and the extra re-parse mangles a script's
 * `$(...)` / `while` (the resync probe hangs on it — see
 * `sandbox-cloud/src/sync/workspace-resync.ts`). Read-only probes therefore run
 * as root, which is a single `bash -lc` with no re-parse. Writes stay as the box
 * user so the extracted files are owned by the agent.
 */
export function providerBoxFilePorts(provider: Provider, box: BoxRecord): BoxFilePorts {
  const run = async (script: string, opts?: { asRoot?: boolean }): Promise<ExecResult> =>
    provider.exec(box, ['bash', '-c', script], opts?.asRoot ? { user: 'root' } : undefined);

  return {
    run,
    async pushTar(boxDir: string, tar: Buffer): Promise<void> {
      if (!provider.uploadPath) {
        throw new Error(`provider '${provider.name}' cannot upload files into a box`);
      }
      const stage = await mkdtemp(join(tmpdir(), 'agentbox-xfer-'));
      const local = join(stage, 'payload.tar');
      try {
        await writeFile(local, tar);
        await provider.uploadPath(box, [local], REMOTE_TAR);
        const r = await run(
          `set -e\ntar -C ${sq(boxDir)} -xf ${sq(REMOTE_TAR)}\nrm -f ${sq(REMOTE_TAR)}`,
        );
        if (r.exitCode !== 0) {
          throw new Error(`extract into ${boxDir} failed: ${r.stderr || r.stdout}`);
        }
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
    },
    async pullTar(boxDir: string, relPaths: string[]): Promise<Buffer> {
      if (!provider.downloadPath) {
        throw new Error(`provider '${provider.name}' cannot download files from a box`);
      }
      // The path list goes in base64-encoded: `backend.exec` has no stdin, and a
      // Vercel box has no `/dev/fd` for process substitution (see
      // `docs/cloud-providers.md`). `tar --null -T -` then reads it from a pipe.
      // TERMINATED, not joined: an unterminated final record is not a record,
      // and the reader silently drops it.
      const payload = Buffer.from(nulTerminated(relPaths)).toString('base64');
      const script = [
        `set -e`,
        `rm -f ${sq(REMOTE_TAR)}`,
        `printf %s ${sq(payload)} | base64 -d | tar -C ${sq(boxDir)} --null -T - -cf ${sq(REMOTE_TAR)}`,
      ].join('\n');
      const packed = await run(script);
      if (packed.exitCode !== 0) {
        throw new Error(`packing ${boxDir} failed: ${packed.stderr || packed.stdout}`);
      }
      const stage = await mkdtemp(join(tmpdir(), 'agentbox-xfer-'));
      const local = join(stage, 'payload.tar');
      try {
        await provider.downloadPath(box, [REMOTE_TAR], local);
        const buf = await readFile(local);
        await run(`rm -f ${sq(REMOTE_TAR)}`).catch(() => undefined);
        return buf;
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
    },
  };
}

/**
 * The box half of a non-git workspace overlay, over {@link BoxFilePorts}.
 *
 * The probe emits `<token>\0<path>\0` pairs: the sha256 for a regular file, the
 * non-regular sentinel for anything else that exists, and nothing at all when
 * the path is absent — exactly what `classifyUntrackedOverlay` consumes. Paths
 * ride in base64-encoded for the same reason `pullTar`'s do.
 */
export function boxOverlayPorts(ports: BoxFilePorts, boxDir: string): WorkspaceOverlayPorts {
  return {
    async probeBoxTokens(relPaths: string[]): Promise<Map<string, string>> {
      const tokens = new Map<string, string>();
      if (relPaths.length === 0) return tokens;
      // Trailing NUL is load-bearing: `read -d ''` treats an unterminated tail
      // as EOF, so `join` alone silently drops the last path — which the overlay
      // would then read as "absent in the box" and overwrite.
      const payload = Buffer.from(nulTerminated(relPaths)).toString('base64');
      const script =
        `printf %s ${sq(payload)} | base64 -d | ( cd ${sq(boxDir)} && ` +
        `while IFS= read -r -d '' f; do ` +
        `if [ -f "$f" ] && [ ! -L "$f" ]; then printf '%s\\0%s\\0' "$(sha256sum < "$f" | cut -d' ' -f1)" "$f"; ` +
        `elif [ -e "$f" ] || [ -L "$f" ]; then printf '%s\\0%s\\0' ${sq(NON_REGULAR_TOKEN)} "$f"; fi; done )`;
      const r = await ports.run(script, { asRoot: true });
      if (r.exitCode !== 0) return tokens;
      const flat = r.stdout.split('\0').filter((s) => s.length > 0);
      for (let i = 0; i + 1 < flat.length; i += 2) {
        const token = flat[i];
        const path = flat[i + 1];
        if (token !== undefined && path !== undefined) tokens.set(path, token);
      }
      return tokens;
    },
    applyTarToBox: (tar: Buffer) => ports.pushTar(boxDir, tar),
  };
}
