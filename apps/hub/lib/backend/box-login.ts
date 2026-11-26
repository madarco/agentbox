// Write an account's stored login into one box's own credential file: the
// whole of a switch to a login (docs/hot-switch-subscriptions-plan.md).
import {
  accountSecretPath,
  requireAgentCredential,
  type BoxRecord,
  type Provider,
} from '@agentbox/core';
import { readFile } from 'node:fs/promises';
import {
  isRealAgentCredential,
  pushCredentialToBox,
  readCredentialBackup,
  resolveAgentSpec,
  shouldAcceptCredentialUpdate,
  STATE_DIR,
  writeCredentialBackup,
} from '@agentbox/sandbox-core';
import { boxCredentialFile, writeBoxCredentialFile } from '@agentbox/sandbox-docker';
import { cliPropagate } from './accounts';

export async function writeBoxLogin(
  provider: Provider,
  box: BoxRecord,
  agent: string,
  account: string,
): Promise<void> {
  const spec = resolveAgentSpec(agent);
  requireAgentCredential(spec);
  const backupPath = accountSecretPath(spec, account, STATE_DIR);
  const content = await readCredentialBackup(spec.id, { backupPath });
  if (content === null || !isRealAgentCredential(spec.id, content)) {
    throw new Error(
      `no stored ${agent} login for '${account}'; sign it in with \`agentbox credentials renew ${agent}/${account}\``,
    );
  }
  if ((box.provider ?? 'docker') === 'docker') {
    if (!box.credentialFiles?.includes(spec.id)) {
      throw new Error(`${box.name} has no ${agent} login file of its own`);
    }
    await writeBoxCredentialFile(box, spec.id, content);
    return;
  }
  if (!provider.syncTransport) throw new Error(`${box.name}: its provider cannot push files`);
  await pushCredentialToBox(provider.syncTransport(box), spec.id, content);
}

/**
 * Before a switch overwrites the box's file: what the box holds may be a
 * refresh of the account it is leaving that the ctl watcher has not shipped
 * yet (it polls every 15 s). Credit it to `account` when it is that login and
 * newer than the stored copy, then push it to the account's other boxes, so a
 * rotated refresh token is not lost with the overwrite.
 */
export async function captureBoxLogin(
  provider: Provider,
  box: BoxRecord,
  agent: string,
  account: string,
): Promise<boolean> {
  const spec = resolveAgentSpec(agent);
  const cred = requireAgentCredential(spec);
  let current: string | null;
  if ((box.provider ?? 'docker') === 'docker') {
    if (!box.credentialFiles?.includes(spec.id)) return false;
    current = await readFile(boxCredentialFile(box, spec.id), 'utf8').catch(() => null);
  } else {
    if (!provider.syncTransport) return false;
    current = await provider.syncTransport(box).readText(cred.boxAbsPath);
  }
  if (current === null || !isRealAgentCredential(spec.id, current)) return false;
  const backupPath = accountSecretPath(spec, account, STATE_DIR);
  const stored = await readCredentialBackup(spec.id, { backupPath });
  if (!shouldAcceptCredentialUpdate(spec.id, current, stored).accept) return false;
  await writeCredentialBackup(spec.id, current, { backupPath });
  // Best effort, in the background: the switch must not wait on other boxes.
  void cliPropagate(spec.id, account, ['--source-box', box.id]).catch(() => undefined);
  return true;
}
