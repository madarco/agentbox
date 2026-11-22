/**
 * The workspace scan, run HERE and posted as facts.
 *
 * The hub that owns a workspace need not be the machine holding its folders — a
 * control box owns boxes for repos it never cloned — so the client walks its own
 * disk and sends what it found: the folder, the projects under it, and each
 * project's `origin`, which is what joins a box to its workspace anywhere.
 */
import { getMachineLabel, tryGetMachineId } from '@agentbox/config';
import { basename } from 'node:path';
import { canonicalWorkspaceRoot, scanWorkspaceProjects } from '@agentbox/relay';
import { readGitOriginUrl } from '@agentbox/sandbox-cloud';
import { repoKeyAtEdge } from '@agentbox/sandbox-core';

export interface ScannedProject {
  path: string;
  name: string;
  repoUrl?: string;
  /** `repoUrl`'s key with this machine's ssh aliases expanded (the hub can't). */
  repoKey?: string;
}

export interface WorkspaceScan {
  host: string;
  machineId?: string;
  root: string;
  projects: ScannedProject[];
}

/**
 * How many `git remote get-url` spawns run at once. A folder of forty repos is
 * an ordinary workspace, and forty concurrent gits are not.
 */
const ORIGIN_CONCURRENCY = 8;

/** `Promise.all` with a ceiling, results in input order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length) as R[];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Scan `root` on this machine: its projects and their origins. */
export async function scanWorkspace(root: string): Promise<WorkspaceScan> {
  const canonical = await canonicalWorkspaceRoot(root);
  const paths = await scanWorkspaceProjects(canonical);
  const projects = await mapLimit(
    paths,
    ORIGIN_CONCURRENCY,
    async (path): Promise<ScannedProject> => {
      const repoUrl = await readGitOriginUrl(path).catch(() => undefined);
      const repoKey = await repoKeyAtEdge(repoUrl);
      return {
        path,
        name: basename(path),
        ...(repoUrl ? { repoUrl } : {}),
        ...(repoKey ? { repoKey } : {}),
      };
    },
  );
  const machineId = tryGetMachineId();
  return {
    host: getMachineLabel(),
    ...(machineId ? { machineId } : {}),
    root: canonical,
    projects,
  };
}
