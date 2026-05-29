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
import { detectSbx, installSbxHint } from './sbx-cli.js';

interface LoginOpts {
  status?: boolean;
}

function reportError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  log.error(message);
  process.exitCode = 1;
}

function relativeExpiry(expiresAt: number): string {
  const deltaMs = expiresAt * 1000 - Date.now();
  if (deltaMs <= 0) return 'expired';
  const mins = Math.round(deltaMs / 60_000);
  if (mins < 60) return `expires in ${mins}m`;
  return `expires in ${Math.round(mins / 60)}h`;
}

async function printStatus(): Promise<void> {
  const s = readVercelCredStatus();
  if (s.auth === 'none') {
    process.stdout.write(
      'vercel: not configured\n' + '  run `agentbox vercel login` to set up credentials\n',
    );
    return;
  }

  const lines = ['vercel: configured'];

  if (s.auth === 'cli') {
    const det = await detectSbx();
    lines.push('  auth:   Vercel CLI (sandbox) login');
    lines.push(`  cli:    ${det.installed ? `installed${det.version ? ` ${det.version}` : ''}` : `not installed — run \`${installSbxHint()}\``}`);
    if (s.cli) {
      if (!s.cli.loggedIn) {
        lines.push('  session: logged out — run `agentbox vercel login`');
      } else {
        let tokenLine = `  token:  ${s.token ? maskKey(s.token) : '(live, from CLI store)'}`;
        if (s.cli.expiresAt) tokenLine += `  (${relativeExpiry(s.cli.expiresAt)})`;
        else tokenLine += '  (no expiry recorded — will refresh on use)';
        lines.push(tokenLine);
      }
      lines.push(`  store:  ${s.cli.authPath}`);
    }
  } else if (s.auth === 'oidc') {
    lines.push('  auth:   OIDC token (VERCEL_OIDC_TOKEN)');
  } else {
    lines.push('  auth:   access token');
    if (s.token) lines.push(`  token:  ${maskKey(s.token)}`);
  }

  lines.push(`  source: ${s.source}`);
  if (s.teamId) lines.push(`  team:   ${s.teamId}`);
  if (s.projectId) lines.push(`  project: ${s.projectId}`);
  if (s.source === 'secrets.env' || s.source === 'cli-store') {
    lines.push(`  file:   ${secretsPath()}`);
  }
  process.stdout.write(lines.join('\n') + '\n');
}

const loginSub = new Command('login')
  .description('Set up (or rotate) Vercel credentials for sandbox boxes')
  .option('--status', 'show what is currently configured (masked) and exit')
  .action(async (opts: LoginOpts) => {
    try {
      if (opts.status) {
        await printStatus();
        return;
      }
      if (!process.stdin.isTTY) {
        process.stderr.write(
          'vercel login needs an interactive terminal — set the VERCEL_TOKEN trio ' +
            '(or VERCEL_OIDC_TOKEN) in the environment or in ~/.agentbox/secrets.env for non-interactive use.\n',
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
