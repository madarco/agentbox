/**
 * Make a cloud box on a NAMED claude account carry that account's identity and
 * nothing of the owner's (llm-accounts Phase 3).
 *
 * Docker strips while seeding a volume; a cloud box's `settings.json` comes
 * from the SHARED baked snapshot and its `_claude.json` from the per-create
 * overlay, so the same strip runs here, in the box, after both have landed:
 *  - `_claude.json`: drop `ACCOUNT_STATE_KEYS` (the owner's cached profile,
 *    `primaryApiKey`, stored API-key answers, unkeyed model caches);
 *  - `settings.json`: drop the auth env (`AUTH_SETTINGS_ENV_KEYS`) and
 *    `apiKeyHelper`, which would make the box bill the owner's key;
 *  - an `api-key` account: pre-approve its key (Phase 0 (a′)). Only the last
 *    20 characters, uploaded as a 0600 temp file — never on argv.
 */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findAccount, type CloudBackend, type CloudHandle } from '@agentbox/core';
import { decodePastedSecret, readAccounts, readAccountSecret } from '@agentbox/sandbox-core';
import { API_KEY_APPROVAL_SUFFIX } from './docker-sync.js';
import { accountStateJqDelete, AUTH_SETTINGS_ENV_KEYS } from './hooks-filter.js';

const BOX_CLAUDE_DIR = '/home/vscode/.claude';
const REMOTE_SUFFIX = '/tmp/agentbox-claude-key-suffix';

/** The jq program that strips auth from a settings file. */
export function authSettingsJq(): string {
  const env = AUTH_SETTINGS_ENV_KEYS.map((k) => `.${k}`).join(', ');
  return `del(.apiKeyHelper) | if (.env | type) == "object" then .env |= del(${env}) else . end`;
}

/** The in-box shell that applies both strips. Paths and programs are constants. */
export function scrubScript(): string {
  const strip = (file: string, prog: string): string =>
    `f=${BOX_CLAUDE_DIR}/${file}; if [ -f "$f" ]; then ` +
    `jq '${prog}' "$f" > "$f.tmp" && mv "$f.tmp" "$f"; fi`;
  return [
    strip('_claude.json', accountStateJqDelete()),
    strip('settings.json', authSettingsJq()),
  ].join('; ');
}

export async function scrubCloudClaudeForAccount(
  backend: CloudBackend,
  handle: CloudHandle,
  account: string,
  log: (line: string) => void,
): Promise<void> {
  const r = await backend.exec(handle, scrubScript());
  if (r.exitCode !== 0) {
    log(
      `claude: could not strip host identity for account '${account}' (exit ${String(r.exitCode)})`,
    );
  }
  const row = findAccount(await readAccounts(), 'claude', account);
  if (row?.kind !== 'api-key') return;
  const secret = await readAccountSecret('claude', account);
  const pasted = secret ? decodePastedSecret(secret) : null;
  if (pasted?.kind !== 'api-key') return;
  const dir = await mkdtemp(join(tmpdir(), 'agentbox-acct-'));
  const local = join(dir, 'suffix');
  try {
    await writeFile(local, pasted.token.slice(-API_KEY_APPROVAL_SUFFIX), { mode: 0o600 });
    await chmod(local, 0o600);
    await backend.uploadFile(handle, local, REMOTE_SUFFIX);
    const approve = await backend.exec(
      handle,
      `f=${BOX_CLAUDE_DIR}/_claude.json; [ -f "$f" ] || echo '{}' > "$f"; ` +
        `jq --rawfile k ${REMOTE_SUFFIX} '.customApiKeyResponses.approved = (((.customApiKeyResponses.approved // []) + [$k]) | unique) ` +
        `| .customApiKeyResponses.rejected = ((.customApiKeyResponses.rejected // []) - [$k])' "$f" > "$f.tmp" && mv "$f.tmp" "$f"; ` +
        `rm -f ${REMOTE_SUFFIX}`,
    );
    if (approve.exitCode === 0) log(`claude: pre-approved account '${account}' API key`);
    else log(`claude: could not pre-approve account '${account}' API key`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
