// What the CLI posts to `POST /workspaces`: the scan it ran on its own machine.
// The hub stats nothing, so every test that registers a real folder builds its
// input here rather than handing the backend a bare path.
import { hostname } from 'node:os';
import { basename } from 'node:path';
import { scanWorkspaceProjects, type AddWorkspaceInput } from '@agentbox/relay';

export async function workspaceAdd(
  root: string,
  over: Partial<AddWorkspaceInput> & { repoUrl?: string } = {},
): Promise<AddWorkspaceInput> {
  const { repoUrl, ...rest } = over;
  const paths = await scanWorkspaceProjects(root);
  return {
    host: hostname(),
    root,
    // `repoUrl` here is the scan's answer for every project it found — what the
    // GitHub sync reads, since it never looks at a folder.
    projects: paths.map((path) => ({
      path,
      name: basename(path),
      ...(repoUrl ? { repoUrl } : {}),
    })),
    ...rest,
  };
}
