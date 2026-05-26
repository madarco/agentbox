/**
 * Build-time injected CLI version constants. tsup's `define` (apps/cli/tsup.config.ts)
 * replaces these identifiers at bundle time:
 *
 *   __AGENTBOX_VERSION__ ← apps/cli/package.json `version`
 *   __AGENTBOX_COMMIT__  ← `git rev-parse --short HEAD` at build time
 *
 * The `declare` lines below are for the typecheck of the unbundled source —
 * tsup substitutes the literals before esbuild ever sees this file. The
 * `?? '...'` fallbacks cover the unbundled dev case (running `tsx src/index.ts`
 * before `pnpm build` populates the defines).
 */

declare const __AGENTBOX_VERSION__: string | undefined;
declare const __AGENTBOX_COMMIT__: string | undefined;

export const AGENTBOX_VERSION: string =
  typeof __AGENTBOX_VERSION__ === 'string' ? __AGENTBOX_VERSION__ : '0.0.0-dev';

export const AGENTBOX_COMMIT: string =
  typeof __AGENTBOX_COMMIT__ === 'string' ? __AGENTBOX_COMMIT__ : 'dev';
