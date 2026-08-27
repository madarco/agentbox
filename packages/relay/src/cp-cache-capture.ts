/**
 * The PC's half of the cp cache: after it copies a file out to a box, it also
 * files a copy with the control box, so the same request still answers when this
 * machine is asleep.
 *
 * Deliberately a **side effect of a successful copy**, not a step inside it. The
 * copy the user asked for has already happened over the direct path by the time
 * anything here runs; a control box that is full, unreachable or running an
 * older build costs a log line, never the copy. That ordering is the whole
 * design: caching must not be able to break the thing it accelerates.
 */

import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { cpCacheMetaPath, cpCacheTarPath, type CpCacheMeta } from './cp-cache.js';

export interface CpCacheCaptureDeps {
  /** Control box base URL. */
  controlPlaneUrl: string;
  adminToken: string;
  /** Skip anything larger than this (the hub's own blob cap). */
  maxBytes?: number;
  logger?: (line: string) => void;
}

/** Matches the relay's default `custodyMaxBlobBytes`, and `box.cpMaxBytes`. */
const DEFAULT_MAX_CACHE_BYTES = 100 * 1024 * 1024;
const TAR_TIMEOUT_MS = 120_000;
const UPLOAD_TIMEOUT_MS = 300_000;

/**
 * Tar `absPath` and store it (plus its sidecar) under `prefix` on the control
 * box. Returns true when the entry landed.
 *
 * Never throws.
 */
export async function captureCpCacheEntry(
  absPath: string,
  prefix: string,
  deps: CpCacheCaptureDeps,
  /**
   * The path AS REQUESTED, which is what the key is derived from — the resolved
   * `absPath` is only what gets tarred. The two differ on every relative
   * request, and keying on the resolved one is unreadable to the control box
   * (see {@link cpCacheKeyInput}). Defaults to `absPath` for an absolute
   * request, where they are the same string.
   */
  requestPath: string = absPath,
): Promise<boolean> {
  const log = deps.logger ?? ((): void => {});
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_CACHE_BYTES;
  let workDir: string | undefined;
  try {
    const info = await stat(absPath);
    const dir = await mkdtemp(join(tmpdir(), 'agentbox-cp-cache-'));
    workDir = dir;
    const tarPath = join(dir, 'entry.tar');
    // -C the parent + a bare name, so the archive holds `q3.csv` rather than
    // `Users/marco/data/q3.csv` and unpacks anywhere.
    await run('tar', ['-cf', tarPath, '-C', dirname(absPath), basename(absPath)], TAR_TIMEOUT_MS);
    const tarInfo = await stat(tarPath);
    if (tarInfo.size > maxBytes) {
      // Silence here would read as "cached" and turn into a confusing miss
      // later, when the machine is offline and nobody can investigate.
      log(
        `cp cache: skipping ${absPath} — ${String(tarInfo.size)} bytes exceeds the hub's ${String(maxBytes)}-byte limit`,
      );
      return false;
    }
    const meta: CpCacheMeta = {
      sourcePath: absPath,
      isDir: info.isDirectory(),
      capturedAt: new Date().toISOString(),
      size: tarInfo.size,
      capturedOn: hostname(),
    };
    const base = deps.controlPlaneUrl.replace(/\/+$/, '');
    await putBlob(
      `${base}/admin/custody-blob/${cpCacheTarPath(prefix, requestPath)}`,
      tarPath,
      deps.adminToken,
    );
    await putJson(
      `${base}/admin/custody/${cpCacheMetaPath(prefix, requestPath)}`,
      { data: Buffer.from(JSON.stringify(meta), 'utf8').toString('base64') },
      deps.adminToken,
    );
    log(`cp cache: stored ${absPath} (${String(tarInfo.size)} bytes) for offline use`);
    return true;
  } catch (err) {
    log(
      `cp cache: could not store ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  } finally {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

function run(bin: string, args: string[], timeout: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(bin, args, { timeout }, (err) => (err ? reject(err) : resolve()));
  });
}

/** Stream a file to the custody blob surface. */
function putBlob(url: string, filePath: string, token: string): Promise<void> {
  const target = new URL(url);
  const isHttps = target.protocol === 'https:';
  const transport = isHttps ? httpsRequest : httpRequest;
  return new Promise<void>((resolve, reject) => {
    const req = transport(
      {
        host: target.hostname,
        port: target.port.length > 0 ? Number.parseInt(target.port, 10) : isHttps ? 443 : 80,
        method: 'PUT',
        path: target.pathname,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
        },
        timeout: UPLOAD_TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) resolve();
        else reject(new Error(`custody blob PUT → ${String(status)}`));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('custody blob PUT timed out'));
    });
    createReadStream(filePath).pipe(req);
  });
}

function putJson(url: string, body: unknown, token: string): Promise<void> {
  const target = new URL(url);
  const isHttps = target.protocol === 'https:';
  const transport = isHttps ? httpsRequest : httpRequest;
  const payload = JSON.stringify(body);
  return new Promise<void>((resolve, reject) => {
    const req = transport(
      {
        host: target.hostname,
        port: target.port.length > 0 ? Number.parseInt(target.port, 10) : isHttps ? 443 : 80,
        method: 'PUT',
        path: target.pathname,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload).toString(),
        },
        timeout: UPLOAD_TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) resolve();
        else reject(new Error(`custody PUT → ${String(status)}`));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('custody PUT timed out'));
    });
    req.write(payload);
    req.end();
  });
}
