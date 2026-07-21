import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';

/**
 * GitHub App **manifest flow** — create a GitHub App from a manifest without
 * hand-filling the web form. We serve a one-shot local page that auto-POSTs the
 * manifest to GitHub; the user reviews + clicks "Create"; GitHub redirects back
 * to our localhost callback with a `code`; we exchange it for the App's id +
 * private key. See https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
 *
 * The GitHub base URLs and the browser-open are injectable so this is e2e
 * testable against a fake GitHub (and so it works against GitHub Enterprise).
 */
export interface ManifestFlowOptions {
  /** Desired App name (must be globally unique on GitHub). */
  appName: string;
  /** Create under an org instead of the user account. */
  org?: string;
  /** Public-facing URL recorded on the App. */
  homepageUrl?: string;
  /** github.com base (override for GHES / tests). Default https://github.com. */
  githubUrl?: string;
  /** api.github.com base (override for GHES / tests). Default https://api.github.com. */
  apiBaseUrl?: string;
  /** Opens the URL in the user's browser. Injected in tests. */
  openBrowser: (url: string) => void | Promise<void>;
  /** How long to wait for the user to complete the flow. Default 5 min. */
  timeoutMs?: number;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
}

export interface ManifestFlowResult {
  appId: string;
  slug: string;
  /** PEM private key (store 0600). */
  pem: string;
  /** The App's html_url, e.g. https://github.com/apps/<slug>. */
  htmlUrl: string;
  /** Where to install it: https://github.com/apps/<slug>/installations/new. */
  installUrl: string;
}

function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function runGitHubAppManifestFlow(
  opts: ManifestFlowOptions,
): Promise<ManifestFlowResult> {
  const githubUrl = (opts.githubUrl ?? 'https://github.com').replace(/\/$/, '');
  const apiBaseUrl = (opts.apiBaseUrl ?? 'https://api.github.com').replace(/\/$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const log = opts.log ?? (() => {});
  const state = randomBytes(16).toString('hex');

  return new Promise<ManifestFlowResult>((resolve, reject) => {
    // Captured once at listen() time — NEVER read server.address() per request:
    // after the flow settles we close the server, and a stray follow-up request
    // (favicon, a reloaded tab) would otherwise hit a null address and throw.
    let listenPort = 0;
    let settled = false;
    const server = createServer((req, res) => {
      if (settled) {
        res.writeHead(204);
        res.end();
        return;
      }
      const url = new URL(req.url ?? '/', `http://127.0.0.1`);
      const redirectUrl = `http://127.0.0.1:${String(listenPort)}/callback`;

      if (url.pathname === '/') {
        // The manifest GitHub will turn into an App. Repo-scoped write perms.
        const manifest = {
          name: opts.appName,
          url: opts.homepageUrl ?? 'https://agent-box.sh',
          redirect_url: redirectUrl,
          public: false,
          default_permissions: { contents: 'write', pull_requests: 'write' },
        };
        const action = opts.org
          ? `${githubUrl}/organizations/${encodeURIComponent(opts.org)}/settings/apps/new?state=${state}`
          : `${githubUrl}/settings/apps/new?state=${state}`;
        const page = `<!doctype html><html><body>
<p>Creating the GitHub App on GitHub… if this page doesn't redirect, click Continue.</p>
<form id="f" method="post" action="${htmlEscape(action)}">
<input type="hidden" name="manifest" value="${htmlEscape(JSON.stringify(manifest))}">
<button type="submit">Continue to GitHub</button>
</form>
<script>document.getElementById('f').submit()</script>
</body></html>`;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(page);
        return;
      }

      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code') ?? '';
        const gotState = url.searchParams.get('state') ?? '';
        if (gotState !== state) {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end('state mismatch');
          return;
        }
        if (code.length === 0) {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end('missing code');
          return;
        }
        // Exchange the temporary code for the App's id + private key.
        void fetchImpl(`${apiBaseUrl}/app-manifests/${encodeURIComponent(code)}/conversions`, {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'agentbox',
          },
        })
          .then(async (r) => {
            if (!r.ok) throw new Error(`manifest conversion failed (→ ${String(r.status)})`);
            const body = (await r.json()) as {
              id?: number;
              slug?: string;
              pem?: string;
              html_url?: string;
            };
            if (typeof body.id !== 'number' || !body.slug || !body.pem) {
              throw new Error('manifest conversion response missing id/slug/pem');
            }
            const result: ManifestFlowResult = {
              appId: String(body.id),
              slug: body.slug,
              pem: body.pem,
              htmlUrl: body.html_url ?? `${githubUrl}/apps/${body.slug}`,
              installUrl: `${githubUrl}/apps/${body.slug}/installations/new`,
            };
            settled = true;
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end(
              `<!doctype html><html><head><meta charset="utf-8"></head><body><h2>GitHub App created ✓</h2>` +
                `<p>App: ${htmlEscape(result.slug)} (id ${result.appId}). You can close this tab and return to the terminal.</p></body></html>`,
            );
            server.close();
            resolve(result);
          })
          .catch((err: unknown) => {
            settled = true;
            res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
            res.end('conversion failed');
            server.close();
            reject(err instanceof Error ? err : new Error(String(err)));
          });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const timer = setTimeout(
      () => {
        server.close();
        reject(new Error('timed out waiting for the GitHub App manifest flow to complete'));
      },
      opts.timeoutMs ?? 5 * 60_000,
    );
    if (typeof timer.unref === 'function') timer.unref();

    server.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    server.listen(0, '127.0.0.1', () => {
      listenPort = (server.address() as AddressInfo).port;
      const startUrl = `http://127.0.0.1:${String(listenPort)}/`;
      log(`opening ${startUrl} to create the GitHub App…`);
      void Promise.resolve(opts.openBrowser(startUrl)).catch((err: unknown) => {
        log(`could not open the browser automatically: ${err instanceof Error ? err.message : String(err)}`);
        log(`open this URL manually: ${startUrl}`);
      });
    });
  });
}
