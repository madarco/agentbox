// Switch a docker box's agent onto another account's LOGIN (hub settings
// Phase 3c). A login lives in the account's config volume, which a container
// mounts at create and can never swap, so the box is rebuilt: the agent's
// session files are copied into the target volume, the container is committed,
// and a new container with the same name, mounts, ports, env and limits is
// created from that commit with the target volume in place of the old one.
// Everything the box keeps in volumes (DinD, editor servers) and binds (.git,
// portless, the ctl socket dir) is re-mounted as it was; the workspace rides in
// the commit. The old container is kept, renamed, until the new one is up, and
// is put back on any failure, so a switch never leaves a half-switched box.
//
// Never the other way round: the target login's credentials are never written
// into the current volume. That would move every other box on that volume and
// make a second holder of the target's refresh token (llm-accounts plan:
// a refresh revokes every other holder).
import { execa } from 'execa';
import { accountConfigVolume, isDefaultAccount, type BoxRecord } from '@agentbox/core';
import {
  accountEnvPolicy,
  findBox,
  readState,
  recordBox,
  resolveAgentSpec,
} from '@agentbox/sandbox-core';
import {
  inspectContainer,
  inspectContainerStatus,
  removeContainer,
  removeImage,
  runBoxArgv,
  stopContainer,
  type RunBoxSpec,
} from './docker.js';
import { startBox } from './lifecycle.js';
import { removeSwitchImages, SWITCH_IMAGE_LABEL, SWITCH_IMAGE_REPO } from './switch-images.js';

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface RecreateOnAccountOptions {
  agent: string;
  /** The target account: `default` or a named login. */
  account: string;
  /** The session to carry over; without one the agent starts fresh. */
  sessionId?: string;
  onLog?: (line: string) => void;
}

/** Why a box cannot be switched by a recreate, or null when it can. Pure. */
export function recreateRefusal(
  box: Pick<BoxRecord, 'provider' | 'agents'>,
  agent: string,
  state: string,
): string | null {
  if ((box.provider ?? 'docker') !== 'docker') {
    return 'switching a cloud box to another login is not supported yet; use a setup token or API key';
  }
  if (state === 'paused') return 'the box is paused; resume it before switching its login';
  if (state === 'missing') return 'the box container is missing';
  const spec = resolveAgentSpec(agent);
  if (!spec.sessionFiles?.length) {
    return `switching ${agent} to another login is not supported yet; use an API key`;
  }
  return null;
}

interface Mount {
  Type?: string;
  Name?: string;
  Source?: string;
  Destination?: string;
  RW?: boolean;
}

interface Inspected {
  Name?: string;
  Image?: string;
  Mounts?: Mount[];
  Config?: { Env?: string[]; User?: string; Labels?: Record<string, string> };
  HostConfig?: {
    Init?: boolean | null;
    Memory?: number;
    NanoCpus?: number;
    PidsLimit?: number | null;
    StorageOpt?: Record<string, string> | null;
    PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> | null;
  };
}

/**
 * The run spec of a live container, with one config volume swapped and one
 * agent's account env replaced. Pure: everything comes from `docker inspect`.
 */
export function respecFromInspect(
  ins: Inspected,
  o: {
    name: string;
    image: string;
    fromVolume: string;
    toVolume: string;
    clearEnv: readonly string[];
    setEnv: Readonly<Record<string, string>>;
  },
): { spec: RunBoxSpec; init: boolean; user?: string } {
  const volumes: string[] = [];
  let swapped = false;
  for (const m of ins.Mounts ?? []) {
    const ro = m.RW === false ? ':ro' : '';
    if (m.Type === 'volume' && m.Name && m.Destination) {
      const name = m.Name === o.fromVolume ? o.toVolume : m.Name;
      if (m.Name === o.fromVolume) swapped = true;
      volumes.push(`${name}:${m.Destination}${ro}`);
    } else if (m.Type === 'bind' && m.Source && m.Destination) {
      volumes.push(`${m.Source}:${m.Destination}${ro}`);
    } else {
      throw new Error(`cannot carry a ${m.Type ?? 'unknown'} mount at ${m.Destination ?? '?'}`);
    }
  }
  if (!swapped) throw new Error(`the box does not mount ${o.fromVolume}`);
  const env: Record<string, string> = {};
  for (const line of ins.Config?.Env ?? []) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i);
    if (o.clearEnv.includes(k)) continue;
    env[k] = line.slice(i + 1);
  }
  Object.assign(env, o.setEnv);
  const portMappings: NonNullable<RunBoxSpec['portMappings']> = [];
  for (const [key, binds] of Object.entries(ins.HostConfig?.PortBindings ?? {})) {
    const containerPort = Number(key.split('/')[0]);
    if (!Number.isFinite(containerPort)) continue;
    for (const b of binds ?? []) {
      portMappings.push({
        containerPort,
        hostPort: Number(b.HostPort || 0),
        ...(b.HostIp ? { hostIp: b.HostIp } : {}),
      });
    }
  }
  const hc = ins.HostConfig ?? {};
  const limits = {
    ...(hc.Memory ? { memoryBytes: hc.Memory } : {}),
    ...(hc.NanoCpus ? { cpus: hc.NanoCpus / 1e9 } : {}),
    ...(hc.PidsLimit && hc.PidsLimit > 0 ? { pidsLimit: hc.PidsLimit } : {}),
    ...(hc.StorageOpt?.size ? { disk: hc.StorageOpt.size } : {}),
  };
  return {
    spec: {
      name: o.name,
      image: o.image,
      extraVolumes: volumes,
      ...(Object.keys(limits).length ? { limits } : {}),
      portMappings,
      env,
    },
    init: hc.Init !== false && hc.Init !== null,
    ...(ins.Config?.User ? { user: ins.Config.User } : {}),
  };
}

