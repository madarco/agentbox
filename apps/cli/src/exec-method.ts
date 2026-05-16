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
 *  - pnpm sets `npm_config_user_agent` starting with `pnpm/`.
 *  - npm (global install invoked directly) sets it starting with `npm/`.
 *  - anything else (a dev clone run as `node dist/index.js`, a hand-made
 *    symlink) leaves no package-manager user-agent → `direct`.
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
  return 'direct';
}
