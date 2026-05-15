import { findProjectRoot } from '@agentbox/config';
import {
  AmbiguousBoxError,
  BoxNotFoundError,
  readState,
  resolveBoxRef,
  type BoxRecord,
  type FindBoxResult,
} from '@agentbox/sandbox-docker';
import { log } from '@clack/prompts';

interface ResolveOptions {
  /**
   * Override the cwd used for project-root resolution. Defaults to
   * `process.cwd()`. Commands that take `--workspace <path>` (e.g. create,
   * claude) can pass it here so the resolver matches the workspace's project,
   * not whatever shell dir the user happened to be in.
   */
  cwd?: string;
}

/**
 * One-stop resolver every box-arg command goes through.
 *
 * Resolution order:
 *   1. If `ref` is undefined → auto-pick the only box for the cwd's project
 *      (errors with a chooser if 2+, errors clearly if 0).
 *   2. If `ref` is a positive integer → resolve as the cwd-project's
 *      `projectIndex` (does NOT fall through to id-prefix; pure-numeric refs
 *      are reserved for indices).
 *   3. Otherwise → existing `findBox` semantics (id → prefix → name → container).
 *
 * On any failure mode the helper prints a friendly message and `process.exit`s
 * with code 2, so callers can write `const box = await resolveBoxOrExit(...)`
 * without try/catch boilerplate.
 */
/**
 * Special variant for `shell` and `logs` — the only two CLI verbs where
 * commander can't distinguish between "user typed a box ref" and "user typed a
 * cmd/service after `--` and commander bound it to [box]". When `ref` is set
 * but doesn't resolve as a box AND auto-pick yields exactly one box, return
 * that box plus a hint that `ref` should be re-treated as the first cmd/svc
 * token. On normal success / total miss it behaves like `resolveBoxOrExit`.
 */
export async function resolveBoxOrShift(
  ref: string | undefined,
  opts: ResolveOptions = {},
): Promise<{ box: BoxRecord; shifted: boolean }> {
  const cwd = opts.cwd ?? process.cwd();
  const project = await findProjectRoot(cwd);
  const state = await readState();
  const firstTry: FindBoxResult = resolveBoxRef(ref, state, project.root);
  if (firstTry.kind === 'ok') return { box: firstTry.box, shifted: false };

  if (ref !== undefined) {
    // Maybe commander bound a post-`--` token to [box]; try auto-pick.
    const pick = resolveBoxRef(undefined, state, project.root);
    if (pick.kind === 'ok') return { box: pick.box, shifted: true };
    if (pick.kind === 'ambiguous') {
      // Auto-pick would have worked but it's ambiguous — strong signal the
      // user typed `shell -- cmd` (or `logs <svc>`) in a multi-box project.
      // Surface the chooser instead of the confusing "no match for <cmd>".
      log.error(`multiple boxes in this project — pick one:`);
      for (const b of pick.matches) {
        const idx = typeof b.projectIndex === 'number' ? `${String(b.projectIndex)})` : ' -)';
        process.stderr.write(`  ${idx} ${b.name}   (id ${b.id})\n`);
      }
      log.info('try: agentbox <cmd> <n> -- <args>   (or use the box name / id prefix)');
      process.exit(2);
    }
  }

  // Same error path as resolveBoxOrExit.
  const box = await resolveBoxOrExit(ref, opts);
  return { box, shifted: false };
}

export async function resolveBoxOrExit(
  ref: string | undefined,
  opts: ResolveOptions = {},
): Promise<BoxRecord> {
  const cwd = opts.cwd ?? process.cwd();
  // findProjectRoot tolerates non-existent dirs by walking up until
  // dirname(x) === x; the fallback root is the input itself. We treat any
  // walked path as the project root for resolution.
  const project = await findProjectRoot(cwd);
  const state = await readState();
  const result = resolveBoxRef(ref, state, project.root);

  if (result.kind === 'ok') return result.box;

  if (result.kind === 'ambiguous') {
    // Auto-pick ambiguous: the project has 2+ boxes and the user gave no ref.
    // For numeric / non-numeric explicit refs, an ambiguous result can only
    // come from findBox's id-prefix match (e.g. "a1" matches "a1b…" and
    // "a1c…"), in which case the user typed a real prefix and just needs to
    // disambiguate.
    if (ref === undefined) {
      log.error(`multiple boxes in this project — pick one:`);
      for (const b of result.matches) {
        const idx = typeof b.projectIndex === 'number' ? `${String(b.projectIndex)})` : ' -)';
        process.stderr.write(`  ${idx} ${b.name}   (id ${b.id})\n`);
      }
      log.info('try: agentbox <cmd> <n>   (or use the box name / id prefix)');
      process.exit(2);
    }
    // ref was provided → fall through to AmbiguousBoxError so handleLifecycleError
    // can render its existing hint about specifying more characters.
    throw new AmbiguousBoxError(ref, result.matches);
  }

  // kind === 'none'
  if (ref === undefined) {
    log.error(`no boxes in this project (${project.root})`);
    log.info('run `agentbox create` to make one, or pass a box ref explicitly');
    process.exit(2);
  }
  if (/^[1-9][0-9]*$/.test(ref.trim())) {
    log.error(`no box with index ${ref.trim()} in this project (${project.root})`);
    log.info('run `agentbox list` to see available indices');
    process.exit(2);
  }
  throw new BoxNotFoundError(ref);
}
