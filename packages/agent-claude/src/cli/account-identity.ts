/**
 * Read a display identity off a captured claude login (llm-accounts Phase 2).
 *
 * The plan comes from the credential itself (`claudeAiOauth.subscriptionType`);
 * email and org from the volume's `_claude.json` `oauthAccount`, which Claude
 * Code writes on the first turn — the login's warm-up turn — not at
 * `auth login` (Phase 0, (a)). Display only.
 */
import type { LlmAccountIdentity } from '@agentbox/core';
import type { AccountIdentityReader } from '@agentbox/sandbox-docker';

const CREDENTIAL_FILE = '.credentials.json';
const APP_CONFIG_FILE = '_claude.json';

function parseJson(text: string | null | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function parseClaudeAccountIdentity(
  files: Readonly<Record<string, string | null>>,
): LlmAccountIdentity | undefined {
  const cred = parseJson(files[CREDENTIAL_FILE])?.claudeAiOauth as
    | Record<string, unknown>
    | undefined;
  const acct = parseJson(files[APP_CONFIG_FILE])?.oauthAccount as
    | Record<string, unknown>
    | undefined;
  const out: LlmAccountIdentity = {};
  const email = str(acct?.emailAddress);
  const org = str(acct?.organizationName);
  const plan = str(cred?.subscriptionType);
  if (email) out.email = email;
  if (org) out.org = org;
  if (plan) out.plan = plan;
  return Object.keys(out).length > 0 ? out : undefined;
}

export const claudeAccountIdentity: AccountIdentityReader = {
  files: [CREDENTIAL_FILE, APP_CONFIG_FILE],
  parse: parseClaudeAccountIdentity,
};
