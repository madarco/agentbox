/**
 * Offer this PC's git identity as a remote hub's default committer identity,
 * at the moment the PC enrolls (`hub login`, the end of `hub setup`/`deploy`).
 *
 * The default only matters for creates with no PC behind them (the web UI, the
 * tray): a CLI create sends the project's own identity. Sent with `ifUnset`, so
 * the hub keeps one somebody already chose — the first PC to enroll sets it,
 * and the Settings page is where it changes.
 */
import { execFileSync } from 'node:child_process';
import { parseGitIdentity, type GitIdentity } from '@agentbox/core';

function globalGitConfig(key: string): string | undefined {
  try {
    const v = execFileSync('git', ['config', '--global', key], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    return v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/** This PC's global identity (never a repo-local one, even with a repo at ~). */
export function readGlobalGitIdentity(): GitIdentity | undefined {
  const parsed = parseGitIdentity({
    name: globalGitConfig('user.name'),
    email: globalGitConfig('user.email'),
  });
  return parsed.ok ? parsed.value : undefined;
}

export type HubGitIdentityOffer =
  | { outcome: 'set'; identity: GitIdentity }
  | { outcome: 'kept'; identity: GitIdentity }
  /** This PC has no complete `user.name`/`user.email`. */
  | { outcome: 'no-local-identity' }
  /** A hub older than the setting (404), or one that refused the call. */
  | { outcome: 'unsupported'; status: number };

export async function offerHubGitIdentity(opts: {
  url: string;
  bearer: string;
  fetch?: typeof fetch;
  readIdentity?: () => GitIdentity | undefined;
}): Promise<HubGitIdentityOffer> {
  // The global identity, not whichever repo the command ran in: this is the
  // PC's identity, not a project's.
  const identity = (opts.readIdentity ?? readGlobalGitIdentity)();
  if (!identity) return { outcome: 'no-local-identity' };
  const res = await (opts.fetch ?? fetch)(
    `${opts.url.replace(/\/+$/, '')}/api/v1/settings/git-identity`,
    {
      method: 'PUT',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${opts.bearer}`,
      },
      body: JSON.stringify({ identity, ifUnset: true }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (res.status !== 200) return { outcome: 'unsupported', status: res.status };
  const body = (await res.json().catch(() => ({}))) as {
    identity?: GitIdentity | null;
    unchanged?: boolean;
  };
  const inForce = body.identity ?? identity;
  return body.unchanged ? { outcome: 'kept', identity: inForce } : { outcome: 'set', identity };
}

/** One log line for the offer, or null when there is nothing worth saying. */
export function describeHubGitIdentityOffer(r: HubGitIdentityOffer): string | null {
  switch (r.outcome) {
    case 'set':
      return `Boxes this hub builds without a PC behind them (web UI, tray) will commit as ${r.identity.name} <${r.identity.email}>. Change it on the hub's Settings page.`;
    case 'kept':
    case 'unsupported':
      return null;
    case 'no-local-identity':
      return "This computer has no global git user.name/user.email to offer as the hub's default commit identity; if the hub has none, set it on its Settings page.";
  }
}
