/**
 * `agentbox vercel` CLI surface — registered as a top-level subcommand by
 * `apps/cli/src/index.ts` (same pattern as `daytonaCommand` / `hetznerCommand`).
 *
 * Subcommands:
 *   - `login`            — interactive credential setup (OIDC or token trio).
 *   - `login --status`   — show what is currently configured (masked).
 *
 * Also provides the `agentbox vercel create|claude|codex|opencode` sugar via
 * the argv-prefix rewriter in apps/cli.
 */

import { log } from '@clack/prompts';
import { Command } from 'commander';
import {
  ensureVercelCredentials,
  maskKey,
  readVercelCredStatus,
  secretsPath,
} from './credentials.js';

interface LoginOpts {
  status?: boolean;
}

function reportError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  log.error(message);
  process.exitCode = 1;
}

function printStatus(): void {
  const s = readVercelCredStatus();
  if (s.source === 'none') {
    process.stdout.write(
      'vercel: not configured\n' +
        '  run `agentbox vercel login` to set up credentials\n',
    );
    return;
  }
  const lines = ['vercel: configured', `  source: ${s.source}`];
  if (s.oidc) lines.push('  auth:   OIDC token (VERCEL_OIDC_TOKEN)');
  if (s.token) lines.push(`  token:  ${maskKey(s.token)}`);
  if (s.teamId) lines.push(`  team:   ${s.teamId}`);
  if (s.projectId) lines.push(`  project: ${s.projectId}`);
  if (s.source === 'secrets.env') lines.push(`  file:   ${secretsPath()}`);
  process.stdout.write(lines.join('\n') + '\n');
}

const loginSub = new Command('login')
  .description('Set up (or rotate) Vercel credentials for sandbox boxes')
  .option('--status', 'show what is currently configured (masked) and exit')
  .action(async (opts: LoginOpts) => {
    try {
      if (opts.status) {
        printStatus();
        return;
      }
      if (!process.stdin.isTTY) {
        process.stderr.write(
          'vercel login needs an interactive terminal — set VERCEL_OIDC_TOKEN ' +
            '(via `vercel env pull`) or the VERCEL_TOKEN trio in the environment for non-interactive use.\n',
        );
        process.exitCode = 1;
        return;
      }
      await ensureVercelCredentials({ force: true });
    } catch (err) {
      reportError(err);
    }
  });

export const vercelCommand = new Command('vercel')
  .description(
    'Vercel Sandbox provider — credentials, plus sugar for `--provider vercel` ' +
      '(e.g. `agentbox vercel create|claude|codex|opencode`)',
  )
  .addCommand(loginSub, { isDefault: true });
