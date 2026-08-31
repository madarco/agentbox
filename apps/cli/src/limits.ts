import type { EffectiveConfig } from '@agentbox/config';

/**
 * Engine-agnostic resource ceilings the CLI hands to createBox. Memory in
 * bytes, cpus fractional, pids a count, disk a raw size string. null = no cap.
 */
export interface ResolvedLimits {
  memoryBytes: number | null;
  cpus: number | null;
  pidsLimit: number | null;
  disk: string | null;
}

/**
 * Parse a docker-style memory size (`512`, `512b`, `64k`, `512m`, `2g`) into
 * bytes. Bare numbers are bytes (matches `docker run --memory`). Throws on
 * garbage so a typo'd `--memory` fails loudly instead of silently unlimited.
 */
export function parseMemoryToBytes(raw: string): number {
  const m = /^\s*([\d.]+)\s*([bkmg]?)b?\s*$/i.exec(raw);
  if (!m) throw new Error(`invalid --memory value "${raw}" (try e.g. 512m, 2g)`);
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`invalid --memory value "${raw}"`);
  }
  const unit = (m[2] ?? '').toLowerCase();
  const factor = unit === 'k' ? 1024 : unit === 'm' ? 1024 ** 2 : unit === 'g' ? 1024 ** 3 : 1;
  return Math.floor(n * factor);
}

const MIB = 1024 * 1024;

export interface LimitFlags {
  memory?: string;
  cpus?: string;
  pidsLimit?: string;
  disk?: string;
}

/**
 * Merge the layered config (`box.*`, ints/strings: 0/'' = unlimited) with raw
 * CLI flags. Flags win and carry richer types — `--memory 2g`, fractional
 * `--cpus 1.5` — that the integer-typed config keys can't express.
 */
export function resolveLimits(box: EffectiveConfig['box'], flags: LimitFlags): ResolvedLimits {
  let memoryBytes: number | null = box.memory > 0 ? box.memory * MIB : null;
  if (flags.memory !== undefined && flags.memory !== '') {
    memoryBytes = parseMemoryToBytes(flags.memory);
  }

  let cpus: number | null = box.cpus > 0 ? box.cpus : null;
  if (flags.cpus !== undefined && flags.cpus !== '') {
    const n = Number(flags.cpus);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`invalid --cpus value "${flags.cpus}"`);
    }
    cpus = n > 0 ? n : null;
  }

  let pidsLimit: number | null = box.pidsLimit > 0 ? box.pidsLimit : null;
  if (flags.pidsLimit !== undefined && flags.pidsLimit !== '') {
    const n = Number(flags.pidsLimit);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`invalid --pids-limit value "${flags.pidsLimit}"`);
    }
    pidsLimit = n > 0 ? n : null;
  }

  let disk: string | null = box.disk ? box.disk : null;
  if (flags.disk !== undefined && flags.disk !== '') disk = flags.disk;

  return { memoryBytes, cpus, pidsLimit, disk };
}
