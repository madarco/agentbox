import { log } from '@clack/prompts';
import { Command } from 'commander';
import {
  ensureCreateOsCredentials,
  maskKey,
  readCreateOsCredStatus,
  secretsPath,
} from './credentials.js';

interface LoginOpts {
  status?: boolean;
}

function printStatus(): void {
  const s = readCreateOsCredStatus();
  if (s.auth === 'none') {
    process.stdout.write(
      'createos: not configured\n  run `agentbox createos login` to set up credentials\n',
    );
    return;
  }
  const lines = ['createos: configured', '  auth:   API key'];
  if (s.token) lines.push(`  token:  ${maskKey(s.token)}`);
  lines.push(`  source: ${s.source}`);
  if (s.source === 'secrets.env') lines.push(`  file:   ${secretsPath()}`);
  process.stdout.write(lines.join('\n') + '\n');
}

const loginSub = new Command('login')
  .description('Set up CreateOS credentials for sandbox boxes')
  .option('--status', 'show what is currently configured and exit')
  .action(async (opts: LoginOpts) => {
    try {
      if (opts.status) {
        printStatus();
        return;
      }
      if (!process.stdin.isTTY) {
        process.stderr.write(
          'createos login needs an interactive terminal - set CREATEOS_API_KEY in the environment for non-interactive use.\n',
        );
        process.exitCode = 1;
        return;
      }
      await ensureCreateOsCredentials({ force: true });
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

export const createosCommand = new Command('createos')
  .description(
    'CreateOS sandbox provider - credentials, plus sugar for `--provider createos`',
  )
  .addCommand(loginSub, { isDefault: true });
