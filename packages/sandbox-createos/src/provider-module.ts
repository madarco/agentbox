import { errSummary, type CheckResult, type CredStatusSummary } from '@agentbox/sandbox-core';
import { detectCreateosCli } from './createos-cli.js';
import { readCreateOsCredStatus, validateCreateOsCredentials } from './credentials.js';

export function readCredStatusSummary(): CredStatusSummary {
  const cred = readCreateOsCredStatus();
  return { configured: cred.auth !== 'none', label: cred.auth };
}

export async function doctorChecks(): Promise<CheckResult[]> {
  const cred = readCreateOsCredStatus();
  const cli = detectCreateosCli();
  const credRes: CheckResult =
    cred.auth === 'none'
      ? {
          label: 'credentials',
          status: 'warn',
          detail: 'not configured',
          hint: '`agentbox createos login`',
        }
      : { label: 'credentials', status: 'ok', detail: `${cred.auth} (${cred.source})` };
  const cliRes: CheckResult = cli.installed
    ? { label: 'createos cli', status: 'ok', detail: cli.version ?? 'installed' }
    : {
        label: 'createos cli',
        status: 'warn',
        detail: 'not installed',
        hint: 'install `createos` so AgentBox can attach to CreateOS boxes',
      };
  if (cred.auth === 'none') return [credRes, cliRes];
  try {
    const ok = await validateCreateOsCredentials();
    return [
      credRes,
      cliRes,
      ok
        ? { label: 'api', status: 'ok', detail: 'whoami ok' }
        : { label: 'api', status: 'warn', detail: 'whoami failed' },
    ];
  } catch (err) {
    return [credRes, cliRes, { label: 'api', status: 'warn', detail: errSummary(err) }];
  }
}
