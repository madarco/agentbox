// Make a brand-new project folder for `POST /projects { parent, name }` — the
// pure half (no registry write), so it is testable on a temp dir without
// relocating `$HOME`. The backend registers the returned root.
//
// The folder is created EMPTY on purpose: a stub `agentbox.yaml` would flip the
// project's `needsSetup` to false and silence the setup wizard, and a service
// bot (openclaw) writes its own workspace during onboarding. The one thing a
// stub would have bought — anchoring `findProjectRoot` — is handled by refusing
// to create a project inside another project instead.
import { execFile } from 'node:child_process';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { findProjectRoot } from '@agentbox/config';

const execFileAsync = promisify(execFile);

/** One path segment: letters, digits, `.`, `_`, `-`; no leading dot; max 100 chars. */
export const PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const PROJECT_NAME_RULE =
  'name must be a single folder name (letters, digits, . _ -; no leading dot, no slashes)';

/** Content of the `.gitignore` a git-initialized project starts with. */
export const NEW_PROJECT_GITIGNORE = '.agentbox/\n';

/** Local git only — a hang here would be a stuck hook or a stuck fs, not the network. */
const GIT_TIMEOUT_MS = 15_000;

export interface CreateProjectDirInput {
  parent: string;
  name: string;
  git: boolean;
}

export type CreateProjectDirResult = { ok: true; root: string } | { ok: false; error: string };

export type ExecGit = (args: string[], opts: { cwd: string }) => Promise<unknown>;

export interface CreateProjectDirDeps {
  /** Injectable `git` runner so a test can fail `init` without a broken git. */
  execGit: ExecGit;
}

const defaultDeps: CreateProjectDirDeps = {
  execGit: (args, { cwd }) => execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT_MS }),
};

/** Error message for an unusable project name, or null when it is fine. */
export function validateProjectName(name: string): string | null {
  if (typeof name !== 'string' || !PROJECT_NAME_RE.test(name)) return PROJECT_NAME_RULE;
  return null;
}

export async function createProjectDir(
  input: CreateProjectDirInput,
  deps: CreateProjectDirDeps = defaultDeps,
): Promise<CreateProjectDirResult> {
  const parent = input.parent;
  if (!parent || !path.isAbsolute(parent)) {
    return { ok: false, error: 'an absolute parent path is required' };
  }
  const nameError = validateProjectName(input.name);
  if (nameError) return { ok: false, error: nameError };

  const pst = await stat(parent).catch(() => null);
  if (!pst || !pst.isDirectory()) return { ok: false, error: `not a directory: ${parent}` };

  // A folder under a project root would resolve to THAT project (findProjectRoot
  // walks up to the nearest agentbox.yaml), so the new project would never be
  // its own. Refuse and say which project owns the parent.
  const enclosing = await findProjectRoot(parent);
  if (enclosing.hasAgentboxYaml) {
    return {
      ok: false,
      error: `${parent} is inside the project at ${enclosing.root}; create the folder outside it`,
    };
  }

  const target = path.join(parent, input.name);
  if (await stat(target).catch(() => null))
    return { ok: false, error: `already exists: ${target}` };

  try {
    // Non-recursive: the parent was just checked to exist, and a typo in it must
    // not mint a directory chain nobody asked for.
    await mkdir(target);
  } catch (err) {
    return { ok: false, error: `cannot create ${target}: ${errorMessage(err)}` };
  }

  if (input.git) {
    try {
      await initGitRepo(target, deps.execGit);
    } catch (err) {
      // Leave no half-made project behind: a folder with a broken .git would
      // register fine and then fail every create.
      await rm(target, { recursive: true, force: true }).catch(() => {});
      return { ok: false, error: `git init failed: ${errorMessage(err)}` };
    }
  }

  // Canonical (realpath'd) root, the same way `addProject` and `create` resolve
  // it — the registry id is a hash of this string.
  const root = (await findProjectRoot(target)).root;
  return { ok: true, root };
}

/**
 * `git init` on `main`, a `.gitignore` for the host-side `.agentbox/` (bot
 * backups live there and must never be committed), and one commit so the box's
 * per-box branch has a parent. The commit retries with a fixed identity because
 * a fresh machine may have no `user.name`/`user.email` yet.
 */
async function initGitRepo(dir: string, execGit: ExecGit): Promise<void> {
  const run = (args: string[]) => execGit(args, { cwd: dir });
  await run(['init', '-q']);
  // Works before the first commit on every git version, unlike `init -b`.
  await run(['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await writeFile(path.join(dir, '.gitignore'), NEW_PROJECT_GITIGNORE, 'utf8');
  await run(['add', '.gitignore']);
  // No signing: the hub is a daemon with no TTY, so a `commit.gpgsign=true` in
  // the user's config would hang on the passphrase prompt and then fail.
  const commit = ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Initial commit'];
  try {
    await run(commit);
  } catch {
    await run(['-c', 'user.name=AgentBox', '-c', 'user.email=agentbox@localhost', ...commit]);
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    // execFile errors carry the tool's stderr, which is the useful part.
    const stderr = (err as Error & { stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && stderr.trim()) return stderr.trim();
    return err.message;
  }
  return String(err);
}
