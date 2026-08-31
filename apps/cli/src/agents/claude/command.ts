/**
 * `agentbox claude` — the descriptor.
 *
 * Claude is the agent the factory's hook set exists for. Five of them are used
 * here and nowhere else: the `--plan` pre-flight beside session teleport, the
 * first-run setup wizard, the plugin-native-deps rebuild on create and on start,
 * and the clipboard paste handlers on attach.
 */
import { resolveAgentSpec } from '@agentbox/sandbox-core';
import { syncClaudeCredentials } from '@agentbox/sandbox-docker';
import { rebuildPluginNativeDeps, SHARED_CLAUDE_VOLUME } from '@agentbox/agent-claude';
import type { Command } from 'commander';
import { log } from '@agentbox/cli-kit';
import { buildAgentCommand } from '../command/factory.js';
import { evaluateBaseFreshness } from '../../checkpoint-lookup.js';
import { clipboardCaptureAvailable } from '../../lib/host-clipboard.js';
import { maybeShowInstallHint } from '../../lib/install-hint.js';
import { pasteHostClipboardImage, uploadImageFileToBox } from '../../lib/paste-image.js';
import { buildPromptArgs } from '../../lib/queue/build-prompt-args.js';
import { providerForBox } from '../../provider/registry.js';
import { runPrepare } from '../../commands/prepare.js';
import { TeleportError } from '../../session-teleport/index.js';
import { resolvePlanTeleport } from '../../session-teleport/plan.js';
import { maybeRunSetupWizard } from '../../wizard.js';
import { claudeRuntime } from '@agentbox/agent-claude/cli';

const spec = resolveAgentSpec('claude');

/**
 * What the plugin-native-deps rebuild has to say, as callbacks the caller runs
 * after the spinner stops: how much the prune reclaimed, and any plugin whose
 * install failed.
 */
function pruneOutput(rebuild: {
  pruned: string[];
  prunedBytes: number;
  failed: { dir: string; stderr: string }[];
}): (() => void)[] {
  const out: (() => void)[] = [];
  if (rebuild.prunedBytes > 0) {
    const mb = Math.round(rebuild.prunedBytes / 1024 / 1024);
    const n = rebuild.pruned.length;
    out.push(() =>
      log.info(
        `pruned ${String(n)} stale plugin cache${n === 1 ? '' : 's'} (${String(mb)} MB freed)`,
      ),
    );
  }
  for (const f of rebuild.failed) {
    out.push(() =>
      log.warn(
        `plugin install failed for ${f.dir}; claude may still load it. stderr:\n${f.stderr.trim()}`,
      ),
    );
  }
  return out;
}

/** The `--plan` seed, so `beforeCreate` can build its "resume the plan" turn. */
const PLAN_SEED = 'plan';

