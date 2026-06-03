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

import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  stageClaudeStaticForUpload,
  stageClaudeCredentialsForUpload,
  stageCodexStaticForUpload,
  stageCodexCredentialsForUpload,
  stageOpencodeStaticForUpload,
  stageOpencodeCredentialsForUpload,
  stageOpencodeStateForUpload,
  CREDENTIALS_BACKUP_FILE,
  CODEX_CREDENTIALS_BACKUP_FILE,
  OPENCODE_CREDENTIALS_BACKUP_FILE,
  isRealAgentCredential,
  type StageResult,
} from '@agentbox/sandbox-docker';
import type { CloudBackend, CloudHandle, CloudVolumeMount } from '@agentbox/core';

/** Identifier for one of the three agents we sync into cloud sandboxes. */
export type CloudAgentKind = 'claude' | 'codex' | 'opencode';

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

/**
 * Marker filename inside each agent's credentials subpath that records when
 * we last seeded the credentials. Single ISO-8601 timestamp on disk. Absent
 * marker = first time → upload.
 */
const SEED_MARKER = '.agentbox-seeded-at';

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
  opts: { onLog?: (line: string) => void } = {},
): Promise<EnsureAgentVolumesResult> {
  const log = opts.onLog ?? (() => {});
  const allAgents = AGENT_SPECS.map((s) => s.kind);
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
  const wanted = new Set<CloudAgentKind>(opts.agents ?? AGENT_SPECS.map((s) => s.kind));
  const specs = AGENT_SPECS.filter((s) => wanted.has(s.kind));
  await Promise.all(specs.map((spec) => seedCredentialsOne(backend, handle, spec, opts)));
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
    process.stderr.write(`[agent-creds] ${spec.kind}: uploading ${sizeKB} KB...\n`);
    const t0 = Date.now();
    const remoteTar = `/tmp/agentbox-${spec.kind}-creds.tar.gz`;
    await backend.uploadFile(handle, staged.tarballPath, remoteTar);
    const upDt = ((Date.now() - t0) / 1000).toFixed(1);
    process.stderr.write(`[agent-creds] ${spec.kind}: upload done in ${upDt}s\n`);

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
        // <agent>/` dir. `sudo -u vscode` ensures the on-disk file ends up
        // vscode-owned regardless of which user `backend.exec` runs as
        // (e2b: vscode, vercel: vscode, hetzner: vscode via ssh — sudo
        // works on all three because vscode has passwordless sudo). The
        // `--no-same-permissions --no-same-owner -m` flags mirror what
        // vercel/hetzner did in their old custom pushers.
        `set -e; ` +
        `sudo -u vscode mkdir -p ${spec.credentialsMountPath}; ` +
        `sudo -u vscode tar -xzf ${remoteTar} -C ${spec.credentialsMountPath} --no-same-permissions --no-same-owner -m; ` +
        `rm -f ${remoteTar}`;
    const extract = await backend.exec(handle, extractCmd);
    if (extract.exitCode !== 0) {
      const msg =
        `${spec.kind}: credentials extract failed (exit ${String(extract.exitCode)}); ` +
        `agent falls back to interactive login. ` +
        `stdout: ${extract.stdout.slice(-200)} stderr: ${extract.stderr.slice(-200)}`;
      log(msg);
      process.stderr.write(`[agent-creds] ${msg}\n`);
      return;
    }
    log(`${spec.kind}: credentials seeded`);
    process.stderr.write(`[agent-creds] ${spec.kind}: credentials seeded\n`);
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
 * Per-agent: the canonical in-box auth file (what the agent actually reads/
 * writes — NOT the `~/.agentbox-creds` symlink target, because an agent that
 * writes atomically replaces the symlink with a regular file there) and the
 * host backup file we mirror it into.
 */
const EXTRACT_SPECS: Array<{ kind: CloudAgentKind; boxPath: string; hostBackup: string }> = [
  { kind: 'claude', boxPath: '/home/vscode/.claude/.credentials.json', hostBackup: CREDENTIALS_BACKUP_FILE },
  { kind: 'codex', boxPath: '/home/vscode/.codex/auth.json', hostBackup: CODEX_CREDENTIALS_BACKUP_FILE },
  {
    kind: 'opencode',
    boxPath: '/home/vscode/.local/share/opencode/auth.json',
    hostBackup: OPENCODE_CREDENTIALS_BACKUP_FILE,
  },
];

/**
 * Extract the agent login credentials from a running cloud box back to the
 * host backups under `~/.agentbox/`, so the next box (seeded by the cloud
 * push) inherits the login. The cloud analogue of docker's
 * `syncClaudeCredentials` extract direction, generalized to codex/opencode —
 * cloud has no shared volume, so a login captured inside a box would otherwise
 * be lost on destroy.
 *
 * Reads the canonical agent path via `backend.exec(... cat ...)`; only writes
 * the host backup when the content passes `isRealAgentCredential`, so an empty
 * / not-logged-in box never clobbers a good backup. Best-effort per agent
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
  const log = opts.onLog ?? (() => {});
  const extracted: CloudAgentKind[] = [];
  for (const spec of EXTRACT_SPECS) {
    const hostBackup = opts.backups?.[spec.kind] ?? spec.hostBackup;
    try {
      // `cat` the canonical file; tolerate "missing" (exit 1) silently.
      const r = await backend.exec(handle, `cat ${spec.boxPath} 2>/dev/null`, { noRetry: true });
      const text = r.stdout;
      if (r.exitCode !== 0 || !text || !isRealAgentCredential(spec.kind, text)) continue;
      await mkdir(dirname(hostBackup), { recursive: true });
      await writeFile(hostBackup, text, { mode: 0o600 });
      await chmod(hostBackup, 0o600).catch(() => {});
      extracted.push(spec.kind);
      log(`extracted ${spec.kind} login from box to ${hostBackup}`);
    } catch (err) {
      log(
        `WARN: ${spec.kind} credential extract failed (${err instanceof Error ? err.message : String(err)}) — skipping`,
      );
    }
  }
  return extracted;
}
