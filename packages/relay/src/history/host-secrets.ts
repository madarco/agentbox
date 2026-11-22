import { readFile } from 'node:fs/promises';
import { secretValuesFromJson } from '@agentbox/core';
import { AGENT_SYNC_SPECS, HUB_TOKEN_FILE, secretsEnvPath } from '@agentbox/sandbox-core';

/**
 * Exact secret values this host knows, for the relay's redaction pass over every
 * history frame (docs/agent-history-plan.md, Phase 0: the one real leak seen in
 * a week was the hub token, and exact matching caught all of it). Re-read
 * periodically because credential backups rotate.
 */
export async function collectHostSecrets(extra: readonly string[] = []): Promise<string[]> {
  const out = [...extra];
  for (const k of ['AGENTBOX_HUB_TOKEN', 'AGENTBOX_RELAY_ADMIN_TOKEN', 'BETTER_AUTH_SECRET']) {
    const v = process.env[k];
    if (v) out.push(v);
  }
  const read = (p: string): Promise<string | null> => readFile(p, 'utf8').catch(() => null);
  const hubToken = await read(HUB_TOKEN_FILE);
  if (hubToken) out.push(hubToken.trim());
  const secretsEnv = await read(secretsEnvPath());
  if (secretsEnv) {
    for (const raw of secretsEnv.split('\n')) {
      const line = raw.trim().replace(/^export\s+/, '');
      const eq = line.indexOf('=');
      if (line.startsWith('#') || eq <= 0) continue;
      const value = line
        .slice(eq + 1)
        .trim()
        .replace(/^(['"])(.*)\1$/, '$2');
      if (value) out.push(value);
    }
  }
  for (const spec of AGENT_SYNC_SPECS) {
    const backup = spec.credential?.hostBackup;
    if (!backup) continue;
    const text = await read(backup);
    if (text) out.push(...secretValuesFromJson(text));
  }
  return out;
}
