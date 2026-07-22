/**
 * `agentbox tenki` CLI surface — registered as a top-level subcommand by
 * `apps/cli/src/index.ts` (same pattern as `e2bCommand` / `vercelCommand`).
 *
 * Subcommands:
 *   - `login`            — interactive credential setup (paste an auth token).
 *   - `login --status`   — show what is currently configured (masked).
 *
 * Also provides the `agentbox tenki create|claude|codex|opencode` sugar via the
 * argv-prefix rewriter in apps/cli.
 */

import { log } from '@clack/prompts';
import { Command } from 'commander';
import {
  ensureTenkiCredentials,
  maskKey,
  readTenkiCredStatus,
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
  const s = readTenkiCredStatus();
  if (s.auth === 'none') {
    process.stdout.write(
      'tenki: not configured\n' + '  run `agentbox tenki login` to set up credentials\n',
    );
    return;
  }
  const lines = ['tenki: configured', '  auth:   auth token'];
  if (s.token) lines.push(`  token:  ${maskKey(s.token)}`);
  lines.push(`  source: ${s.source}`);
  if (s.source === 'secrets.env') lines.push(`  file:   ${secretsPath()}`);
  process.stdout.write(lines.join('\n') + '\n');
}

const loginSub = new Command('login')
  .description('Set up (or rotate) Tenki credentials for sandbox boxes')
  .option('--status', 'show what is currently configured (masked) and exit')
  .action(async (opts: LoginOpts) => {
    try {
      if (opts.status) {
        printStatus();
        return;
      }
      if (!process.stdin.isTTY) {
        process.stderr.write(
          'tenki login needs an interactive terminal — set TENKI_AUTH_TOKEN in the environment ' +
            'or in ~/.agentbox/secrets.env for non-interactive use.\n',
        );
        process.exitCode = 1;
        return;
      }
      await ensureTenkiCredentials({ force: true });
      // Credentials alone don't get a user a working box — they also need a
      // prepared base image. Nudge toward `prepare` so the login → first-create
      // path doesn't hit the (otherwise-clean) "no base image found" error.
      if (readPreparedState().base === undefined) {
        log.info(
          'Base image not prepared yet — run `agentbox prepare --provider tenki` (or `agentbox install`) to publish it.',
        );
      }
    } catch (err) {
      reportError(err);
    }
  });

export const tenkiCommand = new Command('tenki')
  .description(
    'Tenki sandbox provider — credentials, plus sugar for `--provider tenki` ' +
      '(e.g. `agentbox tenki create|claude|codex|opencode`)',
  )
  .addCommand(loginSub, { isDefault: true });
