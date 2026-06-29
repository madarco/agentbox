import { describe, expect, it } from 'vitest';
import { launchCloudCtlDaemon } from '../src/ctl-launch.js';
import { deriveCloudBoxHost } from '../src/cloud-provider.js';
import { makeMockCloudBackend } from '../src/mock-backend.js';

describe('deriveCloudBoxHost', () => {
  it('returns <name>.localhost for a loopback (portless) preview URL', () => {
    expect(deriveCloudBoxHost('mybox', 'http://127.0.0.1:54321')).toBe('mybox.localhost');
    expect(deriveCloudBoxHost('mybox', 'http://localhost:54321')).toBe('mybox.localhost');
  });

  it('returns the bare host for a public preview URL', () => {
    expect(deriveCloudBoxHost('mybox', 'https://abc123.vercel.run')).toBe('abc123.vercel.run');
    expect(deriveCloudBoxHost('mybox', 'https://8080-sb.e2b.app')).toBe('8080-sb.e2b.app');
  });

  it('returns undefined when no preview URL resolved', () => {
    expect(deriveCloudBoxHost('mybox', undefined)).toBeUndefined();
  });

  it('returns undefined for an unparseable URL', () => {
    expect(deriveCloudBoxHost('mybox', 'not a url')).toBeUndefined();
  });
});

describe('launchCloudCtlDaemon', () => {
  async function launchScript(boxHost?: string): Promise<string> {
    const backend = makeMockCloudBackend();
    const handle = await backend.provision({ name: 'b', image: 'i' });
    backend.clearCalls();
    await launchCloudCtlDaemon({
      backend,
      handle,
      boxId: 'id-1',
      boxName: 'mybox',
      webProxyPort: 8080,
      boxHost,
    });
    const exec = backend.calls.find((c) => c.method === 'exec');
    expect(exec).toBeDefined();
    return exec!.args[1] as string;
  }

  it('exports AGENTBOX_BOX_HOST and writes it to box.env when set', async () => {
    const script = await launchScript('abc123.vercel.run');
    expect(script).toContain('export ');
    expect(script).toContain('AGENTBOX_BOX_HOST=abc123.vercel.run');
    // Persisted to box.env via the quoted heredoc for login-shell parity.
    // The whole script is bashScript()-wrapped (single-quoted), so the heredoc
    // delimiter's own quotes get re-escaped — assert on the stable substrings.
    expect(script).toContain('tee /etc/agentbox/box.env >/dev/null');
    expect(script).toContain('AGENTBOX_BOX_ENV_EOF');
    expect(script).toContain('AGENTBOX_BOX_NAME=mybox');
    expect(script).toContain('AGENTBOX_WEB_PROXY_PORT=8080');
  });

  it('guards the spawn with a /healthz probe before launching (idempotent)', async () => {
    const script = await launchScript(undefined);
    const guardIdx = script.indexOf('/healthz');
    const spawnIdx = script.indexOf('agentbox-ctl daemon >>');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(spawnIdx).toBeGreaterThan(-1);
    // The skip-guard must run BEFORE the daemon spawn, else it can't prevent it.
    expect(guardIdx).toBeLessThan(spawnIdx);
    expect(script).toContain('skipping launch');
    // Default box-relay port when no relayUrl is supplied.
    expect(script).toContain('127.0.0.1:8788/healthz');
  });

  it('probes the box-relay port parsed from relayUrl', async () => {
    const backend = makeMockCloudBackend();
    const handle = await backend.provision({ name: 'b', image: 'i' });
    backend.clearCalls();
    await launchCloudCtlDaemon({
      backend,
      handle,
      boxId: 'id-1',
      boxName: 'mybox',
      relayUrl: 'http://127.0.0.1:9999',
    });
    const exec = backend.calls.find((c) => c.method === 'exec');
    expect(exec!.args[1] as string).toContain('127.0.0.1:9999/healthz');
  });

  it('omits AGENTBOX_BOX_HOST when unset (engine falls back to derive)', async () => {
    const script = await launchScript(undefined);
    expect(script).not.toContain('AGENTBOX_BOX_HOST=');
    // The box.env file is still written with the identity subset so login-shell
    // `agentbox-ctl render` can derive <name>.localhost from AGENTBOX_BOX_NAME.
    // The whole script is bashScript()-wrapped (single-quoted), so the heredoc
    // delimiter's own quotes get re-escaped — assert on the stable substrings.
    expect(script).toContain('tee /etc/agentbox/box.env >/dev/null');
    expect(script).toContain('AGENTBOX_BOX_ENV_EOF');
    expect(script).toContain('AGENTBOX_BOX_NAME=mybox');
  });
});
