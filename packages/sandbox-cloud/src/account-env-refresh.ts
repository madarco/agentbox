import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { BoxRecord, Provider } from '@agentbox/core';
import { CLOUD_AGENT_ENV_FILE, renderAgentEnvFile } from './agent-env-file.js';
import { buildCloudAgentEnv, cloudAccountAuthority } from './sync/agent-credentials.js';

/**
 * Rewrite a running cloud box's agent env file from its record, through the
 * generic `Provider` surface (upload + exec), for a caller that holds only the
 * provider: the hub, after switching a box's agent to another account (hub
 * settings Phase 3c). The account keys go in as overrides (`export` / `unset`),
 * so the next agent launch uses the record's account whatever the sandbox env
 * was created with. Same file, mode and ownership as `writeCloudAgentEnvFile`.
 */
export async function rewriteCloudAgentEnv(provider: Provider, box: BoxRecord): Promise<void> {
  if (!provider.uploadPath) throw new Error(`provider ${box.provider} cannot upload files`);
  const accounts = box.accounts ?? {};
  const text = renderAgentEnvFile(
    await buildCloudAgentEnv(box.agents, accounts),
    await cloudAccountAuthority(box.agents, accounts),
  );
  const dir = await mkdtemp(join(tmpdir(), 'agentbox-agent-env-'));
  const local = join(dir, `.agent-env-${randomBytes(6).toString('hex')}`);
  try {
    await writeFile(local, text, { mode: 0o600 });
    await chmod(local, 0o600);
    const { finalPath } = await provider.uploadPath(box, [local], '/tmp');
    const remote = finalPath.endsWith(basename(local)) ? finalPath : `/tmp/${basename(local)}`;
    const asroot = `asroot() { if command -v sudo >/dev/null 2>&1; then sudo -n "$@"; else "$@"; fi; }; `;
    const r = await provider.exec(
      box,
      [
        'bash',
        '-c',
        `umask 077; ${asroot}` +
          `asroot chown "$(id -un):$(id -gn)" ${remote}; asroot chmod 600 ${remote}; ` +
          `asroot mkdir -p /run/agentbox && asroot chown "$(id -un):$(id -gn)" /run/agentbox; ` +
          `install -m 600 ${remote} ${CLOUD_AGENT_ENV_FILE}.new && mv -f ${CLOUD_AGENT_ENV_FILE}.new ${CLOUD_AGENT_ENV_FILE}; ` +
          `rc=$?; asroot rm -f ${remote}; exit $rc`,
      ],
      { user: 'vscode' },
    );
    if ((r.exitCode ?? 0) !== 0) {
      throw new Error(`agent env not rewritten (exit ${String(r.exitCode)})`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
