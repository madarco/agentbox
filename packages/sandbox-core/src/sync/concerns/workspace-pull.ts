/**
 * Concern: workspace pull — the provider-neutral `box → host scratch dir → the
 * user's working dir` pipeline behind `agentbox download` and the export half of
 * `agentbox clone`.
 *
 * Stage 1 (materialize `/workspace` on the host) is the only part that differs
 * per provider. Docker has a bind mount and rsyncs over it (`refreshExport`);
 * everyone else has one tar hop, which is {@link stageBoxWorkspace} here.
 * Stage 2 — the `rsync -a --checksum` into the working dir, and the itemized
 * change list `--dry-run` prints — is `rsyncPullToHost`, shared by both. That
 * split is what makes `--dry-run`, the gitignore selection and
 * `--include-node-modules` work on a cloud box: they all live in the half both
 * providers run.
 *
 * The staged file list is written next to the scratch dir so a second call with
 * `noRefresh` (the CLI previews, then applies) copies exactly the set it
 * previewed, instead of re-deriving one from a box that may have moved on.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import type { BoxRecord, Provider } from '@agentbox/core';
import { providerBoxFilePorts } from './box-files.js';
import { buildHostEnvFindArgs } from './env.js';
import {
  buildWorkspaceListScript,
  isExcludedPath,
  parseWorkspaceList,
  rsyncPullToHost,
  workspaceExcludes,
  type WorkspaceListMode,
} from './workspace-files.js';

/** Sidecar holding the last staged selection, so `noRefresh` can replay it. */
const FILELIST_NAME = 'pull-filelist.json';

/** Single-quote a value for the POSIX shell. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface StageWorkspaceArgs {
  provider: Provider;
  box: BoxRecord;
  /** In-box workspace dir (default `/workspace`). */
  boxWorkspaceDir?: string;
  /** Host dir the box's workspace is materialized into. Wiped and refilled. */
  scratchDir: string;
  /** Default true. When false, always use the exclude list. */
  respectGitignore?: boolean;
  /** Default false. Keep `node_modules` in exclude-list mode. */
  includeNodeModules?: boolean;
  /**
   * Extra env/config basename globs pulled regardless of gitignore (the
   * `--with-env` set). Composes WITH the primary selection.
   */
  envPatterns?: string[];
  /**
   * Apply the exclude patterns to the GIT-mode selection too. Off for
   * `download` — a tracked `.claude/` is the user's own content there and
   * dropping it would be a regression. On for `clone`, whose whole contract is
   * that the new box onboards with a fresh identity, so a state dir must not
   * ride along even when the source box happened to commit it.
   */
  dropExcludedInGitMode?: boolean;
  /**
   * Default true. Write the `pull-filelist.json` sidecar next to the scratch
   * dir so a later `noRefresh` pass replays the same selection. `clone` stages
   * into a user-facing directory and turns it off — the sidecar is scratch-dir
   * bookkeeping, not something to leave beside someone's new project folder.
   */
  writeSidecar?: boolean;
}

export interface StagedWorkspace {
  scratchDir: string;
  /** NUL-joined relative paths staged, or null when nothing matched. */
  fileList: string | null;
  mode: WorkspaceListMode;
}

/** Where the sidecar for a scratch dir lives (a sibling, never inside it). */
function fileListPath(scratchDir: string): string {
  return join(dirname(scratchDir), FILELIST_NAME);
}

/**
 * Stage 1 for every non-docker provider: enumerate the workspace in the box,
 * tar exactly those paths out, and extract them into `scratchDir`.
 *
 * The scratch dir is emptied first — a stale file from a previous pull would
 * otherwise be copied to the host as if the box still had it.
 */
