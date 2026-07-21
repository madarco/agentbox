import { homedir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import type { BoxResourceLimits, BoxResourceStats } from '@agentbox/core';
import { CHECKPOINT_IMAGE_PREFIX, checkpointImageTag } from './checkpoint.js';
import {
  inspectContainer,
  inspectContainerStatus,
  inspectVolumeMountpoint,
} from './docker.js';
import { detectEngine } from './sync/host-export.js';
import type { BoxRecord } from './state.js';

/**
 * Parse one of Docker's human-formatted size tokens (`512MiB`, `1.2kB`,
 * `3.4GB`, `0B`, `--`). Returns null when unparseable. Docker mixes binary
 * (`KiB/MiB/GiB`) and decimal (`kB/MB/GB`) suffixes depending on the column, so
 * we handle both.
 */
export function parseDockerSize(raw: string): number | null {
  const s = raw.trim();
  if (!s || s === '--' || s === 'N/A') return null;
  const m = /^([\d.]+)\s*([A-Za-z]*)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? '').toLowerCase();
  const mult: Record<string, number> = {
    '': 1,
    b: 1,
    kb: 1e3,
    mb: 1e6,
    gb: 1e9,
    tb: 1e12,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
  };
  const factor = mult[unit];
  return factor === undefined ? null : n * factor;
}

function parsePercent(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw.replace('%', '').trim());
  return Number.isFinite(n) ? n : null;
}

/** Split Docker's "<a> / <b>" pair columns (MemUsage, NetIO, BlockIO). */
function splitPair(raw: string | undefined): [string, string] | null {
  if (!raw) return null;
  const parts = raw.split('/');
  if (parts.length !== 2) return null;
  return [parts[0]!.trim(), parts[1]!.trim()];
}

async function duBytes(path: string): Promise<number | null> {
  const result = await execa('du', ['-sk', path], { reject: false });
  if (result.exitCode !== 0) return null;
  const kb = Number.parseInt((result.stdout ?? '').split(/\s+/)[0] ?? '', 10);
  return Number.isNaN(kb) ? null : kb * 1024;
}

/**
 * Best-effort on-host byte size of a Docker named volume. Fastest path first:
 *   1. OrbStack exposes volumes live at ~/OrbStack/docker/volumes/<name>/.
 *   2. `docker system df -v` (cheap-walked once; may report "N/A").
 *   3. The reported mountpoint, only when host-readable (Linux native Docker).
 * Returns null when no path is reachable from the host (the macOS VM case
 * where `system df` also has no number).
 */
export async function volumeSizeBytes(name: string): Promise<number | null> {
  if (!name) return null;
  const engine = await detectEngine();
  if (engine === 'orbstack') {
    const live = join(homedir(), 'OrbStack', 'docker', 'volumes', name);
    const sz = await duBytes(live);
    if (sz !== null) return sz;
  }
  const df = await execa(
    'docker',
    ['system', 'df', '-v', '--format', '{{json .Volumes}}'],
    { reject: false },
  );
  if (df.exitCode === 0) {
    try {
      const vols = JSON.parse(df.stdout || '[]') as Array<{ Name?: string; Size?: string }>;
      const hit = vols.find((v) => v.Name === name);
      const parsed = hit?.Size ? parseDockerSize(hit.Size) : null;
      if (parsed !== null) return parsed;
    } catch {
      // fall through to mountpoint
    }
  }
  const mp = await inspectVolumeMountpoint(name);
  if (mp && !mp.startsWith('/var/lib/docker')) {
    return duBytes(mp);
  }
  return null;
}

/**
 * On-host byte size of a Docker image (sum of its own layer sizes — what
 * `docker images` reports). Null on docker errors.
 */
