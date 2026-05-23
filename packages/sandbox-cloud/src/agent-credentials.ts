/**
 * Seed Claude / Codex / OpenCode credentials into a cloud sandbox via a
 * per-agent shared volume. Mirrors the Docker provider's host->volume rsync
 * model: the host's `~/.claude` / `~/.codex` / `~/.config/opencode` (+
 * `~/.local/share/opencode`) is the source of truth; on first cloud box per
 * host/org we stage a filtered tarball, upload via `backend.uploadFile`, and
 * extract into the mounted volume. A `.agentbox-seeded-at` marker in the
 * volume records the timestamp so subsequent boxes skip the upload.
 *
 * Re-seeding is **explicit only** — vanilla `agentbox create` never overwrites
 * a seeded volume. The `agentbox resync` command (or the host login flow)
 * passes `force: true` to refresh after the user re-authenticates on the host.
 */

import {
  CLAUDE_FORWARDED_ENV_KEYS,
  CODEX_FORWARDED_ENV_KEYS,
  OPENCODE_FORWARDED_ENV_KEYS,
  stageClaudeForUpload,
  stageCodexForUpload,
  stageOpencodeForUpload,
  type StageResult,
} from '@agentbox/sandbox-docker';
import type { CloudBackend, CloudHandle, CloudVolumeMount } from '@agentbox/core';

/** Identifier for one of the three agents we sync into cloud sandboxes. */
export type CloudAgentKind = 'claude' | 'codex' | 'opencode';

/**
 * Per-agent metadata: the canonical Daytona volume name we use, the in-box
 * absolute mount path, and the staging function. The volume names match the
 * Docker shared-volume names so users running both providers can mentally
 * map docker volume → daytona volume.
 *
 * NB: the volume names are deliberately *the same* as the Docker
 * `SHARED_CLAUDE_VOLUME` / `SHARED_CODEX_VOLUME` / `SHARED_OPENCODE_VOLUME`
 * — they live in disjoint namespaces (Docker engine vs Daytona org-scoped
 * volume registry), so the collision is by design.
 */
interface AgentSpec {
  kind: CloudAgentKind;
  volumeName: string;
  mountPath: string;
  stage: (opts: { hostWorkspace?: string }) => Promise<StageResult>;
}

const AGENT_SPECS: AgentSpec[] = [
  {
    kind: 'claude',
    volumeName: 'agentbox-claude-config',
    mountPath: '/home/vscode/.claude',
    stage: (opts) => stageClaudeForUpload({ hostWorkspace: opts.hostWorkspace }),
  },
  {
    kind: 'codex',
    volumeName: 'agentbox-codex-config',
    mountPath: '/home/vscode/.codex',
    // codex has no workspace-aliased state.
    stage: () => stageCodexForUpload(),
  },
  {
    kind: 'opencode',
    volumeName: 'agentbox-opencode-config',
    mountPath: '/home/vscode/.local/share/opencode',
    stage: () => stageOpencodeForUpload(),
  },
];

/**
 * Marker filename inside each agent's mount path that records when we last
 * seeded the volume from the host. Single ISO-8601 timestamp on disk.
 */
const SEED_MARKER = '.agentbox-seeded-at';

/** Result of `ensureAgentVolumesForCloud` — pass `.mounts` straight into `provision({ volumes })`. */
export interface EnsureAgentVolumesResult {
  /** Volume mounts ready for `CloudProvisionRequest.volumes`. */
  mounts: CloudVolumeMount[];
  /**
   * Env vars to merge into the sandbox env at provision time. Currently:
   * `OPENCODE_CONFIG_DIR` (so the in-box opencode reads its config from the
   * `config/` subdir of the mounted volume rather than `~/.config/opencode`).
   */
  env: Record<string, string>;
  /**
   * The agents we ensured volumes for. Pass this back into
   * `seedAgentVolumesIfFresh` so it doesn't redo the kind list.
   */
  agents: CloudAgentKind[];
}

