import { describe, expect, it } from 'vitest';
import { splitHubGitToken } from '../src/control-plane-deploy.js';

/**
 * `hub setup --git-auth gh` writes GH_TOKEN into control-plane.env, but that file
 * becomes the compose env-file — and compose `environment:` values are readable
 * via `docker inspect`. The token has to be peeled off and shipped with the
 * provider secrets into the data volume instead.
 */
describe('splitHubGitToken', () => {
  it('removes the token from the compose env and returns it', () => {
    const { env, token } = splitHubGitToken(
      'GITHUB_APP_ID=1\nGH_TOKEN=gho_secret\nAGENTBOX_RELAY_ADMIN_TOKEN=abc\n',
    );
    expect(token).toBe('gho_secret');
    // The secret must not survive anywhere in the compose env.
    expect(env).not.toContain('gho_secret');
    expect(env).not.toContain('GH_TOKEN');
    // Everything else is preserved verbatim.
    expect(env).toContain('GITHUB_APP_ID=1');
    expect(env).toContain('AGENTBOX_RELAY_ADMIN_TOKEN=abc');
  });

  it('handles an `export ` prefix and surrounding whitespace', () => {
    expect(splitHubGitToken('  export GH_TOKEN=ghp_x  \n').token).toBe('ghp_x');
  });

  it('is a no-op for an App-mode env', () => {
    const body = 'GITHUB_APP_ID=1\nGITHUB_APP_PRIVATE_KEY=b64\n';
    const { env, token } = splitHubGitToken(body);
    expect(token).toBeNull();
    expect(env).toContain('GITHUB_APP_ID=1');
    expect(env).toContain('GITHUB_APP_PRIVATE_KEY=b64');
  });

  it('treats an empty assignment as no token rather than shipping an empty credential', () => {
    const { token } = splitHubGitToken('GH_TOKEN=\n');
    expect(token).toBeNull();
  });

  it('does not match a key that merely ends in GH_TOKEN', () => {
    const { env, token } = splitHubGitToken('MY_GH_TOKEN=nope\n');
    expect(token).toBeNull();
    expect(env).toContain('MY_GH_TOKEN=nope');
  });
});
