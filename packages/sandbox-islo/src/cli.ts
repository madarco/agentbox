import { log } from '@clack/prompts';
import { Command } from 'commander';
import {
  ensureIsloCredentials,
  maskKey,
  readIsloCredStatus,
  secretsPath,
} from './credentials.js';
import { DEFAULT_ISLO_IMAGE_REF } from './backend.js';

interface LoginOpts {
  status?: boolean;
}

function reportError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  log.error(message);
  process.exitCode = 1;
}

function printStatus(): void {
  const s = readIsloCredStatus();
  if (s.auth === 'none') {
    process.stdout.write(
      'islo: not configured\n' +
        '  run `agentbox islo login` to set up an API key, or set ISLO_API_KEY\n',
    );
    return;
  }
  const lines = ['islo: configured', '  auth:    API key'];
  if (s.token) lines.push(`  token:   ${maskKey(s.token)}`);
  lines.push(`  compute: ${s.baseUrl}`, `  control: ${s.controlUrl}`, `  source:  ${s.source}`);
  if (s.source === 'secrets.env') lines.push(`  file:    ${secretsPath()}`);
  lines.push(`  image:   ${DEFAULT_ISLO_IMAGE_REF} (default for agentbox/box:dev)`);
  process.stdout.write(lines.join('\n') + '\n');
}

const loginSub = new Command('login')
  .description('Set up (or rotate) Islo credentials for sandbox boxes')
  .option('--status', 'show what is currently configured (masked) and exit')
  .action(async (opts: LoginOpts) => {
    try {
      if (opts.status) {
        printStatus();
        return;
      }
      if (!process.stdin.isTTY) {
        process.stderr.write(
          'islo login needs an interactive terminal — set ISLO_API_KEY or ' +
            'AGENTBOX_ISLO_API_KEY for non-interactive use.\n',
        );
        process.exitCode = 1;
        return;
      }
      await ensureIsloCredentials({ force: true });
      log.info(
        'For interactive attaches, also run `islo ssh --setup` once so `ssh islo@<sandbox>.islo` works.',
      );
    } catch (err) {
      reportError(err);
    }
  });

export const isloCommand = new Command('islo')
  .description(
    'Islo sandbox provider — credentials, plus sugar for `--provider islo` ' +
      '(e.g. `agentbox islo create|claude|codex|opencode`)',
  )
  .addCommand(loginSub, { isDefault: true });