async function docker(args: string[]): Promise<string> {
  const r = await execa('docker', args, { reject: false });
  if (r.exitCode !== 0) {
    throw new Error(`docker ${args[0] ?? ''} failed: ${(r.stderr || r.stdout || '').trim()}`);
  }
  return r.stdout.trim();
}

/** Run a shell script in a throwaway root container with two volumes mounted. */
async function withVolumes(
  image: string,
  from: string,
  to: string,
  script: string,
  args: string[] = [],
): Promise<{ code: number; out: string }> {
  const r = await execa(
    'docker',
    [
      'run',
      '--rm',
      '--user',
      '0',
      '--entrypoint',
      'bash',
      '-v',
      `${from}:/from:ro`,
      '-v',
      `${to}:/to`,
      image,
      '-c',
      script,
      'switch',
      ...args,
    ],
    { reject: false },
  );
  return { code: r.exitCode ?? 1, out: `${r.stdout}${r.stderr}`.trim() };
}

/** The named volume a container mounts at `dest`, or undefined. Pure. */
export function mountedConfigVolume(ins: Inspected, dest: string | undefined): string | undefined {
  if (!dest) return undefined;
  const m = (ins.Mounts ?? []).find((x) => x.Type === 'volume' && x.Destination === dest);
  return m?.Name;
}

/** The relative paths of a session's files, from the spec's patterns. Pure. */
export function sessionGlobs(patterns: readonly string[], sessionId: string): string[] {
  return patterns.map((p) => p.replaceAll('{id}', sessionId));
}

/**
 * Switch `agent` in a docker box onto the login `account` by rebuilding the
 * container on that account's config volume. Returns the updated record (its
 * `accounts` already moved), or `recreated: false` with the record untouched
 * when the box already mounts that volume (the caller restarts the agent with
 * the account's env instead). Throws with a person-readable reason, leaving
 * the box as it was.
 */