export async function stageBoxWorkspace(args: StageWorkspaceArgs): Promise<StagedWorkspace> {
  const boxDir = args.boxWorkspaceDir ?? '/workspace';
  const ports = providerBoxFilePorts(args.provider, args.box);
  const excludes = workspaceExcludes({ includeNodeModules: args.includeNodeModules });

  const listed = await ports.run(
    buildWorkspaceListScript({
      workspaceDir: boxDir,
      respectGitignore: args.respectGitignore,
      excludes,
    }),
    { asRoot: true },
  );
  if (listed.exitCode !== 0) {
    throw new Error(`listing ${boxDir} in the box failed: ${listed.stderr || listed.stdout}`);
  }
  const primary = parseWorkspaceList(listed.stdout);
  const selected =
    primary.mode === 'git' && args.dropExcludedInGitMode
      ? primary.paths.filter((p) => !isExcludedPath(p, excludes))
      : primary.paths;
  const paths = new Set(selected);

  if (args.envPatterns && args.envPatterns.length > 0) {
    const envArgv = buildHostEnvFindArgs(args.envPatterns).map(sq).join(' ');
    const env = await ports.run(`cd ${sq(boxDir)} 2>/dev/null || exit 0\n${envArgv}`, {
      asRoot: true,
    });
    if (env.exitCode === 0) {
      for (const p of env.stdout.split('\0')) {
        if (p.length === 0) continue;
        paths.add(p.startsWith('./') ? p.slice(2) : p);
      }
    }
  }

  await rm(args.scratchDir, { recursive: true, force: true });
  await mkdir(args.scratchDir, { recursive: true });
  const list = [...paths];
  if (list.length > 0) {
    const tar = await ports.pullTar(boxDir, list);
    const extract = await execa('tar', ['-xf', '-', '-C', args.scratchDir], {
      input: tar,
      reject: false,
    });
    if (extract.exitCode !== 0) {
      throw new Error(`extracting the box workspace failed: ${extract.stderr}`);
    }
  }

  const staged: StagedWorkspace = {
    scratchDir: args.scratchDir,
    fileList: list.length > 0 ? list.join('\0') : null,
    mode: primary.mode,
  };
  if (args.writeSidecar !== false) {
    await writeFile(
      fileListPath(args.scratchDir),
      JSON.stringify({ mode: staged.mode, paths: list }),
      'utf8',
    );
  }
  return staged;
}

/** Read back the sidecar a previous {@link stageBoxWorkspace} wrote. */
export async function readStagedWorkspace(scratchDir: string): Promise<StagedWorkspace | null> {
  try {
    const raw = JSON.parse(await readFile(fileListPath(scratchDir), 'utf8')) as {
      mode?: string;
      paths?: string[];
    };
    const paths = raw.paths ?? [];
    return {
      scratchDir,
      fileList: paths.length > 0 ? paths.join('\0') : null,
      mode: raw.mode === 'git' ? 'git' : 'exclude',
    };
  } catch {
    return null;
  }
}

export interface PullWorkspaceArgs extends StageWorkspaceArgs {
  /** The user's working dir the files land in (`box.workspacePath`). */
  destDir: string;
  /** Default false. Preview only — return the change list without writing. */
  dryRun?: boolean;
  /** Default false. Reuse whatever is already in `scratchDir` (and its sidecar). */
  noRefresh?: boolean;
}

export interface PullWorkspaceResult {
  hostPath: string;
  changes: string[];
  applied: boolean;
  /** True when git decided the selection; false means exclude-list mode. */
  usedGitignore: boolean;
}

/**
 * The whole pull for a provider with no host-visible workspace: stage, then run
 * the shared stage 2. Docker does not use this — it stages over its bind mount —
 * but both end in `rsyncPullToHost`, so the reported change list is the same
 * artifact on every provider.
 */
export async function pullWorkspaceToHost(args: PullWorkspaceArgs): Promise<PullWorkspaceResult> {
  const staged = args.noRefresh
    ? ((await readStagedWorkspace(args.scratchDir)) ?? (await stageBoxWorkspace(args)))
    : await stageBoxWorkspace(args);

  const { changes, applied } = await rsyncPullToHost({
    scratchDir: staged.scratchDir,
    destDir: args.destDir,
    fileList: staged.fileList,
    excludes: workspaceExcludes({ includeNodeModules: args.includeNodeModules }),
    dryRun: args.dryRun,
  });
  return {
    hostPath: args.destDir,
    changes,
    applied,
    usedGitignore: staged.mode === 'git',
  };
}
