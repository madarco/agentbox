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
import { execa } from 'execa';
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
 * Store a freshly signed-in default login: into the agent's shared volume
 * (what later default boxes seed from) and the default login's backup (what
 * the fan-out pushes). False when `content` is not a real login.
 */
export async function storeDefaultLogin(
  agent: string,
  image: string,
  content: string,
): Promise<boolean> {
  const spec = resolveAgentSpec(agent);
  if (!spec.credential || !isRealAgentCredential(spec.id, content)) return false;
  await volumeSettingsTarget(spec.dockerVolume, image, spec.dockerVolume).writeText(
    spec.credential.boxRelPath,
    content,
    { mode: 0o600 },
  );
  // The person just signed this login in: it replaces the stored one.
  if ((await readCredentialBackup(spec.id)) !== content) {
    await writeCredentialBackup(spec.id, content);
  }
  return true;
}

/**
 * Remove a docker volume, best effort (a scratch one a sign-in used). Retried
 * for a few seconds: a just-killed `docker run --rm` still holds it while its
 * container is torn down.
 */
export async function removeDockerVolume(volume: string, attempts = 10): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const r = await execa('docker', ['volume', 'rm', '-f', volume], { reject: false });
    if (r.exitCode === 0) return true;
    await new Promise((res) => setTimeout(res, 1_000));
  }
  return false;
}

/**
 * After a sign-in of the default login: when its shared volume now holds a
 * different, real login than `before`, the sign-in completed (a headless start
 * that only printed a URL changed nothing). Store it as the default login,
 * which is what the fan-out pushes, and say whether it changed.
 */
export async function captureDefaultLogin(
  agent: string,
  image: string,
  before: string | null,
): Promise<boolean> {
  const spec = resolveAgentSpec(agent);
  if (!spec.credential) return false;
  const after = await readDefaultVolumeLogin(agent, image);
  if (after === null || after === before || !isRealAgentCredential(spec.id, after)) return false;
  // The person just signed this login in, so it replaces the stored one even
  // when it is another identity (no newest-wins or identity gate here).
  if ((await readCredentialBackup(spec.id)) !== after) {
    await writeCredentialBackup(spec.id, after);
  }
  return true;
}

/** Push the default login to the boxes on `default`, when there are any. */
export async function fanOutDefaultLogin(agent: string): Promise<void> {
  const id = resolveAgentSpec(agent).id;
  const boxes = (await readState()).boxes.filter(
    (b) =>
      (!b.agents || b.agents.includes(id)) &&
      (namedAccounts(b.accounts)?.[id] ?? DEFAULT_ACCOUNT_ID) === DEFAULT_ACCOUNT_ID,
  );
  if (boxes.length === 0) return;
  await fanOutLogin(id, DEFAULT_ACCOUNT_ID);
}
