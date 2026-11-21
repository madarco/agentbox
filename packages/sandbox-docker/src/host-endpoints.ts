/**
 * Report the host-loopback model endpoints an agent's docker sync rewrote to
 * `host.docker.internal` (#403), and catch the one case the rewrite cannot fix.
 *
 * On Docker Desktop / OrbStack the alias reaches even a service bound to the
 * host's 127.0.0.1. On a native Linux engine `host-gateway` is the bridge
 * address (docker0, usually 172.17.0.1), so a gateway listening on 127.0.0.1
 * only is still refused from the box. The relay binds 0.0.0.0 for exactly this
 * reason. We cannot fix the user's gateway, so we probe it the way the box
 * will reach it and say what to change.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import {
  DOCKER_HOST_ALIAS,
  formatLoopbackRewrite,
  providerWarning,
  rewriteLoopbackInJsonFile,
  type EndpointPath,
  type LoopbackEndpoint,
} from '@agentbox/core';

/**
 * The bridge gateway address, when the engine runs natively on THIS machine
 * (the address is one of our own interfaces). Null on Docker Desktop / OrbStack
 * (the bridge lives in a VM), a remote `DOCKER_HOST`, or any failure.
 */
export async function localBridgeGateway(): Promise<string | null> {
  const r = await execa(
    'docker',
    ['network', 'inspect', 'bridge', '--format', '{{range .IPAM.Config}}{{.Gateway}} {{end}}'],
    { reject: false },
  );
  if (r.exitCode !== 0) return null;
  const gateways = r.stdout.trim().split(/\s+/).filter(Boolean);
  const local = new Set(
    Object.values(networkInterfaces())
      .flat()
      .map((a) => a?.address)
      .filter((a): a is string => typeof a === 'string'),
  );
  return gateways.find((g) => local.has(g)) ?? null;
}

/** True when something accepts a TCP connection on `host:port` within `timeoutMs`. */
export function tcpReachable(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    const done = (ok: boolean): void => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

let gatewayOnce: Promise<string | null> | null = null;

/**
 * The create-log lines for one agent's rewritten endpoints: one per rewrite,
 * plus a bind-address warning for each port the box will be refused on. All
 * are {@link providerWarning}s so they outlive the create spinner.
 */
export async function loopbackEndpointNotes(
  agent: string,
  endpoints: readonly LoopbackEndpoint[],
  deps: {
    gateway?: () => Promise<string | null>;
    reachable?: (host: string, port: number) => Promise<boolean>;
  } = {},
): Promise<string[]> {
  const rewritten = endpoints.filter((e) => e.rewrittenTo !== undefined);
  if (rewritten.length === 0) return [];
  const notes = rewritten.map((e) => providerWarning(formatLoopbackRewrite(agent, e)));
  const gateway = await (deps.gateway ?? (() => (gatewayOnce ??= localBridgeGateway())))();
  if (gateway === null) return notes;
  const reachable = deps.reachable ?? tcpReachable;
  const ports = [...new Set(rewritten.map((e) => e.port))];
  for (const port of ports) {
    if (await reachable(gateway, port)) continue;
    notes.push(
      providerWarning(
        `${agent}: nothing answers on ${gateway}:${String(port)} (the docker bridge), so the box ` +
          `cannot reach the gateway behind ${rewritten.find((e) => e.port === port)?.url ?? ''}. ` +
          `On a Linux docker engine a service bound to 127.0.0.1 is not reachable from containers: ` +
          `bind it to 0.0.0.0 or ${gateway}.`,
      ),
    );
  }
  return notes;
}

/** One host JSON/JSONC config file that may carry model endpoints. */
export interface EndpointConfigFile {
  /** Absolute host path. */
  src: string;
  /** Path relative to the volume dir the file is synced into. */
  rel: string;
  paths: readonly EndpointPath[];
  /** Label for messages, e.g. `~/.pi/agent/models.json`. */
  source: string;
}

export interface LoopbackOverlay {
  /** Temp dir of rewritten copies laid out by `rel`, or null when nothing was rewritten. */
  dir: string | null;
  endpoints: LoopbackEndpoint[];
  cleanup(): Promise<void>;
}

/**
 * Rewrite host-loopback endpoints in each file to `host.docker.internal` into a
 * temp overlay dir. The volume helper copies it over what rsync brought in, so
 * the host files are never touched and box-only files are never read: only a
 * file the host itself ships is replaced, and rsync was replacing it anyway.
 */
export async function stageLoopbackOverlay(
  files: readonly EndpointConfigFile[],
): Promise<LoopbackOverlay> {
  const endpoints: LoopbackEndpoint[] = [];
  let dir: string | null = null;
  for (const f of files) {
    const r = await rewriteLoopbackInJsonFile(f.src, {
      paths: f.paths,
      source: f.source,
      rewriteHost: DOCKER_HOST_ALIAS,
    });
    if (r === null) continue;
    endpoints.push(...r.endpoints);
    if (!r.changed) continue;
    dir ??= await mkdtemp(join(tmpdir(), 'agentbox-endpoints-'));
    const dest = join(dir, f.rel);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, r.text);
  }
  const made = dir;
  return {
    dir: made,
    endpoints,
    cleanup: async () => {
      if (made) await rm(made, { recursive: true, force: true });
    },
  };
}
