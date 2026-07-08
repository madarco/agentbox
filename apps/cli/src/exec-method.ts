import { realpathSync } from 'node:fs';

export type ExecMethod = 'npx' | 'pnpm' | 'npm' | 'direct';

export interface ExecMethodInput {
  /** `process.env.npm_config_user_agent` (or undefined). */
  userAgent?: string | undefined;
  /** `process.argv[1]` — the resolved bin path. */
  argv1?: string | undefined;
}

/**
 * Classify how this CLI was launched. The signals npm/pnpm/npx leave behind:
 *
 *  - npx writes the bin into a `_npx` cache dir and tags the user-agent with
 *    `npm/<v> ... npx/<v>` — so the argv path or the user-agent gives it away.
 *  - pnpm sets `npm_config_user_agent` starting with `pnpm/` (when invoked
 *    through pnpm, e.g. `pnpm exec`).
 *  - npm sets it starting with `npm/` (when invoked through npm).
 *  - a **global install invoked straight from the shell** — the common case —
 *    carries NO user-agent, and argv[1] is the bin *symlink* (e.g.
 *    `/usr/local/bin/agentbox`). Resolving the symlink reveals where the
 *    package really lives: npm globals under `<prefix>/lib/node_modules/`,
 *    pnpm globals inside a `/.pnpm/` store.
 *  - anything else (a dev clone run as `node dist/index.js`, a hand-made
 *    symlink into a checkout) → `direct`.
 *
 * npx is checked first because its user-agent also contains `npm/`.
 */
export function detectExecutionMethod(input: ExecMethodInput): ExecMethod {
  const ua = input.userAgent ?? '';
  const argv1 = input.argv1 ?? '';

  if (argv1.includes('/_npx/') || argv1.includes('/.npm/_npx') || /\bnpx\//.test(ua)) {
    return 'npx';
  }
  if (/\bpnpm\//.test(ua)) {
    return 'pnpm';
  }
  if (/\bnpm\//.test(ua)) {
    return 'npm';
  }

  let real = argv1;
  try {
    real = realpathSync(argv1);
  } catch {
    // Missing/synthetic path (unit tests, unusual launchers) — classify on
    // the literal path instead.
  }
  // pnpm's global dir is project-shaped (<PNPM_HOME>/global/5/node_modules/
  // .pnpm/...), so its store segment looks exactly like a project-local
  // dependency's — match the global dir itself, not the .pnpm store. A
  // project-local install (node_modules/.bin shim, local .pnpm store, or a
  // custom PNPM_HOME we can't recognize) stays `direct`: self-update must
  // skip the package step there, never run a global add over a local dep.
  if (real.includes('/pnpm/global/')) {
    return 'pnpm';
  }
  if (real.includes('/lib/node_modules/')) {
    return 'npm';
  }
  return 'direct';
}
