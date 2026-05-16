import { homedir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import type { BoxResourceLimits, BoxResourceStats } from '@agentbox/core';
import { CHECKPOINT_VOLUME_PREFIX, checkpointVolumeName } from './checkpoint.js';
import {
  inspectContainer,
  inspectContainerStatus,
  inspectVolumeMountpoint,
  listAgentboxVolumes,
} from './docker.js';
import { detectEngine } from './host-export.js';
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

/** Size of the per-project shared checkpoint volume, or null when absent. */
export async function projectCheckpointVolumeBytes(
  projectRoot: string,
): Promise<number | null> {
  return volumeSizeBytes(checkpointVolumeName(projectRoot));
}

/**
 * Total on-host bytes of every per-project checkpoint volume (the durable,
 * cross-box warm-state assets). Null when none exist or no size is reachable
 * from the host.
 */
export async function allCheckpointVolumesBytes(): Promise<number | null> {
  const vols = (await listAgentboxVolumes()).filter((v) =>
    v.startsWith(CHECKPOINT_VOLUME_PREFIX),
  );
  if (vols.length === 0) return null;
  const sizes = await Promise.all(vols.map((v) => volumeSizeBytes(v)));
  const known = sizes.filter((s): s is number => s !== null);
  return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
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
 * Provider-agnostic resource snapshot for a box. CPU/mem/pids/IO come from
 * `docker stats --no-stream` (point-in-time sample; only when the container is
 * running). Disk is the per-box writable surface (upper + docker data-root
 * volumes); the per-box host snapshot dir and the SHARED per-project
 * checkpoint volume are reported on their own fields and never summed into
 * `diskUsedBytes` (would double-count across a project's boxes).
 */
export async function boxResourceStats(record: BoxRecord): Promise<BoxResourceStats> {
  const warnings: string[] = [];
  const dockerJson = await inspectContainer(record.container);
  const limits = reconcileLimits(limitsFromRecord(record), dockerJson);

  const [diskUpper, diskDocker, snapshotDiskBytes, checkpointVolumeBytes] = await Promise.all([
    volumeSizeBytes(record.upperVolume),
    record.dockerVolume ? volumeSizeBytes(record.dockerVolume) : Promise.resolve(null),
    record.snapshotDir ? duBytes(record.snapshotDir) : Promise.resolve(null),
    record.checkpointVolume
      ? volumeSizeBytes(record.checkpointVolume)
      : Promise.resolve(null),
  ]);
  const diskUsedBytes =
    diskUpper === null && diskDocker === null ? null : (diskUpper ?? 0) + (diskDocker ?? 0);
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
    checkpointVolumeBytes,
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
