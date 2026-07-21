/**
 * Claude-specific host/box path helpers, shared by every provider's sync layer.
 *
 * Moved here (from `@agentbox/sandbox-docker`'s `host-stage.ts`) so the cloud
 * dynamic-sync path can reuse them without importing the docker package — the
 * dependency leak the sync refactor closes. `host-stage.ts` re-exports these for
 * its existing importers, so nothing else moves.
 */

import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Claude Code keys per-project state (memory, sessions, history) under
 * `~/.claude/projects/<encoded>/`, where `<encoded>` is the project's absolute
 * path with every non-alphanumeric char replaced by `-`. Inside every box the
 * workspace is `/workspace`, so its key is always `-workspace`. We duplicate
 * the rule here (rather than importing apps/cli's `encodeClaudeProjectsDir`)
 * because the sync layer must not depend on the CLI package.
 */
export function encodeClaudeProjectsKey(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/** In-box Claude project dir for `/workspace` (fixed for every box). */
export const BOX_CLAUDE_PROJECT_DIR = '/home/vscode/.claude/projects/-workspace';

/**
 * Resolve the host's `~/.claude/projects/<encode(hostWorkspace)>/memory` dir,
 * or `null` when it's absent or empty (so callers no-op rather than seed an
 * empty tree). `hostHome` is overridable for tests.
 */
export async function resolveClaudeMemoryDir(
  hostWorkspace: string,
  hostHome: string = homedir(),
): Promise<string | null> {
  if (hostWorkspace.length === 0) return null;
  const memDir = join(
    hostHome,
    '.claude',
    'projects',
    encodeClaudeProjectsKey(hostWorkspace),
    'memory',
  );
  if (!(await pathExists(memDir))) return null;
  try {
    const entries = await readdir(memDir);
    if (entries.length === 0) return null;
  } catch {
    return null;
  }
  return memDir;
}