/**
 * Ensure a Daytona (or other cloud backend) volume exists for each of the
 * three agents and return the list of `{ volumeId, mountPath }` ready to
 * thread into `CloudProvisionRequest.volumes`. Backends that don't implement
 * `ensureVolume` get an empty mount list (and a one-line log).
 *
 * Idempotent: every call is a fast lookup for already-created volumes. Safe
 * to call on every `create`.
 */
export async function ensureAgentVolumesForCloud(
  backend: CloudBackend,
  opts: { onLog?: (line: string) => void } = {},
): Promise<EnsureAgentVolumesResult> {
  const log = opts.onLog ?? (() => {});
  if (typeof backend.ensureVolume !== 'function') {
    log(
      `cloud backend '${backend.name}' has no volume primitive — agent credentials will not persist across boxes`,
    );
    return { mounts: [], env: {}, agents: [] };
  }

  const mounts: CloudVolumeMount[] = [];
  const agents: CloudAgentKind[] = [];
  for (const spec of AGENT_SPECS) {
    try {
      const { volumeId } = await backend.ensureVolume(spec.volumeName);
      mounts.push({ volumeId, mountPath: spec.mountPath });
      agents.push(spec.kind);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`ensureVolume(${spec.volumeName}) failed (skipping): ${msg}`);
    }
  }

  // The in-box opencode reads its config dir from $OPENCODE_CONFIG_DIR; the
  // Docker provider points it at the volume's `config/` subdir (see
  // buildOpencodeMounts), and we do the same here so the config files the
  // host shipped in the opencode tarball are actually loaded.
  const env: Record<string, string> = {};
  if (agents.includes('opencode')) {
    env['OPENCODE_CONFIG_DIR'] = '/home/vscode/.local/share/opencode/config';
  }
  // Forward provider API keys from the host process env into the sandbox at
  // provision time — same set the Docker provider forwards per-agent. For
  // opencode users authenticated via env-var (ANTHROPIC_API_KEY etc.) rather
  // than a stored auth.json, this is the only way the in-box agent finds its
  // credentials. Claude / codex users on file-based OAuth don't need these,
  // but a host that has them set should still propagate them so behavior
  // matches the docker provider 1:1.
  const forwardedKeys = new Set<string>([
    ...CLAUDE_FORWARDED_ENV_KEYS,
    ...CODEX_FORWARDED_ENV_KEYS,
    ...OPENCODE_FORWARDED_ENV_KEYS,
  ]);
  for (const k of forwardedKeys) {
    const v = process.env[k];
    if (typeof v === 'string' && v.length > 0) env[k] = v;
  }

  return { mounts, env, agents };
}

export interface SeedAgentVolumesOptions {
  /** Which agents to consider seeding. Defaults to all three. */
  agents?: CloudAgentKind[];
  /**
   * The host-absolute workspace path being mounted at `/workspace` inside
   * the box. Threaded into `stageClaudeForUpload` so `_claude.json`'s
   * `projects[<hostWorkspace>]` gets aliased to `projects['/workspace']`.
   */
  hostWorkspace?: string;
  /**
   * When true, ignore the in-volume seed marker and re-upload. Used by
   * `agentbox resync` and by the host-login flow. Default: false (vanilla
   * create never overwrites a seeded volume).
   */
  force?: boolean;
  onLog?: (line: string) => void;
}

/**
 * For each enabled agent: probe the in-volume `<mountPath>/.agentbox-seeded-at`
 * marker via `backend.exec`. If absent (or `force: true`), stage a filtered
 * tarball of the host's agent config, upload via `backend.uploadFile`, and
 * extract inside the sandbox.
 *
 * Idempotent and safe to call on every `create`. Warnings from staging (e.g.
 * codex Keychain landmine) are forwarded via `onLog`.
 */
export async function seedAgentVolumesIfFresh(
  backend: CloudBackend,
  handle: CloudHandle,
  opts: SeedAgentVolumesOptions = {},
): Promise<void> {
  const log = opts.onLog ?? (() => {});
  const wanted = new Set<CloudAgentKind>(opts.agents ?? AGENT_SPECS.map((s) => s.kind));
  const specs = AGENT_SPECS.filter((s) => wanted.has(s.kind));

  // Seed each enabled agent in parallel. The three uploads + extracts are
  // independent (distinct volumes, distinct remote tar paths) — running them
  // sequentially adds wall-time on a slow uplink without any safety benefit.
  // Errors per agent are logged via `onLog` but never thrown: a failed seed
  // mustn't take down the whole `create` (the in-box agent falls back to
  // interactive login if its volume comes up empty).
  await Promise.all(specs.map((spec) => seedOne(backend, handle, spec, opts, log)));
}

