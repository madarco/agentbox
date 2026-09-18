/**
 * The workspace scan, run HERE and posted as facts.
 *
 * The hub that owns a workspace need not be the machine holding its folders — a
 * control box owns boxes for repos it never cloned — so the client walks its own
 * disk and sends what it found: the folder, the projects under it, and each
 * project's `origin`, which is what joins a box to its workspace anywhere.
 */
import { hostname } from 'node:os';
import { basename } from 'node:path';
import { canonicalWorkspaceRoot, scanWorkspaceProjects } from '@agentbox/relay';
import { readGitOriginUrl } from '@agentbox/sandbox-cloud';

export interface ScannedProject {
  path: string;
  name: string;
  repoUrl?: string;
}

export interface WorkspaceScan {
  host: string;
  root: string;
  projects: ScannedProject[];
}

/** Scan `root` on this machine: its projects and their origins. */
export async function scanWorkspace(root: string): Promise<WorkspaceScan> {
  const canonical = await canonicalWorkspaceRoot(root);
  const paths = await scanWorkspaceProjects(canonical);
  const projects = await Promise.all(
    paths.map(async (path): Promise<ScannedProject> => {
      const repoUrl = await readGitOriginUrl(path).catch(() => undefined);
      return { path, name: basename(path), ...(repoUrl ? { repoUrl } : {}) };
    }),
  );
  return { host: hostname(), root: canonical, projects };
}
