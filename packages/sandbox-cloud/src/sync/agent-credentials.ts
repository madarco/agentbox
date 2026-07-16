/**
 * Cloud-provider **credentials volume** management — the per-create half of
 * the agent state split. The other half (static config: plugins, skills,
 * settings, marketplaces, codex `config.toml`, opencode `config/`) is
 * layered into the published Daytona snapshot at
 * `agentbox prepare --provider daytona` time via the documented
 * `daytona.snapshot.create({ name, image })` API + `Image.fromDockerfile(...)
 * .addLocalFile(...).runCommands(...)` (see
 * `packages/sandbox-daytona/src/prepare.ts`).
 *
 * What lives here is the runtime side: credentials (`.credentials.json` for
 * claude, `auth.json` for codex/opencode) live on a single per-org
 * `agentbox-credentials` Daytona volume, mounted three times via `subpath`
 * at `/home/vscode/.agentbox-creds/{claude,codex,opencode}/`. Symlinks
 * baked into the box image route the agent-expected paths
 * (`~/.claude/.credentials.json` etc.) through to the volume.
 *
 * `seedAgentVolumesIfFresh` runs at every `agentbox create --provider
 * daytona`: it probes the per-agent marker file in the credentials volume
 * and uploads a tiny credentials-only tarball when missing. Re-seeding is
 * **explicit only** — vanilla create never overwrites credentials it
 * already finds. `agentbox daytona resync` passes `force: true` to refresh
 * after a host re-auth.
 */

import {
  DEFAULT_BOX_IMAGE,
  SHARED_CLAUDE_VOLUME,
  SHARED_CODEX_VOLUME,
  SHARED_OPENCODE_VOLUME,
  extractCodexCredentials,
  extractOpencodeCredentials,
  syncClaudeCredentials,
} from '@agentbox/sandbox-docker';
import {
  AGENT_SYNC_SPECS,
  stageClaudeStaticForUpload,
  stageClaudeCredentialsForUpload,
  stageCodexStaticForUpload,
  stageCodexCredentialsForUpload,
  stageOpencodeStaticForUpload,
  stageOpencodeCredentialsForUpload,
  stageOpencodeStateForUpload,
  extractCredentials,
  hostClaudeBackupExpired,
  isRealAgentCredential,
  pushCredentialToBox,
  readCredentialBackup,
  shouldAcceptCredentialUpdate,
  writeCredentialBackup,
  SEED_MARKER,
  type StageResult,
} from '@agentbox/sandbox-core';
import type { CloudBackend, CloudHandle, CloudVolumeMount, SyncTransport } from '@agentbox/core';
import { createCloudSyncTransport } from './sync-transport.js';

/** Identifier for one of the three agents we sync into cloud sandboxes. */
export type CloudAgentKind = 'claude' | 'codex' | 'opencode';

/**
 * The unprivileged user every cloud box runs its agent as. All the box images /
 * snapshots bake `/home/vscode`, so credentials must land owned by this user.
 * Passed to `backend.exec({ user })` so the extract runs as vscode without an
 * in-box `sudo` (which the docker image doesn't grant — see `seedCredentialsOne`).
 */
const CLOUD_BOX_USER = 'vscode';

/**
 * Single per-org volume that holds all three agents' credentials. Mounted
 * three times via `subpath` so each agent's tokens get their own dir without
 * the volumes-API churn of registering three separate volumes.
 */
const CREDENTIALS_VOLUME = 'agentbox-credentials';

/**
 * Per-agent metadata. `staticMountPath` is where the snapshot-baked static
 * config lives in the sandbox FS; `credentialsMountPath` is where the
 * credentials volume's per-agent subpath gets attached at runtime.
 * `credentialsSubpath` is the subdir inside the shared volume.
 */
interface AgentSpec {
  kind: CloudAgentKind;
  /** Where stage*Static tarballs extract (sandbox FS, snapshot-captured). */
  staticMountPath: string;
  /** Where the credentials-volume subpath gets mounted at runtime. */
  credentialsMountPath: string;
  /** Subdir of the shared credentials volume for this agent. */
  credentialsSubpath: string;
  stageStatic: (opts: { hostWorkspace?: string }) => Promise<StageResult>;
  stageCredentials: () => Promise<StageResult>;
}

