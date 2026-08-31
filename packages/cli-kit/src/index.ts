/**
 * The shared CLI plumbing an agent needs, as a package.
 *
 * WHY IT EXISTS. Each agent's CLI surface — its command descriptor, runtime,
 * login and teleport — is moving out of `apps/cli/src/agents/<id>/` and into
 * `packages/agent-<id>/`. Those files import a dozen small helpers from around
 * the CLI, and a package cannot import `apps/cli`: that is the same cycle the
 * data/behaviour split exists to avoid.
 *
 * So the helpers move DOWN rather than the agents moving up. Everything here is
 * a leaf or near-leaf — the whole set imports only `@agentbox/core`,
 * `@clack/prompts` and `@xterm/headless` outside itself, which is what made it
 * extractable as one piece rather than a long unravelling.
 *
 * WHAT DOES NOT BELONG HERE. The command FACTORY
 * (`apps/cli/src/agents/command/factory.ts`) stays in the CLI: its closure is
 * the entire create/attach pipeline — ~1,500 lines across `create-action.ts`,
 * `start-attach.ts` and `options.ts`. An agent package exports an
 * `AgentCliSpec` DESCRIPTOR and the CLI builds the command from it, which is
 * the shape `AgentCliSpec` already had. Moving the factory would drag the whole
 * pipeline out of the app for no gain.
 */

export {
  stripAnsi,
  trimUrl,
  URL_BODY,
  INVALID_CODE,
  type AgentLoginSpec,
  type LoginNeed,
} from './agent-login-specs.js';
export { withLoginDefaults, type AgentLoginBinding } from './agent-login-bindings.js';
export { applySkipPermissions, type SkipPermissionsRule } from './skip-permissions.js';
export {
  loadPtyBackend,
  type PtyBackend,
  type PtySpawn,
  type IPtyLike,
  type TerminalCtor,
} from './pty-backend.js';
export { clampSpinnerLine } from './spinner-line.js';
export {
  BOX_WORKSPACE,
  BOX_WORKSPACE_ENCODED,
  encodeClaudeProjectsDir,
} from './cwd-encoding.js';
export {
  TeleportError,
  type TeleportAgent,
  type TeleportLogger,
  type ResumeMode,
  type ResolvedTeleport,
} from './teleport-types.js';
// The seven cancel-aware wrappers, plus the `@clack/prompts` surface consumers
// reach through this module.
//
// Named rather than `export *`: `prompt.ts` star-re-exports `@clack/prompts`,
// and `@clack/prompts` is EXTERNAL to this package's bundle, so esbuild cannot
// see through the star to know what names it carries — a re-export of a
// re-export of an external module resolves to nothing, and every consumer of
// `log` / `spinner` / `intro` fails at the CLI's build, not here.
export {
  confirm,
  select,
  selectKey,
  multiselect,
  groupMultiselect,
  text,
  password,
} from './prompt.js';
export { intro, log, note, outro, spinner, isCancel, cancel } from '@clack/prompts';
export {
  makeProgressReporter,
  imageProgress,
  isImageDecisionLine,
  type ProgressReporter,
} from './progress.js';
export { runGuidedLogin, type GuidedLoginResult } from './guided-login.js';
export {
  runAgentLogin,
  rejectionMessage,
  type AgentLoginPhase,
  type AgentLoginPhaseUpdate,
  type RunAgentLoginOptions,
  type RunAgentLoginResult,
} from './agent-login-run.js';
export { openCommandLog, logToActiveCommand, type CommandLog } from './log-file.js';

// The agent CLI contract. It lives here so an agent PACKAGE can implement it —
// it used to sit in `apps/cli/src/agents/command/types.ts`, which a package
// cannot import.
export type {
  SignInResult,
  AttachExtras,
  CreateRouting,
  HostCredVerdict,
  AgentResumeSupport,
  AgentRuntime,
  AgentCommandText,
  AgentCreateContext,
  PreparedSeed,
  AgentPreflight,
  AgentCreateAdjust,
  AgentBeforeCreateContext,
  AgentCommandHooks,
  HookOutput,
  AgentSubcommands,
  AgentCliSpec,
  AttachWrapped,
  CarryEntries,
} from './agent-contract.js';
export { RESUME_SEED } from './agent-contract.js';
