import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { STATE_DIR } from '@agentbox/sandbox-docker';

export const AUTH_FILE = join(STATE_DIR, 'auth.json');

export interface AuthFile {
  claudeCodeOauthToken?: string;
}

export interface ResolvedClaudeAuth {
  /** Env vars to inject into the box. Only includes keys with non-empty string values. */
  env: Record<string, string>;
  /** Where the value(s) came from. `'none'` means there's nothing to forward. */
  source: 'host-env' | 'auth-file' | 'none';
}

/**
 * Merge host env + the legacy `~/.agentbox/auth.json` setup-token into the
 * effective env that the `claude` command forwards to the box. Env wins over
 * the file; either of the two known keys (API key or OAuth token) counts as
 * having auth.
 *
 * This is the **dormant fallback** path. The primary auth flow is the in-box
 * interactive OAuth login, persisted by `syncClaudeCredentials` — a box that
 * has real credentials in its claude-config volume ignores any forwarded
 * `CLAUDE_CODE_OAUTH_TOKEN` anyway. `auth.json` is only ever read here, never
 * written, kept so existing users and CI keep working.
 */
export async function resolveClaudeAuth(
  processEnv: NodeJS.ProcessEnv,
  opts: { authFilePath?: string } = {},
): Promise<ResolvedClaudeAuth> {
  const env: Record<string, string> = {};
  const envApiKey = processEnv['ANTHROPIC_API_KEY'];
  const envOauth = processEnv['CLAUDE_CODE_OAUTH_TOKEN'];
  if (typeof envApiKey === 'string' && envApiKey.length > 0) env['ANTHROPIC_API_KEY'] = envApiKey;
  if (typeof envOauth === 'string' && envOauth.length > 0) env['CLAUDE_CODE_OAUTH_TOKEN'] = envOauth;
  if (Object.keys(env).length > 0) return { env, source: 'host-env' };

  const file = await readAuthFile(opts.authFilePath);
  if (file.claudeCodeOauthToken && file.claudeCodeOauthToken.length > 0) {
    return {
      env: { CLAUDE_CODE_OAUTH_TOKEN: file.claudeCodeOauthToken },
      source: 'auth-file',
    };
  }
  return { env: {}, source: 'none' };
}

export async function readAuthFile(path: string = AUTH_FILE): Promise<AuthFile> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const t = (parsed as { claudeCodeOauthToken?: unknown }).claudeCodeOauthToken;
      return typeof t === 'string' && t.length > 0 ? { claudeCodeOauthToken: t } : {};
    }
    return {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    // A garbage / corrupted file shouldn't kill `agentbox claude`. Treat as empty.
    return {};
  }
}