async function imageBytes(tag: string): Promise<number | null> {
  const r = await execa('docker', ['image', 'inspect', tag, '--format', '{{.Size}}'], {
    reject: false,
  });
  if (r.exitCode !== 0) return null;
  const n = Number.parseInt((r.stdout ?? '').trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Size of a project's most-recent checkpoint image (the head of the lineage,
 * resolved via the `checkpointImageTag` helper from a checkpoint *name*). The
 * caller passes the name because we don't enumerate manifests from this
 * module — that lives in checkpoint.ts. Null when the image isn't present.
 */
export async function projectCheckpointImageBytes(
  projectRoot: string,
  name: string,
): Promise<number | null> {
  return imageBytes(checkpointImageTag(projectRoot, name));
}

/**
 * Total on-host bytes of every checkpoint image (the durable, cross-box
 * warm-state assets). Walks every image tag under `CHECKPOINT_IMAGE_PREFIX`.
 * Null when none exist.
 */
export async function allCheckpointImagesBytes(): Promise<number | null> {
  const r = await execa(
    'docker',
    [
      'image',
      'ls',
      '--format',
      '{{.Repository}}:{{.Tag}}\t{{.Size}}',
      `${CHECKPOINT_IMAGE_PREFIX}*`,
    ],
    { reject: false },
  );
  if (r.exitCode !== 0) return null;
  const lines = (r.stdout ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (lines.length === 0) return null;
  let total = 0;
  let any = false;
  for (const line of lines) {
    const [, size] = line.split('\t');
    const n = size ? parseDockerSize(size) : null;
    if (n !== null) {
      total += n;
      any = true;
    }
  }
  return any ? total : null;
}

/** On-host byte size of the whole ~/.agentbox state/runtime directory. */
export async function agentboxHomeBytes(): Promise<number | null> {
  return duBytes(join(homedir(), '.agentbox'));
}

function limitsFromRecord(record: BoxRecord): BoxResourceLimits {
  const r = record.resourceLimits;
  return {
    memoryBytes: r?.memoryBytes && r.memoryBytes > 0 ? r.memoryBytes : null,
    cpus: r?.cpus && r.cpus > 0 ? r.cpus : null,
    pidsLimit: r?.pidsLimit && r.pidsLimit > 0 ? r.pidsLimit : null,
    disk: r?.disk || null,
  };
}

/**
 * Cross-check persisted limits against the live container's HostConfig so an
 * externally `docker update`d box still reports the truth. The persisted
 * record stays the fallback when the container is gone.
 */
function reconcileLimits(persisted: BoxResourceLimits, dockerJson: unknown): BoxResourceLimits {
  const hc = (dockerJson as { HostConfig?: Record<string, unknown> } | null)?.HostConfig;
  if (!hc) return persisted;
  const mem = typeof hc.Memory === 'number' && hc.Memory > 0 ? hc.Memory : null;
  const nano = typeof hc.NanoCpus === 'number' && hc.NanoCpus > 0 ? hc.NanoCpus : null;
  const pids = typeof hc.PidsLimit === 'number' && hc.PidsLimit > 0 ? hc.PidsLimit : null;
  return {
    memoryBytes: mem ?? persisted.memoryBytes,
    cpus: nano ? nano / 1e9 : persisted.cpus,
    pidsLimit: pids ?? persisted.pidsLimit,
    disk: persisted.disk,
  };
}

interface DockerStatsLine {
  CPUPerc?: string;
  MemUsage?: string;
  MemPerc?: string;
  PIDs?: string;
  NetIO?: string;
  BlockIO?: string;
}

/**
 * Container writable-layer size from `docker ps --size`. With the overlay
 * gone, `/workspace` lives here (not in a named volume), so this is the
 * box's primary writable-surface number.
 */
async function containerWritableBytes(container: string): Promise<number | null> {
  const r = await execa(
    'docker',
    ['ps', '-a', '--filter', `name=^${container}$`, '--format', '{{.Size}}', '--size'],
    { reject: false },
  );
  if (r.exitCode !== 0) return null;
  // `--size` produces `<rw> (virtual <total>)`; we want the first number.
  const first = (r.stdout ?? '').split('\n')[0]?.trim();
  if (!first) return null;
  const m = /^([^()]+?)(?:\s*\(.*\))?$/.exec(first);
  const sz = m ? m[1]!.trim() : first;
  return parseDockerSize(sz);
}

/**
 * Provider-agnostic resource snapshot for a box. CPU/mem/pids/IO come from
 * `docker stats --no-stream` (point-in-time sample; only when the container is
 * running). Disk is the container's writable layer (where `/workspace` lives
 * now that the overlay is gone) plus the in-box dockerd's data-root volume;
 * the per-box host snapshot dir and the checkpoint image lineage are
 * reported on their own fields.
 */
export async function boxResourceStats(record: BoxRecord): Promise<BoxResourceStats> {
  const warnings: string[] = [];
  const dockerJson = await inspectContainer(record.container);
  const limits = reconcileLimits(limitsFromRecord(record), dockerJson);

  const [diskContainer, diskDocker, snapshotDiskBytes, checkpointImageBytesValue] =
    await Promise.all([
      containerWritableBytes(record.container),
      record.dockerVolume ? volumeSizeBytes(record.dockerVolume) : Promise.resolve(null),
      record.snapshotDir ? duBytes(record.snapshotDir) : Promise.resolve(null),
      record.checkpointImage ? imageBytes(record.checkpointImage) : Promise.resolve(null),
    ]);
  const diskUsedBytes =
    diskContainer === null && diskDocker === null
      ? null
      : (diskContainer ?? 0) + (diskDocker ?? 0);
  if (diskUsedBytes === null) {
    warnings.push('disk usage unavailable on this engine');
  }

  const base: BoxResourceStats = {
    source: 'docker',
    live: false,
    cpuPercent: null,
    memUsedBytes: null,
    memLimitBytes: limits.memoryBytes,
    memPercent: null,
    pids: null,
    diskUsedBytes,
    snapshotDiskBytes,
    checkpointVolumeBytes: checkpointImageBytesValue,
    netRxBytes: null,
    netTxBytes: null,
    blockReadBytes: null,
    blockWriteBytes: null,
    limits,
    warnings,
  };

  if ((await inspectContainerStatus(record.container)) !== 'running') {
    return base;
  }

  const proc = await execa(
    'docker',
    ['stats', '--no-stream', '--format', '{{json .}}', record.container],
    { reject: false },
  );
  if (proc.exitCode !== 0 || !proc.stdout.trim()) {
    return base;
  }
  let line: DockerStatsLine;
  try {
    line = JSON.parse(proc.stdout.trim().split('\n')[0]!) as DockerStatsLine;
  } catch {
    return base;
  }

  const memPair = splitPair(line.MemUsage);
  const memUsedBytes = memPair ? parseDockerSize(memPair[0]) : null;
  const memEngineTotal = memPair ? parseDockerSize(memPair[1]) : null;
  const netPair = splitPair(line.NetIO);
  const blkPair = splitPair(line.BlockIO);

  return {
    ...base,
    live: true,
    cpuPercent: parsePercent(line.CPUPerc),
    memUsedBytes,
    // The applied limit when set; otherwise docker stats' own denominator
    // (the engine/host total).
    memLimitBytes: limits.memoryBytes ?? memEngineTotal,
    memPercent: parsePercent(line.MemPerc),
    pids: line.PIDs ? Number.parseInt(line.PIDs, 10) || null : null,
    netRxBytes: netPair ? parseDockerSize(netPair[0]) : null,
    netTxBytes: netPair ? parseDockerSize(netPair[1]) : null,
    blockReadBytes: blkPair ? parseDockerSize(blkPair[0]) : null,
    blockWriteBytes: blkPair ? parseDockerSize(blkPair[1]) : null,
  };
}
