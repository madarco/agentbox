import { randomBytes } from 'node:crypto';
import { isCancel, password, text } from '@clack/prompts';

/** Env the deployed hub needs to enforce login + seed its first admin. */
export interface HubAuthEnv {
  AGENTBOX_HUB_AUTH: string;
  BETTER_AUTH_SECRET: string;
  AGENTBOX_HUB_ADMIN_EMAIL: string;
  AGENTBOX_HUB_ADMIN_PASSWORD: string;
}

/**
 * Collect the hub auth env for a deployed profile, prompting for anything not
 * already in the environment. Setting these turns login on (auth is secret-gated
 * on the hub), so a deployed hub is never left loginless. Returns null if the
 * operator cancels a prompt (deploy proceeds without login, as before).
 */
export async function resolveHubAuthEnv(): Promise<HubAuthEnv | null> {
  let email = process.env.AGENTBOX_HUB_ADMIN_EMAIL;
  let pass = process.env.AGENTBOX_HUB_ADMIN_PASSWORD;
  const secret = process.env.BETTER_AUTH_SECRET || randomBytes(32).toString('base64');

  if (!email) {
    const v = await text({
      message: 'Hub admin email (used to log in to the deployed hub UI)',
      validate: (s) => (/^.+@.+\..+$/.test(s.trim()) ? undefined : 'enter a valid email'),
    });
    if (isCancel(v)) return null;
    email = v.trim();
  }
  if (!pass) {
    const v = await password({
      message: 'Hub admin password (min 8 characters)',
      validate: (s) => (s.length >= 8 ? undefined : 'at least 8 characters'),
    });
    if (isCancel(v)) return null;
    pass = v;
  }

  return {
    AGENTBOX_HUB_AUTH: 'on',
    BETTER_AUTH_SECRET: secret,
    AGENTBOX_HUB_ADMIN_EMAIL: email,
    AGENTBOX_HUB_ADMIN_PASSWORD: pass,
  };
}
