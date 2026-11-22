/**
 * Mirror a box's in-box claude login with its host-side copy, per account
 * (llm-accounts Phase 3).
 *
 * The default account mirrors with the legacy backup, as always. A NAMED
 * account mirrors with its own secret: the isolate branch of the legacy sync
 * would otherwise seed the DEFAULT login into the account's volume whenever the
 * default's token is newer. A pasted account authenticates by env and its
 * volume holds no login, so there is nothing to mirror.
 */
import { relative } from 'node:path';
import { accountSecretPath, findAccount, isDefaultAccount } from '@agentbox/core';
import { boxAccount, readAccounts, resolveAgentSpec, STATE_DIR } from '@agentbox/sandbox-core';
import { syncClaudeCredentials, type BoxRecord } from '@agentbox/sandbox-docker';
import { SHARED_CLAUDE_VOLUME } from '../docker-sync.js';

export async function syncBoxClaudeCredentials(
  box: Pick<BoxRecord, 'accounts' | 'image'>,
  volume: string,
): Promise<void> {
  const account = boxAccount(box, 'claude');
  if (isDefaultAccount(account)) {
    await syncClaudeCredentials(
      { volume },
      { image: box.image, isolate: volume !== SHARED_CLAUDE_VOLUME },
    );
    return;
  }
  const row = findAccount(await readAccounts(), 'claude', account);
  if (row?.kind !== 'login') return;
  const secret = accountSecretPath(resolveAgentSpec('claude'), account, STATE_DIR);
  if (!secret) return;
  await syncClaudeCredentials(
    { volume },
    { image: box.image, isolate: false, hostBackupRel: relative(STATE_DIR, secret) },
  );
}
