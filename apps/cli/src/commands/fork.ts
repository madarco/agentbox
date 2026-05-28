import { log } from '@clack/prompts';
import { Command } from 'commander';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { detectHostTerminal } from '../terminal/host.js';
import { encodeClaudeProjectsDir } from '../session-teleport/cwd-encoding.js';
import { claudeCommand } from './claude.js';

interface ForkOptions {
  workspace: string;
  session?: string;
  provider?: string;
  name?: string;
  attachIn?: string;
  carryYes?: boolean;
}

/** fork's attach modes: claude's split|window|tab|same plus `background`
 *  (never attach — always leave Claude running in the box). */
const FORK_ATTACH_VALUES = ['window', 'tab', 'split', 'background', 'same'] as const;

/** Two host JSONLs both touched inside this window means we can't safely guess
 *  which Claude window the user meant — they must pass --session. */
const RECENT_SESSION_MS = 5 * 60 * 1000;

/** `--resume <id>` when --session is given; otherwise `--continue`, but refuse
 *  first if several sessions in this cwd were written to recently (ambiguous —
 *  the newest-by-mtime heuristic claude's `--continue` uses would be a guess). */
function resolveSessionArgs(opts: ForkOptions): string[] {
  if (opts.session) return ['--resume', opts.session];
  const dir = join(homedir(), '.claude', 'projects', encodeClaudeProjectsDir(opts.workspace));
  if (!existsSync(dir)) return ['--continue']; // claude emits the clear "run claude here first" error
  const now = Date.now();
  const recent = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      try {
        return statSync(join(dir, f)).mtimeMs;
      } catch {
        return 0;
      }
    })
    .filter((m) => now - m < RECENT_SESSION_MS);
  if (recent.length > 1) {
    throw new Error(
      `multiple recent Claude sessions for this cwd — pass --session <id> to choose. List them with: ls "${dir}"`,
    );
  }
  return ['--continue'];
}

/** Default box name when -n is omitted: tags forks distinctly in `agentbox list`. */
function defaultForkName(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `fork-${hh}${mm}${ss}`;
}

/**
 * Translate fork's `--attach-in` + the detected host terminal into the claude
 * flag that produces the right behavior. The key difference from a bare
 * `agentbox claude --attach-in window` is the fallback: when no tmux/iTerm is
 * present, fork goes to **background** (`--no-attach`) rather than inline
 * attach — fork is typically driven from another Claude (the `/agentbox`
 * slash command's subagent), whose terminal must not be taken over.
 */
function resolveAttachArgs(attachIn: string): string[] {
  if (attachIn === 'background') return ['--no-attach'];
  if (attachIn === 'same') return ['--attach-in', 'same'];
  // window | tab | split: spawn a new pane only if we can; else background.
  return detectHostTerminal() === 'unknown' ? ['--no-attach'] : ['--attach-in', attachIn];
}

export const forkCommand = new Command('fork')
  .description(
    'Fork the current host Claude Code session into a new box and resume it there. Opens the box in a new terminal tab under iTerm/tmux; otherwise starts it in the background.',
  )
  .option('-w, --workspace <path>', 'host workspace to mount', process.cwd())
  .option(
    '--session <id>',
    'host Claude Code session id to resume (default: the newest session for this cwd; refuses if several were used recently)',
  )
  .option('--provider <name>', "sandbox backend: 'docker' (default), 'daytona', or 'hetzner'")
  .option('-n, --name <name>', 'box name (default: fork-<HHMMSS>)')
  .option(
    '--attach-in <mode>',
    'where to open the forked session: window | tab | split | background | same (default: tab). Falls back to background outside tmux/iTerm.',
  )
  .option(
    '--carry-yes',
    "auto-approve agentbox.yaml's carry: block (fork skips carry by default — it does not silently re-copy host files into the new box)",
  )
  .action(async (opts: ForkOptions) => {
    // Box→box guard: AGENTBOX_RELAY_URL is only set inside a box. Fork teleports
    // a *host* Claude session into a new box; it can't run from inside one yet.
    // Checked here (not just in the /agentbox skill) so an LLM that calls the
    // CLI directly still gets a clear refusal instead of a confusing failure.
    if ((process.env.AGENTBOX_RELAY_URL ?? '').trim().length > 0) {
      log.error(
        'agentbox fork runs on the host only: it teleports a host Claude Code session into a new box. You appear to be inside a box (AGENTBOX_RELAY_URL is set) — box→box fork is not supported yet.',
      );
      process.exit(2);
    }

    const attachIn = opts.attachIn ?? 'tab';
    if (!(FORK_ATTACH_VALUES as readonly string[]).includes(attachIn)) {
      log.error(`--attach-in: expected one of ${FORK_ATTACH_VALUES.join(', ')}, got "${attachIn}"`);
      process.exit(2);
    }

    // Tolerate an LLM passing `--provider ""` (or whitespace): treat a blank
    // value as "not passed" so it falls through to the default docker provider.
    const provider = opts.provider?.trim();

    let sessionArgs: string[];
    try {
      sessionArgs = resolveSessionArgs(opts);
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    }

    const subArgv = [
      '-y',
      ...(opts.carryYes ? ['--carry-yes'] : ['--carry', 'skip']),
      '-w',
      opts.workspace,
      '-n',
      opts.name ?? defaultForkName(),
      ...(provider ? ['--provider', provider] : []),
      ...sessionArgs,
      ...resolveAttachArgs(attachIn),
    ];

    // Delegate to the existing `claude` create+teleport+attach pipeline. It
    // runs prepareTeleport (pre-flight) -> createBox -> uploadTeleport ->
    // startClaudeSession, and (for --attach-in window) spawnInNewTerminal. The
    // action terminates the process itself (process.exit) on every path.
    await claudeCommand.parseAsync(subArgv, { from: 'user' });
  });
