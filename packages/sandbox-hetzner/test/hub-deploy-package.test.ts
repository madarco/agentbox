import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { controlPlaneCloudInit } from '../src/cloud-init.js';
import {
  describeCaddyHop,
  destroyControlPlaneOnHetzner,
  hubContainerPort,
  isFullHubCompose,
} from '../src/control-plane-deploy.js';
import {
  HUB_DEPLOY_ASSETS,
  hubDeployCandidates,
  resolveHubDeployAssets,
} from '../src/hub-deploy-assets.js';

const FAKE_PUBKEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILongTextForKey agentbox/test';
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..');

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'agentbox-hub-deploy-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

/**
 * Package mode ships the compose stack from the host, because there is no repo
 * on the VPS to read it from. Missing files would otherwise surface as an scp
 * failure mid-deploy, after a billable server already exists.
 */
describe('resolveHubDeployAssets', () => {
  it('prefers the staged CLI runtime tree over the monorepo source', () => {
    const staged = tmp();
    for (const asset of HUB_DEPLOY_ASSETS) writeFileSync(join(staged, asset), 'x');
    const resolved = resolveHubDeployAssets({ stagedRoot: staged, repoRoot: REPO_ROOT });
    for (const asset of HUB_DEPLOY_ASSETS) {
      expect(resolved[asset]).toBe(join(staged, asset));
    }
  });

  it('falls back to apps/hub in a workspace dev build', () => {
    const resolved = resolveHubDeployAssets({
      stagedRoot: join(tmp(), 'nope'),
      repoRoot: REPO_ROOT,
    });
    expect(resolved['Dockerfile.package']).toBe(
      resolve(REPO_ROOT, 'apps', 'hub', 'Dockerfile.package'),
    );
  });

  it('throws listing every path tried when nothing resolves', () => {
    const empty = tmp();
    expect(() => resolveHubDeployAssets({ stagedRoot: join(empty, 'a'), repoRoot: empty })).toThrow(
      /could not resolve the control-box deploy assets[\s\S]*docker-compose\.yml/,
    );
  });

  it('always offers the monorepo path as a candidate, staged tree first', () => {
    const cands = hubDeployCandidates('docker-compose.yml', {
      stagedRoot: '/staged',
      repoRoot: '/repo',
    });
    expect(cands).toEqual(['/staged/docker-compose.yml', '/repo/apps/hub/docker-compose.yml']);
  });
});

/**
 * Both modes build the `app` service from the SAME docker-compose.yml — package
 * mode only layers an override that swaps the build block. So the file the deploy
 * ships must keep satisfying the two things the deploy reads out of it.
 */
