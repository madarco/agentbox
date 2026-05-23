import { confirm, isCancel, log, multiselect } from '@clack/prompts';
import { findProjectRoot } from '@agentbox/config';
import type { ProviderName } from '@agentbox/core';
import { DEFAULT_ENV_PATTERNS, scanHostEnvFiles } from '@agentbox/sandbox-docker';
import { basename } from 'node:path';
import { checkpointExistsForProvider } from './checkpoint-lookup.js';

/**
 * In-box absolute path to the setup guide markdown (baked into the box image
 * by Dockerfile.box). Stable so the wizard's initial-prompt can reference it.
 *
 * The `/agentbox-setup` skill is installed **box-only**: at create /
 * `claude start` time `seedSetupSkillIntoVolume()`
 * (packages/sandbox-docker/src/claude.ts) copies this same file into the
 * claude-config volume's `skills/agentbox-setup/SKILL.md`. We deliberately
 * never write it to the host's ~/.claude so `agentbox` doesn't pollute the
 * user's machine.
 */
export const IN_BOX_SETUP_GUIDE_PATH = '/usr/local/share/agentbox/setup-guide.md';

export function buildSetupInitialPrompt(workspace: string): string {
  const name = basename(workspace);
  return (
    `The user just opened a new agentbox sandbox for "${name}" but the workspace has no agentbox.yaml yet. ` +
    `Please run the /agentbox-setup skill (or read ${IN_BOX_SETUP_GUIDE_PATH} if the skill is not loaded), ` +
    `then explore /workspace and propose an agentbox.yaml. Save the file to /workspace/agentbox.yaml. ` +
    `Then run \`agentbox-ctl reload\` from inside the box so the already-running supervisor applies the new config ` +
    `and immediately runs the declared tasks and autostarts the services (no box restart needed). ` +
    `When done, summarise what services and tasks you declared, and remind the user how to land the file on the host ` +
    `(commit through the bind-mounted .git, or "agentbox download env" on the host).`
  );
}

export type WizardAction = 'proceed' | 'switch-to-claude' | 'launch-with-prompt';

export interface WizardOutcome {
  action: WizardAction;
  initialPrompt?: string;
  /**
   * Files the user picked in the env-import multiselect (relative to the
   * workspace, NUL-safe). Empty/undefined = no copy. Threaded into
   * `createBox(opts.envFilesToImport)` so the box is seeded with just the
   * selection. Independent of `withEnv` / the wizard's yes/no answer.
   */
  envFilesToImport?: string[];
}

interface WizardArgs {
  workspace: string;
  yes: boolean;
  command: 'create' | 'claude';
  /**
   * Resolved checkpoint ref this box will start from (explicit `--snapshot`
   * or the project's `box.defaultCheckpoint`), if any. When set AND the
   * checkpoint exists for the active provider, the project is already
   * configured: the checkpoint carries the warm state *and* the agentbox.yaml
   * that was present when it was captured, so we skip the "generate one?"
   * prompt entirely. When the checkpoint doesn't exist for the active
   * provider (e.g. a Docker `setup` checkpoint and the user is creating a
   * cloud box), the wizard falls through silently to normal setup.
   */
  checkpointRef?: string;
  /**
   * The provider this box will be created on. Used to scope the
   * `checkpointRef` lookup so the wizard only announces "starting from
   * checkpoint …" when the artifact actually exists for the target.
   */
  provider?: ProviderName;
  /**
   * True when the caller already opted in to importing the full
   * DEFAULT_ENV_PATTERNS set (`--with-env` / `box.withEnv: true`). The
   * env-file multiselect is suppressed in that case — the user pre-decided.
   */
  withEnv?: boolean;
}

/**
 * Sentinel env var set by `agentbox create` when it re-dispatches to
 * `agentbox claude`. It tells the inner wizard the user has already
 * confirmed: skip the prompts and slot the initial setup prompt for claude.
 */
export const WIZARD_AUTOLAUNCH_ENV = 'AGENTBOX_WIZARD_AUTOLAUNCH';

/**
 * Sibling sentinel to `WIZARD_AUTOLAUNCH_ENV`: when `agentbox create`
 * re-dispatches to `agentbox claude`, the user's env-file multiselect picks
 * ride across the boundary in this env var, NUL-delimited (filenames can
 * contain newlines but never NUL). The inner wizard parses + acts on it,
 * then the caller is expected to delete it (mirrors the autolaunch sentinel).
 */
export const WIZARD_ENV_FILES_ENV = 'AGENTBOX_WIZARD_ENV_FILES';

/**
 * Patterns scanned for the wizard's env-file multiselect. Same set as
 * `--with-env` minus `agentbox.yaml`: the wizard fires precisely *because*
 * there's no agentbox.yaml on the host, so it can never be a match.
 */
const WIZARD_ENV_SCAN_PATTERNS = DEFAULT_ENV_PATTERNS.filter((p) => p !== 'agentbox.yaml');

