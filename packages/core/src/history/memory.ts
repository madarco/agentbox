import type { AgentHistoryMemory } from './types.js';

/** Largest memory file shipped or stored. Memory is small markdown; this is a guard. */
export const MEMORY_FILE_MAX_BYTES = 256 * 1024;
/** Most files one agent's memory set may hold. */
export const MEMORY_MAX_FILES = 1000;

/** ctl's per-box memory baseline (on the writable layer; checkpoint cleanup deletes it). */
export const MEMORY_STATE_FILE = '/home/vscode/.local/state/agentbox/memory-state.json';

/** The `<projectKey>` an agent uses for a host project folder. */
export function hostProjectKey(kind: AgentHistoryMemory['hostKey'], absPath: string): string {
  switch (kind) {
    case 'dashed-path':
      return absPath.replace(/[^a-zA-Z0-9]/g, '-');
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