const { command, attachWrapped } = buildAgentCommand({
  id: 'claude',
  spec,
  productName: 'Claude Code',
  shortName: 'Claude',
  runtime: claudeRuntime,
  acceptsSeedPrompt: true,
  // Ahead of the setup wizard, which can spend minutes re-baking a stale base:
  // ask the user to sign in before, not after.
  signInOfferTiming: 'before-gates',
  text: {
    description: 'Create a sandboxed box and launch Claude Code in a detachable tmux session',
    isolateVolumeLabel: '~/.claude',
    syncConfigLabel: '~/.claude',
    argsExample: '--model sonnet',
    resumeIdWord: 'id',
    verboseExtra: ' (docker build / Daytona snapshot create)',
    initialPromptExtra:
      " NOTE: this is NOT claude's own `-p` headless print mode — for that, pass `-- -p ...`.",
    continueHelp:
      'teleport the most recent host Claude Code session for this cwd into the box and resume from it',
    resumeHelp:
      'teleport the specified host Claude Code session id into the box and resume from it',
    startContinueHelp:
      'teleport the most recent host Claude Code session for this cwd into the box and resume',
    startResumeHelp: 'teleport the specified host Claude Code session id into the box and resume',
    attachDescription:
      'Attach to a Claude Code tmux session in a box, starting one if none is running (auto-unpause/start; never re-syncs ~/.claude — use `claude start` for that)',
    startDescription:
      'Start a Claude Code tmux session in an already-existing box (auto-unpause/start). If a session is already running, just attach.',
    loginDescription:
      'Sign in to Claude for use in sandboxes (forwards args to `claude auth login`, e.g. --sso, --console). Runs in a throwaway container against the shared claude-config volume — usable before the first `agentbox claude`. In a terminal it prints the auth URL and prompts for the code. Non-interactive (no TTY) or `--headless`: prints the auth URL, then finish with `--code <CODE>`.',
    loginArgsHelp:
      'extra args forwarded to `claude auth login`; place after `--`, e.g. `agentbox claude login -- --sso`',
    loginInteractiveHelp:
      "attach your terminal to claude's own login TUI (legacy passthrough; try this if the guided prompt can't drive your login method)",
    resumeWithPromptError:
      '-i / --initial-prompt cannot be combined with -c / --resume (seeding a new turn into a resumed session is not supported).',
    hubIncompatibleReason:
      '--via-hub is ignored for --resume / --plan runs (they teleport host state at create time); building this box locally.',
    resumeIntoRunningError: (boxName) =>
      `cannot resume into ${boxName}: a Claude session is already running. Detach and kill the session first (Control+a then :kill-session), or use \`agentbox claude attach\` to reattach to the live one.`,
  },
  hooks: {
    /**
     * `--plan`: copy a host plan file into the box, start in plan mode and seed
     * a "resume the plan" turn. The `-c` / `--resume` half is shared — `base` is
     * what the body already resolved — so this only adds claude's own payload.
     */
    async preflight(ctx, base) {
      const opts = ctx.opts as { initialPrompt?: string; plan?: string };
      if (!opts.plan) return base;
      // --plan seeds an interactive "resume the plan" turn, which is
      // incompatible with -i's background-queue mode (the same reason resume +
      // -i is rejected).
      if (opts.initialPrompt && opts.initialPrompt.length > 0) {
        ctx.fail(
          '--plan cannot be combined with -i / --initial-prompt (--plan already seeds an interactive "resume the plan" turn).',
        );
      }
      try {
        // forwardArgs is empty: the plan drives the prompt + permission-mode
        // through `argsTransform` below, not through resume flags.
        const resolved = await resolvePlanTeleport({
          planPath: opts.plan,
          hostCwd: ctx.workspace,
          log: ctx.writeLog,
        });
        return {
          ...base,
          seeds: [
            ...base.seeds,
            {
              label: 'uploading plan into box',
              tag: PLAN_SEED,
              resolved,
              forwardArgs: [],
              ownsFirstTurn: true,
            },
          ],
          hubIncompatible: true,
        };
      } catch (err) {
        if (err instanceof TeleportError) ctx.fail(err.message);
        throw err;
      }
    },

    /**
     * First-run wizard: with no agentbox.yaml, offer to inject an initial user
     * message so claude reads /agentbox-setup and writes one. It can also
     * re-bake a stale base and discard a dead default checkpoint.
     */
    async beforeCreate(ctx) {
      const opts = ctx.opts as { workspace: string; yes?: boolean; snapshot?: string };
      const planSessionId = ctx.preflight.seeds.find((x) => x.tag === PLAN_SEED)?.resolved
        .sessionId;
      // Base freshness: cloud providers store a fingerprint of the baked runtime;
      // if the local install no longer matches, the wizard offers to rebuild
      // before creating. Docker self-heals via `ensureImage`, so its baseStatus
      // is always `fresh` and the wizard is a no-op there.
      //
      // Resolved against the ROUTE, not just the provider: a hub-routed create is
      // built on the control box from ITS base, so this machine's base is
      // irrelevant to it. Asking to spend minutes re-baking locally — for a box
      // that never touches the result — is pure waste, and it is exactly what a
      // PC sees whenever the control box has re-baked and the PC hasn't.
      const buildsOnHub = (await ctx.routing()).where === 'hub' && !ctx.preflight.hubIncompatible;
      const baseStatus = buildsOnHub
        ? undefined
        : await evaluateBaseFreshness(ctx.providerName, ctx.cfg.box.claudeInstall);
      const wiz = await maybeRunSetupWizard({
        workspace: opts.workspace,
        yes: !!opts.yes,
        command: 'claude',
        checkpointRef: ctx.checkpointRef,
        checkpointFromDefault: !(opts.snapshot && opts.snapshot.length > 0),
        provider: ctx.providerName,
        withEnv: ctx.cfg.box.withEnv,
        baseStatus,
      });
      // Stale base: the user opted in to rebuilding it. Re-bakes the snapshot /
      // template and refreshes its stored fingerprint, so the subsequent box boots
      // from the fresh base. Runs BEFORE the checkpoint discard so a failure
      // aborts cleanly without leaving a half-created box.
      if (wiz.rebuildBase) {
        log.warn(`${ctx.providerName} base image is outdated; rebuilding before create…`);
        await runPrepare(ctx.providerName, {
          force: true,
          cwd: opts.workspace,
          suppressStatus: true,
        });
      }
      return {
        // The wizard may discard a stale/dead default checkpoint: boot from the
        // current base instead of a dead artifact. An explicit `--snapshot` is
        // never discarded.
        ...(wiz.discardCheckpoint ? { checkpointRef: undefined } : {}),
        ...(wiz.envFilesToImport ? { envFilesToImport: wiz.envFilesToImport } : {}),
        seedsFirstTurn:
          Boolean(planSessionId) ||
          (wiz.action === 'launch-with-prompt' && Boolean(wiz.initialPrompt)),
        argsTransform: (args) => {
          // --plan: enter plan mode and seed a "resume the plan" turn. Adding
          // --permission-mode BEFORE the skip-permissions injection makes the latter
          // treat it as a conflict and skip --dangerously-skip-permissions —
          // plan mode wins.
          if (planSessionId) {
            let out = args;
            const hasPermissionMode = out.some(
              (x) => x === '--permission-mode' || x.startsWith('--permission-mode='),
            );
            if (!hasPermissionMode) out = [...out, '--permission-mode', 'plan'];
            return buildPromptArgs(
              'claude-code',
              `Resume the plan at ~/.claude/plans/${planSessionId}`,
              out,
            );
          }
          if (wiz.action === 'launch-with-prompt' && wiz.initialPrompt) {
            return buildPromptArgs('claude-code', wiz.initialPrompt, args);
          }
          return args;
        },
      };
    },

    /**
     * Plugin native deps: the sync excludes `node_modules` (host darwin binaries
     * don't run on linux/amd64). The first claude session in a fresh box pays the
     * npm-install cost for each plugin that ships a package.json; later attaches
     * see node_modules already present and exit immediately.
     */
    async afterCreate(box, ctx) {
      ctx.message('checking plugin native deps');
      const rebuild = await rebuildPluginNativeDeps(box.container, {
        volume: box.claudeConfigVolume ?? SHARED_CLAUDE_VOLUME,
        onProgress: (line) => ctx.message(line),
      });
      return { deferred: [...pruneOutput(rebuild), () => maybeShowInstallHint()] };
    },

    async afterVolumeSync(box, { volume, message }) {
      // The /agentbox-setup skill is seeded by the shared body from
      // `spec.seeds` — what stays here is real behavior, not file placement.
      // Mirror the in-box OAuth credentials with the host backup. Runs regardless
      // of --no-sync-config (this is not the host ~/.claude rsync) — it keeps the
      // backup fresh as the in-box claude rotates its token, and seeds an isolate
      // box's volume from an up-front sign-in.
      await syncClaudeCredentials(
        { volume },
        { image: box.image, isolate: volume !== SHARED_CLAUDE_VOLUME },
      );
      // Idempotent — gated by a per-plugin marker, so a no-op on later starts
      // unless a new plugin was synced just now.
      message('checking plugin native deps');
      const rebuild = await rebuildPluginNativeDeps(box.container, {
        volume: box.claudeConfigVolume ?? SHARED_CLAUDE_VOLUME,
        onProgress: (line) => message(line),
      });
      return { deferred: pruneOutput(rebuild) };
    },

    /**
     * Only wire Ctrl+V paste when this host can actually capture a clipboard
     * image (macOS, or a Linux desktop with xclip/wl-paste). Elsewhere Ctrl+V
     * forwards verbatim instead of being intercepted for a guaranteed-empty paste.
     */
    async attachExtras(box) {
      if (!(await clipboardCaptureAvailable())) return {};
      const provider = await providerForBox(box);
      return {
        onPasteImage: () => pasteHostClipboardImage(provider, box),
        onPasteImageFile: (p: string) => uploadImageFileToBox(provider, box, p),
      };
    },

    extendCommand(cmd: Command) {
      cmd.option(
        '--plan <path>',
        'copy a Claude Code plan file (e.g. ~/.claude/plans/<slug>.md) into the box, launch claude with --permission-mode plan, and seed a "resume the plan" prompt',
      );
    },
  },
});

export const claudeCommand = command;
export const attachClaudeWrapped = attachWrapped;
