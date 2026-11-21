/**
 * Seed the host's agent *static* config (`~/.claude`, `~/.codex`, opencode,
 * `~/.agents`) plus a provider CLAUDE.md overlay into a LIVE cloud sandbox,
 * using only `backend.uploadFile` + `backend.exec`.
 *
 * Providers whose base image is built from a Dockerfile bake this as image
 * layers instead (docker `COPY`/`RUN`, daytona's container class, e2b's
 * template builder) — that's cheaper, so it stays the default where available.
 * This path exists for bases that CANNOT be built from a Dockerfile:
 *
 *   - **daytona `linux-vm`** — Daytona builds a VM snapshot only from a
 *     prebuilt registry image. There are no layers to add, so the seed has to
 *     run against a booted sandbox and be captured by a snapshot afterwards.
 *   - **remote-docker** (`seedsAgentStaticAtCreate`) — its base is ONE shared
 *     image per remote engine with no host config in it, so the seed runs on
 *     every create instead of at prepare.
 *   - (hetzner does the same thing today, inline over ssh/scp — it can adopt
 *     this once the shapes are reconciled.)
 *
 * Static config only: no auth tokens. Renewable credentials are a separate,
 * per-box concern (`agent-credentials.ts`) precisely because they rotate and a
 * baked snapshot doesn't.
 */
import type { CloudBackend, CloudHandle } from '@agentbox/core';
import type { AgentStaticStage } from '@agentbox/sandbox-core';
import { stageAllAgentStatic } from './agent-static-all.js';

/** Box-side staging path for a kind's tarball. */
function remoteTarFor(kind: AgentStaticStage['kind']): string {
  return `/tmp/agentbox-seed-${kind}.tar.gz`;
}

/** Box-side staging path for the provider's /etc/claude-code/CLAUDE.md overlay. */
const REMOTE_CLAUDE_MD = '/tmp/agentbox-custom-CLAUDE.md';

export interface SeedAgentStaticOptions {
  /** Host workspace path, threaded into the claude stager. */
  hostWorkspace?: string;
  /**
   * Which agents to seed. Absent = all. A per-create seed narrows to the box's
   * own agents, so a `agentbox pi` box does not receive `~/.claude` too.
   */
  agents?: readonly string[];
  /** Defaults to `homedir()`; a test points it at a fixture home. */
  hostHome?: string;
  /** Absolute host path to the provider's `/etc/claude-code/CLAUDE.md` overlay. */
  claudeMdOverlay?: string;
  onLog?: (line: string) => void;
}

/**
 * The shell commands that unpack what we just uploaded. Pure + exported so a
 * unit test can assert their shape without a sandbox (mirrors the Dockerfile
 * builder's `seed-commands` test).
 *
 * Differences from the Dockerfile form, all forced by there being no layers:
 *   - No `USER root` / `USER vscode` — exec runs as the image's user (`vscode`),
 *     so root steps go through `sudo` and the process never switches identity.
 *   - Extract AS `vscode` rather than fixing ownership afterwards, so the files
 *     are right by construction; the `chown` stays as cheap belt-and-braces for
 *     anything a tarball carried with odd ownership.
 */
export function buildAgentStaticSeedCommands(
  usable: ReadonlyArray<Pick<AgentStaticStage, 'kind' | 'extractDir'>>,
  opts: { claudeMdOverlay?: boolean } = {},
): string[] {
  const cmds: string[] = [];
  if (opts.claudeMdOverlay) {
    cmds.push(
      `sudo -n mkdir -p /etc/claude-code && sudo -n install -m 0644 ${REMOTE_CLAUDE_MD} /etc/claude-code/CLAUDE.md && rm -f ${REMOTE_CLAUDE_MD}`,
    );
  }
  for (const s of usable) {
    cmds.push(
      `mkdir -p ${s.extractDir} && tar -xzf ${remoteTarFor(s.kind)} -C ${s.extractDir} ` +
        `--no-same-permissions --no-same-owner -m && rm -f ${remoteTarFor(s.kind)}`,
    );
  }
  // Take ownership of exactly what was extracted. Derived from the stages
  // rather than a fixed list of agent home dirs: an agent added later brings
  // its own `extractDir`, and a fixed list would silently leave it root-owned.
  // Each is guarded — a dir only exists when its source did on the host.
  for (const s of usable) {
    cmds.push(
      `( [ -d ${s.extractDir} ] && sudo -n chown -R vscode:vscode ${s.extractDir} || true )`,
    );
  }
  return cmds;
}

export interface SeedAgentStaticResult {
  /** Kinds that actually had something to upload. */
  seeded: AgentStaticStage['kind'][];
}

export async function seedAgentStaticIntoCloudBox(
  backend: CloudBackend,
  handle: CloudHandle,
  opts: SeedAgentStaticOptions = {},
): Promise<SeedAgentStaticResult> {
  const log = opts.onLog ?? (() => {});
  const stages = await stageAllAgentStatic({
    hostWorkspace: opts.hostWorkspace,
    ...(opts.agents ? { agents: opts.agents } : {}),
    ...(opts.hostHome ? { hostHome: opts.hostHome } : {}),
  });
  try {
    for (const s of stages) {
      for (const w of s.staged.warnings) log(w);
    }
    const usable = stages.filter((s) => s.staged.tarballPath !== null);

    if (opts.claudeMdOverlay) {
      await backend.uploadFile(handle, opts.claudeMdOverlay, REMOTE_CLAUDE_MD);
    }
    for (const s of usable) {
      await backend.uploadFile(handle, s.staged.tarballPath as string, remoteTarFor(s.kind));
    }

    const cmds = buildAgentStaticSeedCommands(usable, {
      claudeMdOverlay: Boolean(opts.claudeMdOverlay),
    });
    for (const cmd of cmds) {
      const r = await backend.exec(handle, cmd);
      if (r.exitCode !== 0) {
        // Fail loudly. A silently half-seeded base bakes a broken snapshot that
        // every future box inherits, and the symptom (an agent with no config)
        // surfaces far from the cause.
        throw new Error(
          `agent-static seed failed (exit ${String(r.exitCode)}): ${cmd}\n${r.stdout}${r.stderr}`,
        );
      }
    }
    log(`seeded agent static config: ${usable.map((s) => s.kind).join(', ') || '(none)'}`);
    return { seeded: usable.map((s) => s.kind) };
  } finally {
    await Promise.all(stages.map((s) => s.staged.cleanup()));
  }
}

/**
 * The create-time seed: a no-op (null) unless the backend declared that its
 * `prepare` does not bake the host's static agent config. See
 * `CloudBackend.seedsAgentStaticAtCreate`.
 */
export async function seedAgentStaticForCreate(
  backend: CloudBackend,
  handle: CloudHandle,
  opts: SeedAgentStaticOptions = {},
): Promise<SeedAgentStaticResult | null> {
  if (!backend.seedsAgentStaticAtCreate) return null;
  return seedAgentStaticIntoCloudBox(backend, handle, opts);
}
