// Write an account's stored login into one box's own credential file: the
// whole of a switch to a login (docs/hot-switch-subscriptions-plan.md).
import {
  accountSecretPath,
  requireAgentCredential,
  type BoxRecord,
  type Provider,
} from '@agentbox/core';
import {
  isRealAgentCredential,
  pushCredentialToBox,
  readCredentialBackup,
  resolveAgentSpec,
  STATE_DIR,
} from '@agentbox/sandbox-core';
import { writeBoxCredentialFile } from '@agentbox/sandbox-docker';

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