const AGENT_SPECS: AgentSpec[] = [
  {
    kind: 'claude',
    staticMountPath: '/home/vscode/.claude',
    credentialsMountPath: '/home/vscode/.agentbox-creds/claude',
    credentialsSubpath: 'claude/',
    stageStatic: (opts) => stageClaudeStaticForUpload({ hostWorkspace: opts.hostWorkspace }),
    stageCredentials: () => stageClaudeCredentialsForUpload(),
  },
  {
    kind: 'codex',
    staticMountPath: '/home/vscode/.codex',
    credentialsMountPath: '/home/vscode/.agentbox-creds/codex',
    credentialsSubpath: 'codex/',
    stageStatic: () => stageCodexStaticForUpload(),
    stageCredentials: () => stageCodexCredentialsForUpload(),
  },
  {
    kind: 'opencode',
    staticMountPath: '/home/vscode/.local/share/opencode',
    credentialsMountPath: '/home/vscode/.agentbox-creds/opencode',
    credentialsSubpath: 'opencode/',
    stageStatic: () => stageOpencodeStaticForUpload(),
    stageCredentials: () => stageOpencodeCredentialsForUpload(),
  },
];

import {
  CLAUDE_FORWARDED_ENV_KEYS,
  CODEX_FORWARDED_ENV_KEYS,
  OPENCODE_FORWARDED_ENV_KEYS,
} from '@agentbox/sandbox-docker';

/** Result of `ensureAgentVolumesForCloud` — pass `.mounts` straight into `provision({ volumes })`. */
export interface EnsureAgentVolumesResult {
  /** Volume mounts ready for `CloudProvisionRequest.volumes`. */
  mounts: CloudVolumeMount[];
  /**
   * Env vars to merge into the sandbox env at provision time. Includes
   * `OPENCODE_CONFIG_DIR` (so the in-box opencode reads its config from the
   * snapshot-baked `config/` subdir of its data dir) and any forwarded
   * provider API keys present in the host env.
   */
  env: Record<string, string>;
  /**
   * Agents we successfully reserved credentials mounts for. Pass back into
   * `seedAgentVolumesIfFresh` so it doesn't redo the kind list.
   */
  agents: CloudAgentKind[];
}

/**
 * Reserve the shared `agentbox-credentials` volume and return three subpath
 * mounts ready to thread into `CloudProvisionRequest.volumes`. Backends that
 * don't implement `ensureVolume` get an empty mount list (and a one-line log)
 * — the in-box agents fall back to interactive login.
 *
 * Idempotent: every call is a fast lookup for the already-created volume.
 * Safe to call on every `create`.
 */
export async function ensureAgentVolumesForCloud(
  backend: CloudBackend,
  opts: { onLog?: (line: string) => void; volumesUsable?: boolean } = {},
): Promise<EnsureAgentVolumesResult> {
  const log = opts.onLog ?? (() => {});
  const allAgents = AGENT_SPECS.map((s) => s.kind);
  // `volumesUsable: false` means the backend has a volume API but this
  // particular sandbox shape can't use it. Daytona's linux-vm class *accepts* a
  // volume mount and even echoes it back in the sandbox DTO — the path just
  // never appears in the guest. Silently mounting nothing would leave the agent
  // credential-less with no diagnostic, so route these boxes down the same
  // per-create upload path hetzner/vercel/e2b already use.
  if (opts.volumesUsable === false) {
    log(
      `cloud backend '${backend.name}' cannot mount volumes for this sandbox class — agent credentials seeded per-create only`,
    );
    return { mounts: [], env: buildForwardedEnv(allAgents), agents: allAgents };
  }
  if (typeof backend.ensureVolume !== 'function') {
    // Non-volume backends (e2b, vercel, hetzner) still get credentials seeded
    // per-create — `seedAgentVolumesIfFresh` falls back to a direct upload+
    // extract into the box-baked `~/.agentbox-creds/<agent>/` dirs. The mounts
    // list stays empty (nothing to persist across boxes) but the agent list is
    // populated so the seed actually runs.
    log(
      `cloud backend '${backend.name}' has no volume primitive — agent credentials seeded per-create only`,
    );
    return { mounts: [], env: buildForwardedEnv(allAgents), agents: allAgents };
  }

  let volumeId: string;
  try {
    const ensured = await backend.ensureVolume(CREDENTIALS_VOLUME);
    volumeId = ensured.volumeId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`ensureVolume(${CREDENTIALS_VOLUME}) failed (skipping credentials seed): ${msg}`);
    return { mounts: [], env: buildForwardedEnv([]), agents: [] };
  }

  const mounts: CloudVolumeMount[] = AGENT_SPECS.map((spec) => ({
    volumeId,
    mountPath: spec.credentialsMountPath,
    subpath: spec.credentialsSubpath,
  }));
  return { mounts, env: buildForwardedEnv(allAgents), agents: allAgents };
}

