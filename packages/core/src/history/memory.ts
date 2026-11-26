import type { AgentHistoryMemory } from './types.js';

/** Largest memory file shipped or stored. Memory is small markdown; this is a guard. */
export const MEMORY_FILE_MAX_BYTES = 256 * 1024;
/** Most files one agent's memory set may hold. */
export const MEMORY_MAX_FILES = 1000;

/** ctl's per-box memory baseline (on the writable layer; checkpoint cleanup deletes it). */
export const MEMORY_STATE_FILE = '/home/vscode/.local/state/agentbox/memory-state.json';

/** Longest `dashed-path` key before claude truncates it and appends a hash. */
export const DASHED_PATH_MAX = 200;

/** Java's `String#hashCode` over UTF-16 code units, as a signed 32-bit int. */
function stringHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

/**
 * The `<projectKey>` an agent uses for a host project folder. `dashed-path` is
 * Claude Code's: every non-alphanumeric char as `-`; past 200 chars, the first
 * 200 plus `-` and the path's hash in base 36 (checked against Claude Code
 * 2.1.326 with a 273-char path).
 */
export function hostProjectKey(kind: AgentHistoryMemory['hostKey'], absPath: string): string {
  switch (kind) {
    case 'dashed-path': {
      const dashed = absPath.replace(/[^a-zA-Z0-9]/g, '-');
      if (dashed.length <= DASHED_PATH_MAX) return dashed;
      return `${dashed.slice(0, DASHED_PATH_MAX)}-${Math.abs(stringHash(absPath)).toString(36)}`;
    }
  }
}

/** The host copy's dir: `hostConfigDir/hostRoot` with `<projectKey>` for `projectRoot`. */
export function hostMemoryDir(
  hostConfigDir: string,
  mem: AgentHistoryMemory,
  projectRoot: string,
): string {
  const key = hostProjectKey(mem.hostKey, projectRoot);
  return `${hostConfigDir.replace(/\/+$/, '')}/${mem.hostRoot.replaceAll('<projectKey>', key)}`;
}

/**
 * A memory path relative to its dir, or null when it could escape it or is not
 * a plain relative path. Every path from an edge or the API goes through this.
 */
export function safeMemoryPath(p: unknown): string | null {
  if (typeof p !== 'string' || p.length === 0 || p.length > 512) return null;
  if (p.startsWith('/') || p.includes('\\') || p.includes('\0')) return null;
  const parts = p.split('/');
  if (parts.some((s) => s === '' || s === '.' || s === '..')) return null;
  return p;
}
