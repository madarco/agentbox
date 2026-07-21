import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runGitHubAppManifestFlow } from '../src/control-plane/github-app-manifest.js';

/**
 * End-to-end exercise of the GitHub-App manifest flow with NO real GitHub and
 * NO browser: a fake GitHub API answers the manifest→App conversion, and the
 * injected "browser" fetches the local form page, reads the CSRF state, and
 * hits the localhost callback exactly as GitHub's redirect would.
 */
describe('runGitHubAppManifestFlow (e2e against a fake GitHub)', () => {
  let fakeApi: Server;
  let fakeApiUrl: string;
  let conversions: string[] = [];

  beforeEach(async () => {
    conversions = [];
    fakeApi = createServer((req, res) => {
      const m = /^\/app-manifests\/([^/]+)\/conversions$/.exec(req.url ?? '');
      if (req.method === 'POST' && m) {
        conversions.push(decodeURIComponent(m[1]!));
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 424242,
            slug: 'agentbox-cp-test',
            pem: '-----BEGIN RSA PRIVATE KEY-----\nFAKEKEY\n-----END RSA PRIVATE KEY-----\n',
            html_url: 'https://github.com/apps/agentbox-cp-test',
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => fakeApi.listen(0, '127.0.0.1', r));
    fakeApiUrl = `http://127.0.0.1:${String((fakeApi.address() as AddressInfo).port)}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => fakeApi.close(() => r()));
  });

  it('serves the manifest form, exchanges the code, and returns the App creds', async () => {
    const result = await runGitHubAppManifestFlow({
      appName: 'agentbox-cp-test',
      apiBaseUrl: fakeApiUrl,
      githubUrl: 'https://github.example', // not actually hit; the browser drives the callback
      openBrowser: async (startUrl) => {
        // 1. The "browser" loads the local form page.
        const html = await (await fetch(startUrl)).text();
        // The form embeds the manifest + a CSRF state in its action URL.
        expect(html).toContain('name="manifest"');
        expect(html).toContain('contents'); // the requested permission
        const state = /state=([0-9a-f]+)/.exec(html)?.[1];
        expect(state).toBeTruthy();
        // 2. Simulate GitHub creating the App and redirecting back with a code.
        await fetch(`${startUrl}callback?code=tmp-code-123&state=${state!}`);
      },
    });

    expect(result.appId).toBe('424242');
    expect(result.slug).toBe('agentbox-cp-test');
    expect(result.pem).toContain('BEGIN RSA PRIVATE KEY');
    expect(result.installUrl).toBe('https://github.example/apps/agentbox-cp-test/installations/new');
    expect(conversions).toEqual(['tmp-code-123']); // the code was exchanged exactly once
  });

  it('a stray request after success (favicon/reload) does not crash', async () => {
    // Regression: the handler used to read server.address().port per request,
    // which is null after the post-success server.close() → uncaught throw.
    const result = await runGitHubAppManifestFlow({
      appName: 'agentbox-control-plane',
      apiBaseUrl: fakeApiUrl,
      openBrowser: async (startUrl) => {
        const html = await (await fetch(startUrl)).text();
        const state = /state=([0-9a-f]+)/.exec(html)?.[1];
        await fetch(`${startUrl}callback?code=ok&state=${state!}`);
        // Browser fetches /favicon.ico against the now-closing server.
        await fetch(`${startUrl}favicon.ico`).catch(() => undefined);
      },
    });
    expect(result.appId).toBe('424242');
  });

  it('rejects a callback with a mismatched state (CSRF guard)', async () => {
    await expect(
      runGitHubAppManifestFlow({
        appName: 'x',
        apiBaseUrl: fakeApiUrl,
        timeoutMs: 1500,
        openBrowser: async (startUrl) => {
          await fetch(`${startUrl}callback?code=c&state=WRONG`);
        },
      }),
    ).rejects.toThrow(/timed out/); // bad state is ignored; flow never resolves → times out
    expect(conversions).toEqual([]); // never exchanged
  });
});