export async function recreateBoxOnAccount(
  idOrName: string,
  o: RecreateOnAccountOptions,
): Promise<{ record: BoxRecord; recreated: boolean }> {
  const log = o.onLog ?? (() => {});
  const found = findBox(idOrName, await readState());
  if (found.kind !== 'ok') throw new Error(`no box '${idOrName}'`);
  const box = found.box;
  const originalAccounts = box.accounts ? { ...box.accounts } : undefined;
  const container = box.container;
  const state = await inspectContainerStatus(container);
  const refusal = recreateRefusal(box, o.agent, state);
  if (refusal) throw new Error(refusal);
  if (o.sessionId && !SESSION_ID.test(o.sessionId)) throw new Error('invalid session id');

  const spec = resolveAgentSpec(o.agent);
  const toVolume = accountConfigVolume(spec.dockerVolume, o.account);

  const ins = (await inspectContainer(container)) as Inspected[] | Inspected | null;
  const live = Array.isArray(ins) ? ins[0] : ins;
  if (!live) throw new Error('the box container is missing');
  // The volume actually mounted, not the one `accounts` implies: after a
  // switch to a token the record names the token's account while the box
  // still mounts the volume it was created with (or a per-box isolated one).
  const fromVolume = mountedConfigVolume(live, spec.staticPaths?.[0]?.boxDir);
  if (!fromVolume) throw new Error(`the box mounts no ${o.agent} config volume`);
  if (fromVolume === toVolume) return { record: box, recreated: false };

  // The target must hold a login, as a file (a fresh volume seeded from the
  // image has only a dangling symlink there).
  const credRel = spec.credential?.boxRelPath;
  const imageForHelpers = live.Image ?? box.image;
  if (credRel) {
    const probe = await withVolumes(
      imageForHelpers,
      toVolume,
      toVolume,
      'f="/from/$1"; [ -f "$f" ] && [ ! -L "$f" ] && [ -s "$f" ]',
      [credRel],
    );
    if (probe.code !== 0) {
      throw new Error(
        `${o.agent} account '${o.account}' has no login in ${toVolume}; run \`agentbox ${o.agent} login${isDefaultAccount(o.account) ? '' : ` --account ${o.account}`}\` first`,
      );
    }
  }

  // Env: the agent's account keys go; the target's injection (none for a
  // login) comes in.
  const policy = await accountEnvPolicy(spec, o.account);
  const clearEnv = Object.values(spec.accountEnv ?? {}).filter(
    (v): v is string => typeof v === 'string',
  );

  const wasRunning = state === 'running';
  const stamp = Date.now().toString(36);
  const parked = `${container}-pre-switch-${stamp}`;
  const image = `${SWITCH_IMAGE_REPO}:${box.id}-${stamp}`;

  if (wasRunning) {
    log('stopping the box');
    // The in-box dockerd is not a child of the box's init, so `docker stop`
    // kills it and its containerd task dirs under /var/run stay behind; the
    // commit would carry them and the box's inner containers could not start
    // again ("failed to create task ... file exists"). Stop it cleanly first.
    await execa(
      'docker',
      [
        'exec',
        '--user',
        '0',
        container,
        'bash',
        '-c',
        'p=$(cat /var/run/docker.pid 2>/dev/null) || exit 0; kill -TERM "$p" 2>/dev/null || exit 0; ' +
          'for _ in $(seq 1 60); do kill -0 "$p" 2>/dev/null || exit 0; sleep 0.5; done',
      ],
      { reject: false },
    );
    await stopContainer(container);
  }
  log('committing the box');
  await docker(['commit', '--change', `LABEL ${SWITCH_IMAGE_LABEL}=${box.id}`, container, image]);

  if (o.sessionId) {
    const globs = sessionGlobs(spec.sessionFiles ?? [], o.sessionId);
    log(`copying session ${o.sessionId} to ${toVolume}`);
    const copy = await withVolumes(
      image,
      fromVolume,
      toVolume,
      // Each pattern is expanded by the shell under /from; a match is copied
      // to the same relative path, ownership kept.
      'cd /from && shopt -s nullglob && n=0; for g in "$@"; do for p in $g; do ' +
        'mkdir -p "/to/$(dirname "$p")" && cp -a "$p" "/to/$(dirname "$p")/" && n=$((n+1)); ' +
        'done; done; echo "$n"',
      globs,
    );
    if (copy.code !== 0) {
      await removeImage(image).catch(() => false);
      if (wasRunning) await startBox(box.id).catch(() => undefined);
      throw new Error(`could not copy the session: ${copy.out}`);
    }
    if (copy.out.split('\n').pop() === '0') log('no session files found; the agent starts fresh');
  }

  const {
    spec: runSpec,
    init,
    user,
  } = respecFromInspect(live, {
    name: container,
    image,
    fromVolume,
    toVolume,
    clearEnv,
    setEnv: policy.inject,
  });

  log('recreating the box on the new account');
  await docker(['rename', container, parked]);
  try {
    const argv = runBoxArgv(runSpec, { init });
    // `docker create`: the box comes up through startBox, which brings back
    // everything a start does (worktree binds, dockerd, ctl, VNC, sshd,
    // portless routes, relay registration).
    argv.splice(0, 2, 'create');
    if (user && !argv.includes('--user')) argv.splice(1, 0, '--user', user);
    await docker(argv);
    box.accounts = { ...(box.accounts ?? {}) };
    if (isDefaultAccount(o.account)) delete box.accounts[o.agent];
    else box.accounts[o.agent] = o.account;
    if (Object.keys(box.accounts).length === 0) delete box.accounts;
    await recordBox(box);
    if (wasRunning) await startBox(box.id);
  } catch (err) {
    log(`switch failed, restoring the box: ${err instanceof Error ? err.message : String(err)}`);
    await removeContainer(container);
    await docker(['rename', parked, container]).catch(() => '');
    if (originalAccounts) box.accounts = originalAccounts;
    else delete box.accounts;
    await recordBox(box).catch(() => undefined);
    if (wasRunning) await startBox(box.id).catch(() => undefined);
    await removeImage(image).catch(() => false);
    throw err;
  }

  await docker(['rm', parked]).catch(() => '');
  await removeSwitchImages(box.id, image);
  log(`${o.agent} now runs on ${o.account}`);
  const after = findBox(box.id, await readState());
  return { record: after.kind === 'ok' ? after.box : box, recreated: true };
}
