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

import { readdir } from 'node:fs/promises';
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

/** Throw unless `dir` is absent or empty — never clobber someone's folder. */
export async function assertEmptyDir(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return; // absent is fine; the export creates it
  }
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
