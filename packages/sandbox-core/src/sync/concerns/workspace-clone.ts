/**
 * Concern: workspace clone — export a live box's `/workspace` into a fresh host
 * directory that a NEW box can then be created from.
 *
 * `agentbox clone` stands up a second box from the same workspace files and the
 * same `agentbox.yaml`, with a **fresh agent identity**. The identity half needs
 * no code: an agent's state lives in its config volume / box HOME, and clone
 * simply does not copy it, so the new box runs its onboarding from scratch and
 * generates its own token. (Verified in Phase 0 of the service-boxes plan: two
 * onboards under different HOMEs produce different gateway tokens.) There is
 * deliberately no `--with-state` — two live daemons sharing one identity is the
 * failure mode this design exists to prevent, and box→box migration is the
 * checkpoint path's job.
 *
 * So the only real work is the export, and it is the Phase-4b staging pass with
 * one extra rule: exclude patterns apply in git mode too, so an agent state dir
 * cannot ride along even if the source box committed one.
 */

import { lstat, readdir } from 'node:fs/promises';
import type { BoxRecord, Provider } from '@agentbox/core';
import { stageBoxWorkspace } from './workspace-pull.js';

export interface ExportWorkspaceArgs {
  provider: Provider;
  box: BoxRecord;
  /** Host dir to fill. Created if missing; must be empty when it exists. */
  destDir: string;
  /** In-box workspace dir (default `/workspace`). */
  boxWorkspaceDir?: string;
  /** Default false. Carry `node_modules` into the clone as well. */
  includeNodeModules?: boolean;
  onLog?: (line: string) => void;
}

export interface ExportWorkspaceResult {
  destDir: string;
  /** Number of files written. */
  files: number;
  /** True when git decided the selection; false means exclude-list mode. */
  usedGitignore: boolean;
}

/**
 * Throw unless `dir` is absent, or is a real and empty directory.
 *
 * The export `rm -rf`s this path before refilling it, so it has to be
 * POSITIVELY identified first. Reading any stat failure as "absent" is what
 * made `--into ~/notes.md` delete `notes.md`: `readdir` on a file fails with
 * `ENOTDIR`, the old code took that for "nothing there", and the staging step
 * removed the file and put a directory in its place. Only `ENOENT` means absent;
 * everything else that exists but is not a directory is refused by name.
 */
export async function assertEmptyDir(dir: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // the export creates it
    throw new Error(`cannot use ${dir} as a destination: ${(err as Error).message}`);
  }
  if (stats.isSymbolicLink()) {
    throw new Error(
      `${dir} is a symlink; pick a real directory (the export would replace the link, not its target)`,
    );
  }
  if (!stats.isDirectory()) {
    throw new Error(`${dir} exists and is not a directory; pick another destination`);
  }
  const entries = await readdir(dir);
  if (entries.length > 0) {
    throw new Error(`${dir} is not empty; pick another destination or empty it first`);
  }
}

/**
 * Copy the source box's workspace files into `destDir`.
 *
 * `.git` is never part of the export: the git selection lists tracked +
 * untracked-not-ignored files, and the exclude list drops the directory itself.
 * The clone is therefore a template — files and `agentbox.yaml`, no history and
 * no branch. That is the intended shape (a new tenant, not a second checkout);
 * a git-backed clone is `agentbox create` on the same project.
 */
export async function exportBoxWorkspace(
  args: ExportWorkspaceArgs,
): Promise<ExportWorkspaceResult> {
  const log = args.onLog ?? ((): void => {});
  await assertEmptyDir(args.destDir);
  log(`exporting ${args.box.name}:/workspace to ${args.destDir}`);
  const staged = await stageBoxWorkspace({
    provider: args.provider,
    box: args.box,
    boxWorkspaceDir: args.boxWorkspaceDir,
    scratchDir: args.destDir,
    includeNodeModules: args.includeNodeModules,
    dropExcludedInGitMode: true,
    writeSidecar: false,
  });
  const files = staged.fileList === null ? 0 : staged.fileList.split('\0').length;
  log(`exported ${String(files)} file(s)${staged.mode === 'git' ? '' : ' (exclude-list mode)'}`);
  return { destDir: args.destDir, files, usedGitignore: staged.mode === 'git' };
}
