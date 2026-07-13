/**
 * Headless AWS SSO re-authentication via the OAuth device-authorization flow —
 * `aws sso login --use-device-code --no-browser`.
 *
 * The split that makes this control-plane-ready: the CLI child (and with it
 * the token exchange + the `~/.aws/sso/cache` write) runs HERE, on the machine
 * that owns the credentials — but it never opens a browser. It emits a
 * verification URL (+ user code) that the caller forwards to whatever client
 * the human is looking at (hub web UI, tray), and that client opens it. The
 * child keeps polling AWS until the human approves in their own browser, then
 * exits 0 with the token cached.
 *
 * Only SSO-backed profiles can be refreshed this way. A static-key or
 * role-chaining profile has nothing to re-authenticate — `start()` returns
 * null and the caller falls back to the thrown error's guidance.
 */

import { spawn } from 'node:child_process';
import { ensureAwsEnvLoaded } from './env-loader.js';
import { readAwsProfiles } from './credentials.js';
import { hasAwsCli } from './setup-iam.js';

export interface AwsSsoDeviceLogin {
  /** The profile being refreshed. */
  profile: string;
  /** Verification URL the HUMAN must open (on any device). */
  url: string;
  /** Device-flow user code, when not already embedded in the URL. */
  userCode?: string;
  /** Resolves true when the login completed (token cached), false otherwise. */
  done: Promise<boolean>;
  /** Abort the flow (kills the polling CLI child). Idempotent. */
  cancel: () => void;
}

/** How long we give the CLI to print the verification URL before giving up. */
const URL_DEADLINE_MS = 20_000;

/**
 * Matches the verification URL in `aws sso login` output. Newer CLIs print a
 * single `…?user_code=XXXX-XXXX` URL; older ones print a bare URL and the
 * code on its own line.
 */
const URL_RE = /https:\/\/[^\s"']+/;
const CODE_RE = /\b([A-Z]{4}-[A-Z]{4})\b/;

/** Extract {url, userCode} from accumulated CLI output, or null if not there yet. */
export function parseDeviceLoginOutput(text: string): { url: string; userCode?: string } | null {
  const urlMatch = URL_RE.exec(text);
  if (!urlMatch) return null;
  const url = urlMatch[0].replace(/[.,]$/, '');
  try {
    const embedded = new URL(url).searchParams.get('user_code');
    if (embedded) return { url, userCode: embedded };
  } catch {
    return null; // torn URL mid-chunk; wait for more output
  }
  const codeMatch = CODE_RE.exec(text);
  return { url, userCode: codeMatch?.[1] };
}

/**
 * Kick off a device-code SSO login for the configured `AWS_PROFILE`. Returns
 * null (without side effects) when the flow can't work: no profile, a
 * non-SSO profile, or no `aws` CLI on the machine.
 */
export async function startAwsSsoDeviceLogin(): Promise<AwsSsoDeviceLogin | null> {
  ensureAwsEnvLoaded();
  const profile = process.env.AWS_PROFILE;
  if (!profile || !hasAwsCli()) return null;
  const isSso = readAwsProfiles().some((p) => p.name === profile && p.sso);
  if (!isSso) return null;

  const child = spawn(
    'aws',
    ['sso', 'login', '--profile', profile, '--use-device-code', '--no-browser'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let buffer = '';
  const exited = new Promise<boolean>((resolve) => {
    child.once('exit', (code) => {
      resolve(code === 0);
    });
    child.once('error', () => {
      resolve(false);
    });
  });

  const parsed = await new Promise<{ url: string; userCode?: string } | null>((resolve) => {
    const timer = setTimeout(() => {
      resolve(null);
    }, URL_DEADLINE_MS);
    if (typeof timer.unref === 'function') timer.unref();
    const onChunk = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      const hit = parseDeviceLoginOutput(buffer);
      if (hit) {
        clearTimeout(timer);
        resolve(hit);
      }
    };
    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);
    void exited.then(() => {
      clearTimeout(timer);
      resolve(parseDeviceLoginOutput(buffer));
    });
  });

  if (!parsed) {
    // Never printed a URL (old CLI without --use-device-code, immediate
    // config error, …) — kill and report unusable, the caller falls back to
    // the plain error message.
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    return null;
  }

  return {
    profile,
    url: parsed.url,
    userCode: parsed.userCode,
    done: exited,
    cancel: () => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    },
  };
}