function buildForwardedEnv(agents: CloudAgentKind[]): Record<string, string> {
  const env: Record<string, string> = {};
  // OpenCode reads its config dir from $OPENCODE_CONFIG_DIR; the snapshot
  // bake puts the config files at <data dir>/config/ to match what the
  // Docker provider does (see buildOpencodeMounts).
  if (agents.includes('opencode')) {
    env['OPENCODE_CONFIG_DIR'] = '/home/vscode/.local/share/opencode/config';
  }
  // Forward provider API keys from the host process env into the sandbox.
  // For agents authenticated via env-var (ANTHROPIC_API_KEY etc.) rather
  // than a stored auth file, this is the only way the in-box agent finds
  // its credentials. Mirrors the Docker provider's per-agent forwarding.
  const forwardedKeys = new Set<string>([
    ...CLAUDE_FORWARDED_ENV_KEYS,
    ...CODEX_FORWARDED_ENV_KEYS,
    ...OPENCODE_FORWARDED_ENV_KEYS,
  ]);
  for (const k of forwardedKeys) {
    const v = process.env[k];
    if (typeof v === 'string' && v.length > 0) env[k] = v;
  }
  return env;
}

export interface SeedAgentVolumesOptions {
  /** Which agents to consider seeding. Defaults to all three. */
  agents?: CloudAgentKind[];
  /**
   * The host-absolute workspace path being mounted at `/workspace` inside
   * the box. Currently unused by the credentials-only seed (no `_claude.json`
   * involved), but kept on the interface for symmetry with the bake step
   * and forward compat with future credential-side rewrites.
   */
  hostWorkspace?: string;
  /**
   * When true, ignore the in-volume seed marker and re-upload. Used by
   * `agentbox daytona resync` and by the host-login flow. Default: false
   * (vanilla create never overwrites a seeded volume).
   */
  force?: boolean;
  onLog?: (line: string) => void;
}

/**
 * For each enabled agent: probe the credentials-subpath
 * `<credentialsMountPath>/.agentbox-seeded-at` marker via `backend.exec`. If
 * absent (or `force: true`), stage a credentials-only tarball, upload via
 * `backend.uploadFile`, extract inside the sandbox into the credentials
 * mount.
 *
 * Idempotent and safe to call on every `create`. Warnings from staging (e.g.
 * codex Keychain landmine) are forwarded via `onLog`. The payload is a
 * single small file per agent, so the FUSE-volume pathology that plagues
 * the static seed is irrelevant here.
 */
