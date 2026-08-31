/**
 * `agentbox claude` — the DESCRIPTOR.
 *
 * Claude is the agent the factory's hook set exists for: the `--plan` pre-flight
 * beside session teleport, the first-run setup wizard, the plugin-native-deps
 * rebuild on create and on start, and the clipboard paste handlers on attach.
 *
 * This file used to live in `apps/cli/src/agents/claude/` — not because claude
 * is special, but because its hooks called UP into the app (`runPrepare`, the
 * wizard, `providerForBox`, the paste helpers). An agent package sits below
 * `apps/cli`, so importing them directly would have closed a cycle.
 *
 * They arrive through `ctx.host` / the `clipboard` argument now, so the
 * descriptor sits with the other three and the app keeps only the pipeline.
 */
import type { AgentCliSpec } from '@agentbox/cli-kit';
import { log, TeleportError } from '@agentbox/cli-kit';
import { resolveAgentLauncher } from '@agentbox/core';
import { resolveAgentSpec } from '@agentbox/sandbox-core';
import { syncClaudeCredentials } from '@agentbox/sandbox-docker';
import type { Command } from 'commander';
import { rebuildPluginNativeDeps, SHARED_CLAUDE_VOLUME } from '../docker-sync.js';
import { claudeRuntime } from './runtime.js';
import { BOX_CLAUDE_PLANS_DIR } from './projects-dir.js';

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

export const claudeCliSpec: Omit<AgentCliSpec, 'attachWrapped'> = {
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
        const resolved = await ctx.host.resolvePlanFile({
          path: opts.plan,
          hostCwd: ctx.workspace,
          log: ctx.writeLog,
          boxParentDir: BOX_CLAUDE_PLANS_DIR,
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
      // Grading the base, re-baking a stale one and routing all live behind the
      // seam (`AgentHostServices.setupWizard`) — none of it was claude behavior.
      const wiz = await ctx.host.setupWizard({
        checkpointFromDefault: !(opts.snapshot && opts.snapshot.length > 0),
      });
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
            return resolveAgentLauncher('claude-code').buildArgs(
              `Resume the plan at ~/.claude/plans/${planSessionId}`,
              out,
            );
          }
          if (wiz.action === 'launch-with-prompt' && wiz.initialPrompt) {
            return resolveAgentLauncher('claude-code').buildArgs(wiz.initialPrompt, args);
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
      return { deferred: [...pruneOutput(rebuild), () => ctx.host.showInstallHint()] };
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
    async attachExtras(box, clipboard) {
      if (!(await clipboard.available())) return {};
      return {
        onPasteImage: () => clipboard.pasteImage(box),
        onPasteImageFile: (p: string) => clipboard.pasteImageFile(box, p),
      };
    },

    extendCommand(cmd: Command) {
      cmd.option(
        '--plan <path>',
        'copy a Claude Code plan file (e.g. ~/.claude/plans/<slug>.md) into the box, launch claude with --permission-mode plan, and seed a "resume the plan" prompt',
      );
    },
  },
};
