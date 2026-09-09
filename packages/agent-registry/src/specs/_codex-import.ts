/**
 * Turn a borrowed Codex login into a multi-provider agent's own OAuth profile.
 *
 * pi and opencode both store a ChatGPT-subscription profile in their own
 * provider-keyed `auth.json`, in the same five-field shape, under the same
 * OpenAI OAuth client as the Codex CLI itself. So the import is a field
 * mapping — no plugin to install, no CLI to drive — which is why this is a
 * `command` ingest the host runs rather than a service task.
 *
 * MEASURED on the host's real stores before this was written:
 *
 *  - `~/.codex/auth.json` `.tokens` carries `access_token`, `refresh_token`,
 *    `account_id`; the consumer wants `access`, `refresh`, `accountId`.
 *  - All three stores share one OAuth `client_id`, which is what makes the
 *    tokens interchangeable at all.
 *  - `expires` MUST come from the access token's own `exp` claim. Writing 0 or
 *    a past value looks harmless — "it will just refresh" — but the consumer's
 *    refresh call REJECTS a codex-issued refresh token (`invalid_state`), so
 *    the box would come up with auth that never worked. Verified back to back:
 *    the agent's own refresh token at `expires:0` refreshed and rotated fine,
 *    codex's did not.
 *  - Because of that, a seeded box cannot renew itself. It works until the
 *    borrowed access token expires, and is renewed by the credential fan-out
 *    re-pushing the host's login and re-running this — which is exactly why the
 *    gate below is a hash of the SEED, not "is there a profile already".
 *
 * The store is a map that may already hold other providers, so this MERGES one
 * key and never rewrites the file wholesale.
 */

import { codexSpec } from './codex.js';

/** Single-quote a value for the POSIX shell. */
function sq(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/**
 * argv: <seed> <store> <providerKey>. Exit 0 on success, non-zero on any
 * "nothing to ingest" so the shell can report it and still exit 0 itself.
 */
const IMPORT_JS = `
const fs = require('fs');
const path = require('path');
const [seedPath, storePath, key] = process.argv.slice(1);
const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
const t = seed && seed.tokens;
if (!t || typeof t.refresh_token !== 'string' || t.refresh_token.length === 0) process.exit(3);
if (typeof t.access_token !== 'string' || t.access_token.length === 0) process.exit(3);
// The consumer's refresh cannot renew a codex-issued token, so a wrong expiry
// is not self-healing: take the real one off the access token's exp claim.
let expires = 0;
try {
  const c = JSON.parse(
    Buffer.from(t.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64')
      .toString('utf8'),
  );
  expires = typeof c.exp === 'number' ? c.exp * 1000 : 0;
} catch (e) {
  expires = 0;
}
if (expires <= 0) process.exit(4);
let store = {};
try {
  const cur = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  if (cur && typeof cur === 'object' && !Array.isArray(cur)) store = cur;
} catch (e) {
  store = {};
}
store[key] = {
  type: 'oauth',
  access: t.access_token,
  refresh: t.refresh_token,
  accountId: t.account_id,
  expires: expires,
};
fs.mkdirSync(path.dirname(storePath), { recursive: true });
fs.writeFileSync(storePath, JSON.stringify(store, null, 2), { mode: 0o600 });
`;

export interface CodexImportOptions {
  /** The consuming agent's id, for log lines. */
  agentId: string;
  /** The consumer's own auth store inside the box. */
  storePath: string;
  /** The provider key to write in that store — pi's `openai-codex`, opencode's `openai`. */
  providerKey: string;
  /** Where the hash of the last imported seed is kept. AgentBox-owned, per box. */
  marker: string;
  /** The seeded login's path. Defaults to codex's own; overridden only by tests. */
  seedPath?: string;
}

/** The ingest command for an agent that consumes a Codex login as OpenAI auth. */
export function buildCodexImportScript(o: CodexImportOptions): string {
  const seed = o.seedPath ?? codexSpec.credential!.boxAbsPath;
  const tag = `${o.agentId}-model-auth`;
  return [
    // `set -e` is deliberately absent: a box whose model auth cannot be seeded
    // must still come up.
    'set -u',
    `seed=${sq(seed)}`,
    `store=${sq(o.storePath)}`,
    `marker=${sq(o.marker)}`,
    `if [ ! -s "$seed" ]; then echo ${sq(`${tag}: no borrowed Codex login at ${seed}`)}; exit 0; fi`,
    'seen=$(sha256sum "$seed" | cut -d" " -f1)',
    'if [ -f "$marker" ] && [ "$(cat "$marker")" = "$seen" ]; then',
    `  echo ${sq(`${tag}: this Codex login is already imported`)}`,
    '  exit 0',
    'fi',
    `if node -e ${sq(IMPORT_JS)} "$seed" "$store" ${sq(o.providerKey)}; then`,
    `  echo ${sq(`${tag}: imported the Codex login as ${o.providerKey}`)}`,
    '  printf %s "$seen" > "$marker" && chmod 600 "$marker"',
    'else',
    // Double-quoted so $seed expands; the tag is a plain agent id, no metachars.
    `  echo "${tag}: $seed is not a usable Codex ChatGPT login"`,
    'fi',
    'exit 0',
  ].join('\n');
}

/**
 * Where a consumer keeps the hash of the seed it last imported.
 *
 * PER BOX (`/run/agentbox` is a bind to `~/.agentbox/boxes/<box>/run`), not in
 * the agent's own config dir. That dir is a SHARED docker volume —
 * `agentbox-pi-config` is mounted at `~/.pi/agent` in every pi box — so a marker
 * written there made the import run once per HOST: box #2 read box #1's hash,
 * logged "already imported", and came up with whatever credential the shared
 * volume happened to hold. Measured, not theorised.
 */
export function codexImportMarker(agentId: string): string {
  return `/run/agentbox/model-auth-${agentId}.sha256`;
}
