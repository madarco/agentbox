/**
 * Read a display identity off a captured codex login (llm-accounts Phase 2):
 * the `id_token` claims in `auth.json` — `email`, and the ChatGPT plan from the
 * `https://api.openai.com/auth` claim. The JWT is decoded, not verified:
 * display only, never a decision.
 */
import type { LlmAccountIdentity } from '@agentbox/core';
import type { AccountIdentityReader } from '@agentbox/sandbox-docker';

const AUTH_FILE = 'auth.json';
const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth';

function jwtClaims(token: unknown): Record<string, unknown> | null {
  if (typeof token !== 'string') return null;
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const v = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function parseCodexAccountIdentity(
  files: Readonly<Record<string, string | null>>,
): LlmAccountIdentity | undefined {
  let auth: { tokens?: { id_token?: unknown } } | null;
  try {
    auth = JSON.parse(files[AUTH_FILE] ?? '') as { tokens?: { id_token?: unknown } } | null;
  } catch {
    return undefined;
  }
  const claims = jwtClaims(auth?.tokens?.id_token);
  if (!claims) return undefined;
  const out: LlmAccountIdentity = {};
  if (typeof claims.email === 'string' && claims.email) out.email = claims.email;
  const plan = (claims[OPENAI_AUTH_CLAIM] as { chatgpt_plan_type?: unknown } | undefined)
    ?.chatgpt_plan_type;
  if (typeof plan === 'string' && plan) out.plan = plan;
  return Object.keys(out).length > 0 ? out : undefined;
}

export const codexAccountIdentity: AccountIdentityReader = {
  files: [AUTH_FILE],
  parse: parseCodexAccountIdentity,
};
