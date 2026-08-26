import { spawnSync } from 'node:child_process';

export interface CreateosCliState {
  installed: boolean;
  bin?: string;
  version?: string;
}

let cached: CreateosCliState | null = null;

export function detectCreateosCli(): CreateosCliState {
  if (cached !== null) return cached;
  const r = spawnSync('createos', ['version'], { encoding: 'utf8' });
  if (r.status === 0) {
    cached = {
      installed: true,
      bin: 'createos',
      version: (r.stdout ?? '').trim() || undefined,
    };
    return cached;
  }
  cached = { installed: false };
  return cached;
}

export function resetCreateosCliCache(): void {
  cached = null;
}