export async function maybeRunSetupWizard(args: WizardArgs): Promise<WizardOutcome> {
  // Re-entry from agentbox create → claude: outer pass already prompted;
  // just inject the initial prompt for claude. Env-file picks were stashed by
  // the outer pass in WIZARD_ENV_FILES_ENV and need to flow through this
  // outcome so claude's action handler can pass them to createBox.
  if (process.env[WIZARD_AUTOLAUNCH_ENV] === '1') {
    if (args.command !== 'claude') return { action: 'proceed' };
    const envFiles = parseEnvFilesFromEnv(process.env[WIZARD_ENV_FILES_ENV]);
    if (args.checkpointRef && (await checkpointAppliesHere(args))) {
      return { action: 'proceed', envFilesToImport: envFiles };
    }
    const proj = await findProjectRoot(args.workspace);
    if (proj.hasAgentboxYaml) return { action: 'proceed', envFilesToImport: envFiles };
    return {
      action: 'launch-with-prompt',
      initialPrompt: buildSetupInitialPrompt(proj.root),
      envFilesToImport: envFiles,
    };
  }

  if (args.yes) return { action: 'proceed' };
  if (!process.stdin.isTTY) return { action: 'proceed' };

  const proj = await findProjectRoot(args.workspace);
  if (proj.hasAgentboxYaml) return { action: 'proceed' };

  // A configured default checkpoint means the project is already set up — the
  // checkpoint carries node_modules/env *and* the agentbox.yaml from when it
  // was captured. Don't nag to regenerate one. Skip env-file picker too: the
  // checkpoint already has whatever was on disk when it was captured.
  //
  // …but only if the checkpoint exists for the ACTIVE provider. A
  // `box.defaultCheckpoint` resolved against the wrong provider's store would
  // mislead the user — wizard announces the skip, then the cloud-provider
  // create silently drops the ref because the snapshot doesn't exist for
  // daytona. Silently fall through to normal setup instead.
  if (args.checkpointRef && (await checkpointAppliesHere(args))) {
    log.info(`starting from checkpoint "${args.checkpointRef}"; skipping agentbox.yaml setup`);
    return { action: 'proceed' };
  }

  // Env-file multiselect — runs *before* the "run setup wizard?" confirm so
  // it's independent of that answer. Suppressed when --with-env is on
  // (the user already opted in to importing the full DEFAULT_ENV_PATTERNS
  // set). Skipped silently when nothing matched.
  let envFilesToImport: string[] | undefined;
  if (!args.withEnv) {
    const found = await scanHostEnvFiles(proj.root, WIZARD_ENV_SCAN_PATTERNS);
    if (found.length > 0) {
      const picked = await multiselect<string>({
        message: 'Import host env/secret files into the box? (space to toggle, enter to confirm)',
        options: found.map((p) => ({ value: p, label: p })),
        initialValues: found,
        required: false,
      });
      if (!isCancel(picked) && Array.isArray(picked) && picked.length > 0) {
        envFilesToImport = picked;
      }
    }
  }

  const go = await confirm({
    message: 'New project detected, run setup wizard?',
    initialValue: true,
  });
  if (isCancel(go) || !go) return { action: 'proceed', envFilesToImport };

  // The /agentbox-setup skill is seeded into the box's claude-config volume
  // by seedSetupSkillIntoVolume() (sandbox-docker) — box-only, never written
  // to the host's ~/.claude.

  // For `agentbox create`, the only sensible yes-path is to hand off to
  // `agentbox claude` (that's where the agent runs). No second prompt — the
  // first confirm already captured the user's intent.
  if (args.command === 'create') return { action: 'switch-to-claude', envFilesToImport };

  return {
    action: 'launch-with-prompt',
    initialPrompt: buildSetupInitialPrompt(proj.root),
    envFilesToImport,
  };
}

/**
 * True when `args.checkpointRef` resolves to an artifact in the active
 * provider's checkpoint store. Falls back to `true` only when no `checkpointRef`
 * is set (caller checked already). Resolves the project root from the workspace
 * so the lookup uses the same hash the `agentbox checkpoint create` flow
 * persists under.
 */
async function checkpointAppliesHere(args: WizardArgs): Promise<boolean> {
  if (!args.checkpointRef) return false;
  const proj = await findProjectRoot(args.workspace);
  const provider = args.provider ?? 'docker';
  return checkpointExistsForProvider(provider, proj.root, args.checkpointRef);
}

/** Serialize the multiselect picks for the create→claude re-dispatch. */
export function serializeEnvFilesForEnv(files: string[] | undefined): string | undefined {
  if (!files || files.length === 0) return undefined;
  // NUL is illegal in POSIX filenames so it's a safe delimiter even though
  // env-var values can contain newlines (which legal filenames also can).
  return files.join('\0');
}

/** Inverse of `serializeEnvFilesForEnv`. Empty/undefined input → undefined. */
export function parseEnvFilesFromEnv(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const out = raw.split('\0').filter((p) => p.length > 0);
  return out.length > 0 ? out : undefined;
}

/**
 * Map the create command's parsed options to an argv that can be re-dispatched
 * through `claudeCommand.parseAsync(['node', 'agentbox', 'claude', ...args])`.
 * `--yes` is intentionally NOT passed through here: the wizard already prompted
 * the user, and forwarding `--yes` would suppress the first-run auth guidance
 * that the user typically wants.
 */
export interface CreatePassthroughOptions {
  workspace?: string;
  name?: string;
  hostSnapshot?: boolean;
  snapshot?: string;
  image?: string;
  withPlaywright?: boolean;
  vnc?: boolean;
  sharedDockerCache?: boolean;
  portless?: boolean;
}

export function passthroughFlags(opts: CreatePassthroughOptions): string[] {
  const out: string[] = [];
  if (opts.workspace) out.push('--workspace', opts.workspace);
  if (opts.name) out.push('--name', opts.name);
  if (opts.hostSnapshot === true) out.push('--host-snapshot');
  if (opts.hostSnapshot === false) out.push('--no-host-snapshot');
  if (opts.snapshot) out.push('--snapshot', opts.snapshot);
  if (opts.image) out.push('--image', opts.image);
  if (opts.withPlaywright === true) out.push('--with-playwright');
  if (opts.vnc === false) out.push('--no-vnc');
  if (opts.sharedDockerCache === true) out.push('--shared-docker-cache');
  if (opts.portless === true) out.push('--portless');
  if (opts.portless === false) out.push('--no-portless');
  return out;
}
