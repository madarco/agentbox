/**
 * `agentbox codex` — the descriptor, not the implementation.
 *
 * Everything structural lives in `../command/`; what is here is the text that is
 * genuinely Codex's (and not just the word "codex" substituted into a shared
 * sentence) plus the one place Codex runs its own code inside the shared body.
 */
import { buildAgentCommand } from '../command/factory.js';
import { resolveAgentSpec } from '@agentbox/sandbox-core';
import { prepareTeleport, TeleportError, type ResumeMode } from '../../session-teleport/index.js';
import { codexRuntime, seedCodexActivityHooks } from './runtime.js';

const spec = resolveAgentSpec('codex');

const { command, attachWrapped } = buildAgentCommand({
  id: 'codex',
  spec,
  productName: 'OpenAI Codex',
  shortName: 'Codex',
  runtime: codexRuntime,
  acceptsSeedPrompt: true,
  signInOfferTiming: 'before-create',
  text: {
    description: 'Create a sandboxed box and launch OpenAI Codex in a detachable tmux session',
    isolateVolumeLabel: '~/.codex',
    syncConfigLabel: '~/.codex',
    argsExample: '-m gpt-5.4',
    resumeIdWord: 'uuid',
    continueHelp:
      'teleport the most recent host Codex session for this cwd into the box and resume from it',
    resumeHelp: 'teleport the specified host Codex session uuid into the box and resume from it',
    startContinueHelp:
      'teleport the most recent host Codex session for this cwd into the box and resume',
    startResumeHelp: 'teleport the specified host Codex session uuid into the box and resume',
    attachDescription:
      'Attach to a Codex tmux session in a box, starting one if none is running (auto-unpause/start; never re-syncs ~/.codex — use `codex start` for that)',
    startDescription:
      'Start a Codex tmux session in an already-existing box (auto-unpause/start). If a session is already running, just attach.',
    loginDescription:
      'Sign in to Codex for use in sandboxes. Runs `codex login` in a throwaway container against the shared codex-config volume (default: --device-auth; pass e.g. `-- --api-key`). Usable before the first `agentbox codex`.',
    loginArgsHelp:
      'extra args forwarded to `codex login` (default: --device-auth); place after `--`, e.g. `agentbox codex login -- --api-key`',
    loginInteractiveHelp:
      "attach your terminal to codex's own login TUI (legacy passthrough; needs an interactive terminal)",
    resumeIntoRunningError: (boxName) =>
      `cannot resume into ${boxName}: a Codex session is already running. Kill it first or use \`agentbox codex attach\`.`,
  },
  hooks: {
    /**
     * Resolve the host session BEFORE any box work so a missing session id fails
     * fast — the user doesn't pay for a doomed box.
     */
    async preflight(ctx) {
      const opts = ctx.opts as { continue?: boolean; resume?: string; initialPrompt?: string };
      let mode: ResumeMode | null = null;
      if (opts.continue === true && opts.resume) {
        ctx.fail('only one of -c / --continue / --resume can be passed');
      }
      if (opts.continue === true) mode = { kind: 'continue' };
      else if (opts.resume) mode = { kind: 'resume', id: opts.resume };
      if (mode && opts.initialPrompt && opts.initialPrompt.length > 0) {
        ctx.fail('-i / --initial-prompt cannot be combined with -c / --resume.');
      }
      if (!mode) return { seeds: [] };
      try {
        const resolved = await prepareTeleport({
          agent: 'codex',
          hostCwd: ctx.workspace,
          mode,
          log: ctx.writeLog,
        });
        return {
          seeds: [
            {
              label: 'uploading codex session into box',
              resolved,
              forwardArgs: resolved.forwardArgs,
              ownsFirstTurn: true,
            },
          ],
          hubIncompatible: true,
          hubIncompatibleReason:
            '--via-hub is ignored for --resume runs (they teleport host state at create time); building this box locally.',
        };
      } catch (err) {
        if (err instanceof TeleportError) ctx.fail(err.message);
        throw err;
      }
    },
    async afterVolumeSync(_box, { volume }) {
      await seedCodexActivityHooks(volume, _box.image);
    },
  },
});

export const codexCommand = command;
export const attachCodexWrapped = attachWrapped;
