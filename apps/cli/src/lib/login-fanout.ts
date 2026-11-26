// Push a freshly signed-in login to the boxes on its account
// (docs/hot-switch-subscriptions-plan.md). A docker box reads its own
// credential file, not the account volume a login container writes, so a
// sign-in reaches running boxes only through this fan-out.
import { log, spinner } from '@clack/prompts';
import { DEFAULT_ACCOUNT_ID, namedAccounts } from '@agentbox/core';
import {
  isRealAgentCredential,
  readCredentialBackup,
  readState,
  resolveAgentSpec,
  writeCredentialBackup,
} from '@agentbox/sandbox-core';
import { volumeSettingsTarget } from '@agentbox/sandbox-docker';
import { withHubClient } from '../control-plane/with-hub.js';

/** Push `agent`/`id`'s stored login to every box on the account, through the local hub. */
export async function fanOutLogin(agent: string, id: string): Promise<void> {
  const s = spinner();
  s.start(`pushing ${agent}/${id} to its boxes`);
  const r = await withHubClient({ preferLocal: true }, (client) =>
    client.renewAccount(agent, id),
  ).catch((err: unknown) => {
    s.stop('fan-out failed');
    throw err;
  });
  if (!r) {
    s.stop('fan-out failed');
    return;
  }
  s.stop(
    `pushed to ${String(r.pushed)} target(s)${r.failed > 0 ? `, ${String(r.failed)} failed` : ''}`,
  );
  for (const line of r.output) {
    if (!line.startsWith('propagated ')) log.message(line);
  }
  if (r.failed > 0) process.exitCode = 1;
}

/** The default login as its shared volume holds it, or null (no volume, no image yet). */
export async function readDefaultVolumeLogin(agent: string, image: string): Promise<string | null> {
  const spec = resolveAgentSpec(agent);
  if (!spec.credential) return null;
  return volumeSettingsTarget(spec.dockerVolume, image, spec.dockerVolume)
    .readText(spec.credential.boxRelPath)
    .catch(() => null);
}

/**
 * After `agentbox <agent> login`: when the shared volume now holds a different,
 * real login than `before`, a sign-in completed (a headless start that only
 * printed a URL changed nothing). Store it as the default login and push it to
 * the boxes on `default`, if there are any.
 */
export async function fanOutDefaultLoginIfSignedIn(
  agent: string,
  image: string,
  before: string | null,
): Promise<void> {
  const spec = resolveAgentSpec(agent);
  const cred = spec.credential;
  if (!cred) return;
  const after = await readDefaultVolumeLogin(agent, image);
  if (after === null || after === before || !isRealAgentCredential(spec.id, after)) return;
  // The person just signed this login in, so it replaces the stored one even
  // when it is another identity (no newest-wins or identity gate here).
  if ((await readCredentialBackup(spec.id)) !== after) {
    await writeCredentialBackup(spec.id, after);
  }
  const boxes = (await readState()).boxes.filter(
    (b) =>
      (!b.agents || b.agents.includes(spec.id)) &&
      (namedAccounts(b.accounts)?.[spec.id] ?? DEFAULT_ACCOUNT_ID) === DEFAULT_ACCOUNT_ID,
  );
  if (boxes.length === 0) return;
  await fanOutLogin(spec.id, DEFAULT_ACCOUNT_ID);
}