async function seedOne(
  backend: CloudBackend,
  handle: CloudHandle,
  spec: AgentSpec,
  opts: SeedAgentVolumesOptions,
  log: (line: string) => void,
): Promise<void> {
  if (!opts.force) {
    const probe = await backend.exec(handle, `test -f ${spec.mountPath}/${SEED_MARKER}`);
    if (probe.exitCode === 0) {
      log(`${spec.kind}: volume already seeded — mounting only`);
      return;
    }
  }

  log(`${spec.kind}: staging host config`);
  const staged = await spec.stage({ hostWorkspace: opts.hostWorkspace });
  for (const w of staged.warnings) log(w);
  try {
    if (staged.tarballPath === null) {
      log(`${spec.kind}: nothing to seed`);
      return;
    }

    // Diagnostic: tarball size and timing land on stderr so a non-TTY caller
    // can still see real progress (clack's spinner is TTY-only and otherwise
    // swallows the per-step messages).
    let tarSize = 0;
    try {
      const { statSync } = await import('node:fs');
      tarSize = statSync(staged.tarballPath).size;
    } catch {
      /* best-effort */
    }
    const sizeMB = (tarSize / 1024 / 1024).toFixed(2);
    log(`${spec.kind}: uploading ${sizeMB} MB tarball`);
    process.stderr.write(`[agent-creds] ${spec.kind}: uploading ${sizeMB} MB...\n`);
    const t0 = Date.now();
    const remoteTar = `/tmp/agentbox-${spec.kind}-seed.tar.gz`;
    await backend.uploadFile(handle, staged.tarballPath, remoteTar);
    const upDt = ((Date.now() - t0) / 1000).toFixed(1);
    process.stderr.write(`[agent-creds] ${spec.kind}: upload done in ${upDt}s\n`);
    log(`${spec.kind}: upload done in ${upDt}s`);

    // Extract into the volume's mount point. Daytona's volumes are
    // S3-backed FUSE mounts that reject chmod/utime — the `--no-same-*` +
    // `-m` flags make tar skip those metadata ops so the extract doesn't
    // abort with "Operation not permitted". `--no-same-owner` falls back to
    // the current process UID (Daytona's exec runs as the box's default user,
    // typically uid 1000 on the agentbox image), so we don't need a separate
    // chown step — which would itself fail on the FUSE mount.
    const extractCmd =
      `set -e; ` +
      `cd /tmp; ` +
      `tar -xzf ${remoteTar} -C ${spec.mountPath} --no-same-permissions --no-same-owner -m; ` +
      `date -u +%FT%TZ > ${spec.mountPath}/${SEED_MARKER}; ` +
      `rm -f ${remoteTar}`;
    const extract = await backend.exec(handle, extractCmd);
    if (extract.exitCode !== 0) {
      const msg =
        `${spec.kind}: extract failed (exit ${String(extract.exitCode)}); ` +
        `agent falls back to interactive login. ` +
        `stdout: ${extract.stdout.slice(-200)} stderr: ${extract.stderr.slice(-200)}`;
      log(msg);
      process.stderr.write(`[agent-creds] ${msg}\n`);
      return;
    }
    log(`${spec.kind}: seeded ✓`);
    process.stderr.write(`[agent-creds] ${spec.kind}: seeded\n`);
  } finally {
    await staged.cleanup();
  }
}

/**
 * Spec for a single agent — for callers that need the mount path or volume
 * name outside the create flow (e.g. `agentbox resync`).
 */
export function agentSpecsForCloud(): Array<{
  kind: CloudAgentKind;
  volumeName: string;
  mountPath: string;
}> {
  return AGENT_SPECS.map((s) => ({
    kind: s.kind,
    volumeName: s.volumeName,
    mountPath: s.mountPath,
  }));
}
