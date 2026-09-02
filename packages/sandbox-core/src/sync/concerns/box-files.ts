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

/**
 * Raw bytes of path list allowed in ONE exec. The list rides in as a single
 * base64 `printf` argument, and Linux caps a single argv entry at
 * `MAX_ARG_STRLEN` = 128 KiB — the whole script, not just the payload. base64
 * costs 4/3, so 48 KiB raw is a 64 KiB argument and leaves the rest of the
 * script (plus the `sudo -u vscode -H bash -lc '…'` wrapper Vercel and E2B add)
 * a wide margin. Without chunking, `clone` / cloud `download` / non-git `sync`
 * simply fail on any workspace with a few thousand files — i.e. a normal repo.
 */
const MAX_PAYLOAD_BYTES = 48 * 1024;

/**
 * Split `paths` into groups whose NUL-terminated encoding fits one exec.
 * A single path longer than the budget still gets its own chunk — one
 * oversized argument is the kernel's problem to report, not something to
 * silently drop.
 */
export function chunkPathsForExec(
  paths: readonly string[],
  maxBytes: number = MAX_PAYLOAD_BYTES,
): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const p of paths) {
    const cost = Buffer.byteLength(p, 'utf8') + 1; // + the NUL terminator
    if (current.length > 0 && size + cost > maxBytes) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(p);
    size += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
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
      //
      // Chunked because that payload is ONE argv entry (see MAX_PAYLOAD_BYTES).
      // The first chunk creates the archive, the rest APPEND to it — `tar -r`
      // works precisely because REMOTE_TAR is uncompressed.
      const chunks = chunkPathsForExec(relPaths);
      const first = await run(`rm -f ${sq(REMOTE_TAR)}`);
      if (first.exitCode !== 0) {
        throw new Error(`clearing ${REMOTE_TAR} failed: ${first.stderr || first.stdout}`);
      }
      let created = false;
      for (const chunk of chunks) {
        const payload = Buffer.from(nulTerminated(chunk)).toString('base64');
        const packed = await run(
          [
            `set -e`,
            `printf %s ${sq(payload)} | base64 -d | ` +
              `tar -C ${sq(boxDir)} --null -T - ${created ? '-rf' : '-cf'} ${sq(REMOTE_TAR)}`,
          ].join('\n'),
        );
        if (packed.exitCode !== 0) {
          throw new Error(`packing ${boxDir} failed: ${packed.stderr || packed.stdout}`);
        }
        created = true;
      }
      if (!created) {
        // Nothing selected: still hand back a well-formed (empty) archive rather
        // than downloading a file the box never wrote.
        const empty = await run(`tar -C ${sq(boxDir)} --null -T /dev/null -cf ${sq(REMOTE_TAR)}`);
        if (empty.exitCode !== 0) {
          throw new Error(`packing ${boxDir} failed: ${empty.stderr || empty.stdout}`);
        }
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

/** A probe that could not answer. Callers must abort, never assume an answer. */
export class BoxProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoxProbeError';
  }
}

/**
 * The box half of a non-git workspace overlay, over {@link BoxFilePorts}.
 *
 * The probe emits `<token>\0<path>\0` pairs: the sha256 for a regular file, the
 * non-regular sentinel for anything else that exists, and nothing at all when
 * the path is absent — exactly what `classifyUntrackedOverlay` consumes. Paths
 * ride in base64-encoded for the same reason `pullTar`'s do, and are chunked for
 * the same reason too.
 *
 * **Fail-closed.** A non-zero probe THROWS instead of returning what it managed
 * to collect. The overlay reads a missing key as "the box does not have this
 * path" and copies the host's file over it, so a degraded probe is
 * indistinguishable from an empty box — and would silently overwrite in-box
 * work, the exact inverse of the box-wins contract. An unreadable answer is not
 * an empty answer.
 */
export function boxOverlayPorts(ports: BoxFilePorts, boxDir: string): WorkspaceOverlayPorts {
  return {
    async probeBoxTokens(relPaths: string[]): Promise<Map<string, string>> {
      const tokens = new Map<string, string>();
      if (relPaths.length === 0) return tokens;
      for (const chunk of chunkPathsForExec(relPaths)) {
        // Trailing NUL is load-bearing: `read -d ''` treats an unterminated tail
        // as EOF, so `join` alone silently drops the last path — which the
        // overlay would then read as "absent in the box" and overwrite.
        const payload = Buffer.from(nulTerminated(chunk)).toString('base64');
        const script =
          `printf %s ${sq(payload)} | base64 -d | ( cd ${sq(boxDir)} && ` +
          `while IFS= read -r -d '' f; do ` +
          `if [ -f "$f" ] && [ ! -L "$f" ]; then printf '%s\\0%s\\0' "$(sha256sum < "$f" | cut -d' ' -f1)" "$f"; ` +
          `elif [ -e "$f" ] || [ -L "$f" ]; then printf '%s\\0%s\\0' ${sq(NON_REGULAR_TOKEN)} "$f"; fi; done )`;
        const r = await ports.run(script, { asRoot: true });
        if (r.exitCode !== 0) {
          throw new BoxProbeError(
            `could not read ${boxDir} in the box (exit ${String(r.exitCode)}): ` +
              `${r.stderr || r.stdout || 'no output'}\n` +
              `Refusing to sync: without the box's file list every host file would ` +
              `look new and overwrite the box's version.`,
          );
        }
        const flat = r.stdout.split('\0').filter((s) => s.length > 0);
        for (let i = 0; i + 1 < flat.length; i += 2) {
          const token = flat[i];
          const path = flat[i + 1];
          if (token !== undefined && path !== undefined) tokens.set(path, token);
        }
      }
      return tokens;
    },
    applyTarToBox: (tar: Buffer) => ports.pushTar(boxDir, tar),
  };
}
