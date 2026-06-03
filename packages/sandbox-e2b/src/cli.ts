/**
 * `agentbox e2b` CLI surface — registered as a top-level subcommand by
 * `apps/cli/src/index.ts` (same pattern as `daytonaCommand` / `vercelCommand`).
 *
 * Subcommands:
 *   - `login`            — interactive credential setup (paste an API key).
 *   - `login --status`   — show what is currently configured (masked).
 *
 * Also provides the `agentbox e2b create|claude|codex|opencode` sugar via the
 * argv-prefix rewriter in apps/cli.
 */

import { log } from '@clack/prompts';
import { Command } from 'commander';
import {
  ensureE2bCredentials,
  maskKey,
  readE2bCredStatus,
  secretsPath,
} from './credentials.js';
import { readPreparedState } from './prepared-state.js';

interface LoginOpts {
  status?: boolean;
}

function reportError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  log.error(message);
  process.exitCode = 1;
}

function printStatus(): void {
  const s = readE2bCredStatus();
  if (s.auth === 'none') {
    process.stdout.write(
      'e2b: not configured\n' + '  run `agentbox e2b login` to set up credentials\n',
    );
    return;
  }
  const lines = ['e2b: configured', '  auth:   API key'];
  if (s.token) lines.push(`  token:  ${maskKey(s.token)}`);
  lines.push(`  source: ${s.source}`);
  if (s.source === 'secrets.env') lines.push(`  file:   ${secretsPath()}`);
  process.stdout.write(lines.join('\n') + '\n');
}

const loginSub = new Command('login')
  .description('Set up (or rotate) E2B credentials for sandbox boxes')
  .option('--status', 'show what is currently configured (masked) and exit')
  .action(async (opts: LoginOpts) => {
    try {
      if (opts.status) {
        printStatus();
        return;
      }
      if (!process.stdin.isTTY) {
        process.stderr.write(
          'e2b login needs an interactive terminal — set E2B_API_KEY in the environment ' +
            'or in ~/.agentbox/secrets.env for non-interactive use.\n',
        );
        process.exitCode = 1;
        return;
      }
      await ensureE2bCredentials({ force: true });
      // Credentials alone don't get a user a working box — they also need a
      // baked base template. Nudge the user toward `prepare` here so the
      // login → first-create path doesn't hit the (otherwise-clean) "no base
      // template found" error from `ensureE2bBaseTemplate`. No layering break
      // (provider package stays free of the `runPrepare` dependency); the
      // `agentbox install` wizard already calls `runPrepare` directly.
      if (readPreparedState().base === undefined) {
        log.info(
          'Base template not built yet — run `agentbox prepare --provider e2b` (or `agentbox install`) to bake it.',
        );
      }
    } catch (err) {
      reportError(err);
    }
  });

export const e2bCommand = new Command('e2b')
  .description(
    'E2B sandbox provider — credentials, plus sugar for `--provider e2b` ' +
      '(e.g. `agentbox e2b create|claude|codex|opencode`)',
  )
  .addCommand(loginSub, { isDefault: true });