export async function seedAgentVolumesIfFresh(
  backend: CloudBackend,
  handle: CloudHandle,
  opts: SeedAgentVolumesOptions = {},
): Promise<void> {
  const log = opts.onLog ?? (() => {});
  const wanted = new Set<CloudAgentKind>(opts.agents ?? AGENT_SPECS.map((s) => s.kind));
  const specs = AGENT_SPECS.filter((s) => wanted.has(s.kind));
  // Best-effort per agent: one agent's seed failure (transient SDK error,
  // missing host creds for that agent) must never sink `agentbox create`.
  // Matches the prior vercel/hetzner custom pushers, which caught + warned.
  // The in-box agent then falls back to interactive login.
  await Promise.allSettled(
    specs.map((spec) =>
      seedCredentialsOne(backend, handle, spec, opts).catch((err) => {
        log(
          `${spec.kind}: credentials seed failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
        );
      }),
    ),
  );
}

/**
 * Force the agent static-config home dirs (`~/.codex`, `~/.claude`,
 * `~/.local/share/opencode`) to be owned by `vscode` on the live box.
 *
 * Why this exists: the agent runs as `vscode`, but a cloud base template can
 * bake these dirs with the wrong owner (E2B's base image ships a `node` user,
 * and the root `npm install -g @openai/codex` step has been observed leaving
 * `~/.codex` as `node:node`). Once we stopped seeding Codex's `state_*.sqlite`
 * index, Codex *creates* it at startup — which fails with EACCES when the dir
 * isn't vscode-writable. A cheap, idempotent chown at create time fixes
 * existing prepared templates without forcing a re-bake.
 *
 * Best-effort: `chown` is rejected on Daytona's S3-backed FUSE volumes, so the
 * command tolerates failure. `chown -R` does not dereference symlinks, so the
 * baked `~/.codex/auth.json -> ~/.agentbox-creds/codex/auth.json` credential
 * symlink (and its peers) are unaffected.
 */
export async function ensureAgentHomeDirsOwned(
  backend: CloudBackend,
  handle: CloudHandle,
  opts: { onLog?: (line: string) => void } = {},
): Promise<void> {
  const log = opts.onLog ?? (() => {});
  const paths = AGENT_SPECS.map((s) => s.staticMountPath).join(' ');
  try {
    await backend.exec(
      handle,
      `sudo -n chown -R vscode:vscode ${paths} 2>/dev/null || true`,
    );
  } catch (err) {
    log(
      `agent home-dir ownership normalize failed (continuing): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Refresh the host-side credential backups (`~/.agentbox/{claude,codex,opencode}-credentials.json`)
 * from the live docker shared volumes BEFORE cloud creates seed from them.
 *
 * Why this exists: `agentbox create --provider <cloud>` reads the host backups
 * to seed cloud boxes, but only the docker create path keeps them current
 * (`syncClaudeCredentials` runs at `packages/sandbox-docker/src/create.ts:593`).
 * Without this refresh, cloud creates push whatever access token the docker
 * volume last extracted — often expired by the time the user actually attaches
 * → in-box `claude` says "401 Invalid authentication credentials" even though
 * the box's `.credentials.json` is present.
 *
 * Best-effort: every helper already swallows its own failures (no docker on
 * the host, missing volume, etc.) and returns a noop result. We only nudge —
 * the seed still runs against whatever backup exists.
 *
 * Gated on `hostClaudeBackupExpired`: when the claude backup's `expiresAt` is
 * in the future we skip the docker round-trip entirely (`docker run` against
 * the shared volume is ~1-2s and almost always a noop on fresh tokens).
 */
export async function refreshAgentCredentialsBackup(opts: {
  onLog?: (line: string) => void;
} = {}): Promise<void> {
  const log = opts.onLog ?? (() => {});
  if (!(await hostClaudeBackupExpired())) {
    return;
  }
  log('claude: host credentials backup expired — refreshing from docker shared volume');
  const image = DEFAULT_BOX_IMAGE;
  try {
    const r = await syncClaudeCredentials({ volume: SHARED_CLAUDE_VOLUME }, { image, isolate: false });
    if (r.direction === 'extracted') {
      log('claude: refreshed host credentials backup from docker shared volume');
    } else if (r.direction === 'noop') {
      log('claude: no docker shared volume to refresh from (continuing with existing backup)');
    }
  } catch {
    /* best-effort — syncClaudeCredentials already swallows internally */
  }
  // codex + opencode are extract-only (no docker bind mount of the host's real
  // ~/.codex into the box like claude has), so always try when the docker
  // volume exists. Both helpers return { copied: false } on any error.
  try { await extractCodexCredentials(SHARED_CODEX_VOLUME, image); } catch { /* best-effort */ }
  try { await extractOpencodeCredentials(SHARED_OPENCODE_VOLUME, image); } catch { /* best-effort */ }
}

async function seedCredentialsOne(
  backend: CloudBackend,
  handle: CloudHandle,
  spec: AgentSpec,
  opts: SeedAgentVolumesOptions,
): Promise<void> {
  const log = opts.onLog ?? (() => {});
  // Non-volume backends (e2b, vercel, hetzner) have an ephemeral per-box FS:
  // the `.agentbox-seeded-at` marker can't survive across boxes, and the host
  // tokens are renewable, so we just push fresh every create. Volume backends
  // (daytona) keep the marker-based idempotency so they don't re-upload into
  // a volume already carrying credentials from a previous box.
  const hasVolume = typeof backend.ensureVolume === 'function';

  if (hasVolume && !opts.force) {
    const probe = await backend.exec(
      handle,
      `test -f ${spec.credentialsMountPath}/${SEED_MARKER}`,
    );
    if (probe.exitCode === 0) {
      log(`${spec.kind}: credentials already seeded — mounting only`);
      return;
    }
  }

  log(`${spec.kind}: staging host credentials`);
  const staged = await spec.stageCredentials();
  for (const w of staged.warnings) log(w);
  try {
    if (staged.tarballPath === null) {
      log(`${spec.kind}: no credentials to seed`);
      return;
    }

    let tarSize = 0;
    try {
      const { statSync } = await import('node:fs');
      tarSize = statSync(staged.tarballPath).size;
    } catch {
      /* best-effort */
    }
    const sizeKB = (tarSize / 1024).toFixed(1);
    log(`${spec.kind}: uploading ${sizeKB} KB credentials tarball`);
    const t0 = Date.now();
    const remoteTar = `/tmp/agentbox-${spec.kind}-creds.tar.gz`;
    try {
      await backend.uploadFile(handle, staged.tarballPath, remoteTar);
    } catch (err) {
      // Match the per-agent best-effort the old vercel/hetzner pushers had:
      // a single agent's upload failure (transient SDK error, network blip)
      // must not sink `agentbox create`. Log and fall through; the in-box
      // agent then falls back to interactive login.
      const msg =
        `${spec.kind}: credentials upload failed (${err instanceof Error ? err.message : String(err)}); ` +
        `agent falls back to interactive login`;
      log(msg);
      return;
    }
    const upDt = ((Date.now() - t0) / 1000).toFixed(1);
    log(`${spec.kind}: upload done in ${upDt}s`);

    const extractCmd = hasVolume
      ? // Daytona volumes are S3-backed FUSE and reject chmod/utime. The
        // credentials payload is one small file, so we extract straight into
        // the mount with `cp` (not tar — tar would chmod the parent dir during
        // delayed-set-stat and abort with EPERM). Two-step: tar into a local-fs
        // staging dir, then cp the file across. Marker tracks idempotency.
        (() => {
          const stageDir = `/tmp/agentbox-creds-stage-${spec.kind}`;
          return (
            `set -e; ` +
            `rm -rf ${stageDir}; ` +
            `mkdir -p ${stageDir}; ` +
            `tar -xzf ${remoteTar} -C ${stageDir}; ` +
            `cp -r ${stageDir}/. ${spec.credentialsMountPath}/; ` +
            `rm -rf ${stageDir}; ` +
            `date -u +%FT%TZ > ${spec.credentialsMountPath}/${SEED_MARKER}; ` +
            `rm -f ${remoteTar}`
          );
        })()
      : // Ephemeral FS: extract straight into the box-baked `~/.agentbox-creds/
        // <agent>/` dir, running the extract AS the box user via `backend.exec`'s
        // `user` option — NOT an in-shell `sudo -u vscode`. Every non-volume
        // backend resolves `user: vscode` through its own mechanism (docker `-u`,
        // ssh-as-vscode, vercel/e2b SDK), so the files land vscode-owned WITHOUT
        // relying on an in-box passwordless-sudo policy. That distinction matters:
        // the shared docker image (remote-docker) does NOT grant vscode sudo, so
        // an in-shell `sudo -u vscode` fails there ("user vscode is not allowed to
        // execute … as vscode"), leaving the box credential-less. The
        // `--no-same-permissions --no-same-owner -m` flags mirror what
        // vercel/hetzner did in their old custom pushers.
        `set -e; ` +
        `mkdir -p ${spec.credentialsMountPath}; ` +
        `tar -xzf ${remoteTar} -C ${spec.credentialsMountPath} --no-same-permissions --no-same-owner -m; ` +
        `rm -f ${remoteTar}`;
    const extract = hasVolume
      ? await backend.exec(handle, extractCmd)
      : await backend.exec(handle, extractCmd, { user: CLOUD_BOX_USER });
    if (extract.exitCode !== 0) {
      const msg =
        `${spec.kind}: credentials extract failed (exit ${String(extract.exitCode)}); ` +
        `agent falls back to interactive login. ` +
        `stdout: ${extract.stdout.slice(-200)} stderr: ${extract.stderr.slice(-200)}`;
      log(msg);
      return;
    }
    log(`${spec.kind}: credentials seeded`);
  } finally {
    await staged.cleanup();
  }
}

/** Box-side OpenCode state dir (default XDG location; cloud sets no XDG_STATE_HOME). */
const OPENCODE_STATE_DIR = '/home/vscode/.local/state/opencode';

/**
 * Seed the host's selected OpenCode model (`~/.local/state/opencode/model.json`)
 * into the box's default state dir, host-authoritative, on **every** create.
 *
 * Unlike credentials (a seed-once volume), the cloud box's state dir is ephemeral
 * — there is no persistent per-box store on either cloud (Daytona's only shared
 * volume holds credentials; Hetzner has none), so the host is authoritative each
 * create and there is no marker to gate on. Without this, OpenCode boots a cloud
 * box with its built-in default model instead of the one the user picked on the
 * host. Provider-agnostic: runs on any `CloudBackend` (`exec` + `uploadFile`).
 *
 * Best-effort: a failure logs and leaves the box on OpenCode's default — it must
 * never fail box creation.
 */
export async function seedOpencodeModelState(
  backend: CloudBackend,
  handle: CloudHandle,
  opts: { onLog?: (line: string) => void } = {},
): Promise<void> {
  const log = opts.onLog ?? (() => {});
  const staged = await stageOpencodeStateForUpload();
  if (staged.tarballPath === null) {
    log('opencode: no host model selection to seed');
    return;
  }
  try {
    const remoteTar = '/tmp/agentbox-opencode-state.tar.gz';
    await backend.uploadFile(handle, staged.tarballPath, remoteTar);
    const res = await backend.exec(
      handle,
      `set -e; mkdir -p ${OPENCODE_STATE_DIR}; ` +
        `tar -xzf ${remoteTar} -C ${OPENCODE_STATE_DIR}; ` +
        `chown -R vscode:vscode ${OPENCODE_STATE_DIR} 2>/dev/null || true; ` +
        `rm -f ${remoteTar}`,
    );
    if (res.exitCode !== 0) {
      log(
        `opencode: model-state seed failed (exit ${String(res.exitCode)}); ` +
          `box falls back to OpenCode's default model. stderr: ${res.stderr.slice(-200)}`,
      );
      return;
    }
    log('opencode: model selection seeded ✓');
  } finally {
    await staged.cleanup();
  }
}

/**
 * Spec for a single agent — for callers that need the mount path or volume
 * name outside the create flow.
 */
export function agentSpecsForCloud(): Array<{
  kind: CloudAgentKind;
  staticMountPath: string;
  credentialsMountPath: string;
  credentialsSubpath: string;
}> {
  return AGENT_SPECS.map((s) => ({
    kind: s.kind,
    staticMountPath: s.staticMountPath,
    credentialsMountPath: s.credentialsMountPath,
    credentialsSubpath: s.credentialsSubpath,
  }));
}

/**
 * Extract the agent login credentials from a running cloud box back to the
 * host backups under `~/.agentbox/`, so the next box (seeded by the cloud
 * push) inherits the login. The cloud analogue of docker's
 * `syncClaudeCredentials` extract direction, generalized to codex/opencode —
 * cloud has no shared volume, so a login captured inside a box would otherwise
 * be lost on destroy.
 *
 * Thin wrapper: the provider-neutral `extractCredentials` concern
 * (`@agentbox/sandbox-core`) does the box→host work against the
 * `SyncTransport.readText` seam (registry-driven box paths + host backups + the
 * `isRealAgentCredential` guard); this just injects the `CloudSyncTransport`.
 * `CloudSyncTransport.readText` is `cat <path> 2>/dev/null` with `noRetry`,
 * byte-identical to the extract this used to inline. Best-effort per agent
 * (never throws). Returns the list of agents whose backup was updated.
 */
export async function extractCloudAgentCredentials(
  backend: CloudBackend,
  handle: CloudHandle,
  opts: {
    onLog?: (line: string) => void;
    /** Override host backup paths per agent (tests). Defaults to the ~/.agentbox constants. */
    backups?: Partial<Record<CloudAgentKind, string>>;
  } = {},
): Promise<CloudAgentKind[]> {
  const transport = createCloudSyncTransport({ backend, handle });
  return extractCredentials(transport, { onLog: opts.onLog, backups: opts.backups });
}

/**
 * Reconcile a just-woken cloud box's agent credentials with the host backups.
 * A resumed box carries whatever blobs it had at pause — if another box
 * rotated the claude refresh token meanwhile, the resumed copy is dead
 * (claude's OAuth refresh invalidates every other copy).
 *
 * Per agent, per the fan-out ordering rules (`shouldAcceptCredentialUpdate`):
 *  - claude: `expiresAt` decides both directions — host newer → push into the
 *    box; box newer (it refreshed right before pause and the fan-out missed
 *    it) → capture to the host backup (the box's own ctl watcher re-posts on
 *    daemon start, which fans it out to the rest of the fleet);
 *  - codex/opencode: host-wins on resume (the box was frozen, so the host
 *    backup is at least as fresh) — push when the content differs;
 *  - a missing host backup is captured from a real box blob for any agent.
 *
 * Best-effort per agent: a reconcile failure never fails resume/start.
 */
export async function reconcileAgentCredentials(
  backend: CloudBackend,
  handle: CloudHandle,
  opts: ReconcileAgentCredentialsOptions = {},
): Promise<void> {
  return reconcileAgentCredentialsViaTransport(
    createCloudSyncTransport({ backend, handle }),
    opts,
  );
}

export interface ReconcileAgentCredentialsOptions {
  onLog?: (line: string) => void;
  /** Override host backup paths per agent (tests). Defaults to the registry `hostBackup`. */
  backups?: Partial<Record<CloudAgentKind, string>>;
}

/** Transport-seam core of {@link reconcileAgentCredentials} (unit-testable). */
export async function reconcileAgentCredentialsViaTransport(
  transport: SyncTransport,
  opts: ReconcileAgentCredentialsOptions = {},
): Promise<void> {
  const log = opts.onLog ?? (() => {});
  for (const spec of AGENT_SYNC_SPECS) {
    const backupPath = opts.backups?.[spec.id];
    try {
      const hostText = await readCredentialBackup(spec.id, { backupPath });
      const boxText = await transport.readText(spec.credential.boxAbsPath);
      const hostReal = hostText !== null && isRealAgentCredential(spec.id, hostText);
      const boxReal = boxText !== null && boxText.length > 0 && isRealAgentCredential(spec.id, boxText);
      if (!hostReal && !boxReal) continue;
      if (!hostReal && boxReal) {
        await writeCredentialBackup(spec.id, boxText, { backupPath });
        log(`captured ${spec.id} credential from box (no host backup)`);
        continue;
      }
      if (
        boxReal &&
        spec.credential.realShape === 'claude-oauth' &&
        shouldAcceptCredentialUpdate(spec.id, boxText, hostText).accept
      ) {
        await writeCredentialBackup(spec.id, boxText, { backupPath });
        log(`captured newer ${spec.id} credential from box`);
        continue;
      }
      if (!boxReal || shouldAcceptCredentialUpdate(spec.id, hostText!, boxText).accept) {
        await pushCredentialToBox(transport, spec.id, hostText!);
        log(`refreshed ${spec.id} credential in box from host backup`);
      }
    } catch (err) {
      log(
        `WARN: ${spec.id} credential reconcile failed (${err instanceof Error ? err.message : String(err)}) — skipping`,
      );
    }
  }
}