describe('the shipped docker-compose.yml still drives the deploy', () => {
  it('publishes 8787 to 8787 (the Caddy upstream port) and wires the data dir', async () => {
    const body = await readFile(resolve(REPO_ROOT, 'apps', 'hub', 'docker-compose.yml'), 'utf8');
    expect(hubContainerPort(body)).toBe(8787);
    expect(isFullHubCompose(body)).toBe(true);
  });

  it('the package override replaces the build block and demands a spec', async () => {
    const body = await readFile(
      resolve(REPO_ROOT, 'apps', 'hub', 'docker-compose.package.yml'),
      'utf8',
    );
    expect(body).toContain('dockerfile: Dockerfile.package');
    expect(body).toContain('context: .');
    // `:?` so a deploy that forgot AGENTBOX_SPEC fails loudly at compose time
    // rather than building `@madarco/agentbox@` and 404ing from npm.
    expect(body).toMatch(/AGENTBOX_SPEC: \$\{AGENTBOX_SPEC:\?/);
  });

  it('the package Dockerfile pins the spec and sets the runtime-root envs', async () => {
    const body = await readFile(resolve(REPO_ROOT, 'apps', 'hub', 'Dockerfile.package'), 'utf8');
    expect(body).toContain('ARG AGENTBOX_SPEC');
    expect(body).toContain('@madarco/agentbox@${AGENTBOX_SPEC}');
    // Without NODE_ENV=production Next takes the dev path and dies with
    // "Couldn't find any `pages` or `app` directory" — the standalone has neither.
    expect(body).toContain('ENV NODE_ENV=production');
    // Fingerprint + shared-asset resolution: a container-spawned hub has no parent
    // CLI process to inherit these from.
    expect(body).toContain('ENV AGENTBOX_RUNTIME_ROOT=/opt/agentbox-cli/runtime');
    expect(body).toContain('ENV AGENTBOX_CLI_RUNTIME_DIR=/opt/agentbox-cli/runtime');
    expect(body).toContain('ENV AGENTBOX_CLI_ENTRY=/opt/agentbox-cli/dist/index.js');
    expect(body).toContain('runtime/hub/apps/hub/server.js');
  });

  it('exports the INSTALLED version for /healthz, not the requested spec', async () => {
    const body = await readFile(resolve(REPO_ROOT, 'apps', 'hub', 'Dockerfile.package'), 'utf8');
    // The relay reports AGENTBOX_CLI_VERSION on /healthz, which is what
    // `hub status` shows and `hub update` compares against. A spec may be a
    // dist-tag (`nightly`) or a range, so it must NOT be the source of this.
    expect(body).toContain('AGENTBOX_CLI_VERSION=');
    expect(body).toMatch(/AGENTBOX_CLI_VERSION=[^\n]*package\.json/);
    expect(body).not.toMatch(/AGENTBOX_CLI_VERSION=.*AGENTBOX_SPEC/);
  });

  it('the source image reports its version the same way', async () => {
    const body = await readFile(resolve(REPO_ROOT, 'apps', 'hub', 'Dockerfile'), 'utf8');
    expect(body).toMatch(/AGENTBOX_CLI_VERSION=[^\n]*package\.json/);
  });
});

describe('controlPlaneCloudInit', () => {
  it('clones the repo when a ref is named (source mode)', () => {
    const yaml = controlPlaneCloudInit({
      sshPubkey: FAKE_PUBKEY,
      repo: { url: 'https://github.com/madarco/agentbox.git', ref: 'nightly' },
    });
    expect(yaml).toContain('git clone --depth 1 --branch');
    expect(yaml).toContain("'nightly'");
    expect(yaml).toContain('/opt/agentbox');
  });

  it('skips the clone entirely in package mode, keeping docker + git', () => {
    const yaml = controlPlaneCloudInit({ sshPubkey: FAKE_PUBKEY });
    expect(yaml).not.toContain('git clone');
    expect(yaml).toContain('get.docker.com');
    // git stays: the resident create worker clones repos VPS-side.
    expect(yaml).toContain('apt-get install -y git');
    expect(yaml.startsWith('#cloud-config')).toBe(true);
    expect(yaml).toContain(`- "${FAKE_PUBKEY}"`);
  });
});

/** The staging script must actually put the three files where the resolver looks. */
describe('stage-runtime layout', () => {
  it('resolves from a staged tree shaped like runtime/hub-deploy/', () => {
    const runtime = tmp();
    const hubDeploy = join(runtime, 'hub-deploy');
    mkdirSync(hubDeploy);
    for (const asset of HUB_DEPLOY_ASSETS) writeFileSync(join(hubDeploy, asset), 'x');
    const resolved = resolveHubDeployAssets({ stagedRoot: hubDeploy, repoRoot: REPO_ROOT });
    expect(Object.keys(resolved).sort()).toEqual([...HUB_DEPLOY_ASSETS].sort());
  });
});

/**
 * A failing HTTPS healthz has three very different causes, and the deploy used to
 * report them all as "Caddy can't reach it → wrong upstream port". The verdict now
 * comes from an HTTPS request made ON the VPS, NOT from matching Caddy's log text:
 * `tls.obtain` and `certificate` appear in its success lines too, so log-sniffing
 * reported a healthy certificate plus a real upstream mismatch as a cert problem.
 */
describe('describeCaddyHop', () => {
  // Caddy logs these while SUCCEEDING — the exact strings that made the old
  // substring check fire on a perfectly good certificate.
  const HAPPY_CADDY_LOG = [
    '{"level":"info","logger":"tls.obtain","msg":"obtaining certificate","identifier":"h.example"}',
    '{"level":"info","logger":"tls.obtain","msg":"lock acquired","identifier":"h.example"}',
    '{"level":"info","logger":"tls","msg":"served key authentication certificate"}',
    '{"level":"info","logger":"tls.obtain","msg":"certificate obtained successfully"}',
  ].join('\n');

  const RATE_LIMITED_LOG =
    '{"level":"error","logger":"tls.obtain","msg":"could not get certificate from issuer","error":"HTTP 429 urn:ietf:params:acme:error:rateLimited - too many certificates (5)"}';

  it('blames the upstream port on a 502, even when the log is full of tls.obtain', () => {
    const out = describeCaddyHop('502', HAPPY_CADDY_LOG, 8787, 'h.example');
    expect(out).toContain('Caddy answered 502');
    expect(out).toContain('app:8787');
    expect(out).not.toContain('certificate is the problem');
  });

  it('blames the certificate only when there was no HTTP response at all', () => {
    const out = describeCaddyHop('000', RATE_LIMITED_LOG, 8787, 'h.example');
    expect(out).toContain('certificate is the problem');
    expect(out).toContain('rate-limiting this exact hostname');
  });

  it('names a missing certificate without inventing a rate limit', () => {
    const out = describeCaddyHop('000', HAPPY_CADDY_LOG, 8787, 'h.example');
    expect(out).toContain('certificate is the problem');
    expect(out).toContain('no usable certificate');
    expect(out).not.toContain('rate-limiting');
  });

  it('points outward when the VPS itself serves 200 (DNS / firewall, not the box)', () => {
    const out = describeCaddyHop('200', HAPPY_CADDY_LOG, 8787, 'h.example');
    expect(out).toContain('returned 200');
    expect(out).toContain('h.example');
    expect(out).not.toContain('certificate is the problem');
    expect(out).not.toContain('does not match');
  });

  it('tolerates a curl code with trailing whitespace', () => {
    expect(describeCaddyHop(' 200 \n', HAPPY_CADDY_LOG, 8787, 'h.example')).toContain(
      'returned 200',
    );
  });
});

/**
 * Teardown must never leave the caller unable to clean up. A server someone
 * already deleted by hand (404) used to be indistinguishable from "destroy
 * failed", which would abort before the LOCAL purge — leaving config pointing at
 * a machine that no longer exists and no command that clears it.
 */
describe('destroyControlPlaneOnHetzner', () => {
  it('reports an already-gone server as a warning, and still deletes the firewall', async () => {
    const calls: string[] = [];
    const result = await destroyControlPlaneOnHetzner({
      serverId: 1,
      firewallId: 2,
      client: {
        deleteServer: () => {
          calls.push('server');
          return Promise.reject(new Error('hetzner 404: server not found'));
        },
        deleteFirewall: () => {
          calls.push('firewall');
          return Promise.resolve();
        },
      },
    });
    expect(calls).toEqual(['server', 'firewall']);
    expect(result.serverDeleted).toBe(false);
    expect(result.firewallDeleted).toBe(true);
    expect(result.warnings.join(' ')).toContain('404');
  });

  it('deletes the server before the firewall (Hetzner refuses an attached one)', async () => {
    const calls: string[] = [];
    const result = await destroyControlPlaneOnHetzner({
      serverId: 1,
      firewallId: 2,
      client: {
        deleteServer: () => {
          calls.push('server');
          return Promise.resolve(null);
        },
        deleteFirewall: () => {
          calls.push('firewall');
          return Promise.resolve();
        },
      },
    });
    expect(calls).toEqual(['server', 'firewall']);
    expect(result).toEqual({ serverDeleted: true, firewallDeleted: true, warnings: [] });
  });

  it('never throws, so the local purge always gets to run', async () => {
    const result = await destroyControlPlaneOnHetzner({
      serverId: 1,
      firewallId: 2,
      retryDelayMs: 0,
      client: {
        deleteServer: () => Promise.reject(new Error('boom')),
        deleteFirewall: () => Promise.reject(new Error('still attached')),
      },
    });
    expect(result.serverDeleted).toBe(false);
    expect(result.firewallDeleted).toBe(false);
    expect(result.warnings).toHaveLength(2);
  });

  it('is a no-op for a record with neither id', async () => {
    expect(await destroyControlPlaneOnHetzner({})).toEqual({
      serverDeleted: false,
      firewallDeleted: false,
      warnings: [],
    });
  });
});
