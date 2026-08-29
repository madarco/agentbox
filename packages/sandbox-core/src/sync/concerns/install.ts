/**
 * Put an agent's binary into a live box.
 *
 * Replaces the hand-written `ensureCodexInstalled` / `ensureOpencodeInstalled`
 * twins (which differed only in four data points) with one implementation
 * driven by `AgentSyncSpec.install`. Two things fall out of that:
 *
 *  - **Cloud boxes gain the capability at all.** The old twins shelled
 *    `docker exec` directly, so a hetzner/e2b/vercel box booted from a snapshot
 *    that predates an agent had no way to get it. Running over `SyncTransport`
 *    covers every provider.
 *  - **A box can carry only the agent it was launched for** and still gain
 *    another on demand, which is what makes one-agent-per-box viable.
 */

import type { SyncTransport } from '@agentbox/core';
import { resolveAgentSpec } from '../registry.js';
import { resolveAgentInstall } from '../agents/types.js';
import { pushCredentialToBox, resolveHostCredential } from './credentials.js';
import type { AgentInstall, AgentInstallRecipe } from '../agents/types.js';

/** Install failed. Callers rewrap into their own agent-specific error type. */
export class AgentInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentInstallError';
  }
}

export interface EnsureAgentInstalledResult {
  /** True when the binary was absent and we installed it just now. */
  installed: boolean;
}

/**
 * Run `script` as root, whichever seam we're on.
 *
 * Docker honours `exec --user root`, so `id -u` is already 0 and we run
 * directly. Cloud backends run as the box user by name and generally ignore a
 * `user` option, so the same command re-enters through passwordless sudo. One
 * string, both transports — and no capability sniffing, which would just be a
 * proxy for this test.
 *
 * `sudo -n` (never prompt) so a box without a sudo grant fails fast with a
 * usable message instead of blocking on a password read that nothing answers.
 */
function asRootScript(script: string): string[] {
  const quoted = script.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return ['sh', '-c', `if [ "$(id -u)" = 0 ]; then ${script}; else sudo -n sh -c "${quoted}"; fi`];
}

/** Render one recipe to a shell snippet. Shared with the docker derived-layer builder. */
export function renderInstallRecipe(recipe: AgentInstallRecipe): string {
  switch (recipe.kind) {
    case 'npm': {
      // `--allow-scripts` is only meaningful on npm >= 11.16 and is required
      // for packages whose lifecycle scripts do real setup work; older npm
      // rejects the unknown flag, so only emit it when the spec asks.
      const flags = recipe.allowScripts ? ` --allow-scripts=${recipe.package}` : '';
      return `npm install -g ${recipe.package}${flags} 2>&1`;
    }
    case 'script':
      // Fetch to a file rather than `curl | bash`: piping hides a blocked
      // download behind bash's exit 0. Retry because the Claude CDN
      // intermittently 403s cloud egress IPs under load.
      //
      // Run the fetched installer with `bash`, not `sh`: /bin/sh is dash on
      // Debian/Ubuntu and these installers are bash scripts (the Dockerfile
      // does the same). Running one under dash dies on the first `[[` or
      // process substitution.
      return [
        'i=1; while :; do',
        `  curl -fsSL ${recipe.url} -o /tmp/agentbox-agent-install.sh`,
        '    && bash /tmp/agentbox-agent-install.sh stable && break;',
        `  [ "$i" -ge ${String(recipe.retries ?? 1)} ] && { rm -f /tmp/agentbox-agent-install.sh; exit 71; };`,
        '  i=$((i+1)); sleep 5;',
        'done; rm -f /tmp/agentbox-agent-install.sh',
      ].join(' ');
    case 'exec':
      return recipe.script;
  }
}

/** The apt line for an agent's prerequisites. Shared with the derived-layer builder. */
export function renderAptInstall(pkgs: readonly string[]): string {
  return `apt-get update && apt-get install -y --no-install-recommends ${pkgs.join(' ')} && rm -rf /var/lib/apt/lists/*`;
}

/** apt prerequisites, if any. Always root. */
async function installApt(
  transport: SyncTransport,
  pkgs: readonly string[],
): Promise<{ ok: boolean; detail: string }> {
  const r = await transport.exec(asRootScript(renderAptInstall(pkgs)), { user: 'root' });
  return { ok: r.exitCode === 0, detail: `${r.stdout}\n${r.stderr}`.trim() };
}

/**
 * Ensure `agent`'s binary is on PATH in the box, installing it if absent.
 *
 * The probe runs as the transport's default user (the box user) because that
 * is whose PATH matters — Claude installs into `~/.local/bin`, so a root probe
 * would miss it.
 */
export async function ensureAgentInstalled(
  transport: SyncTransport,
  agent: string,
  opts: { onProgress?: (line: string) => void; installMode?: string } = {},
): Promise<EnsureAgentInstalledResult> {
  const spec = resolveAgentSpec(agent);
  const probe = await transport.exec(['sh', '-c', `command -v ${spec.binary}`]);
  if (probe.exitCode === 0) return { installed: false };

  opts.onProgress?.(`installing ${spec.id} (absent from this box image)`);
  // `box.claudeInstall: npm` picks claude's npm alternate; every other agent
  // has none and falls through to its default recipe.
  const install = resolveAgentInstall(spec.install, opts.installMode);

  if (install.apt && install.apt.length > 0) {
    const apt = await installApt(transport, install.apt);
    if (!apt.ok) {
      throw new AgentInstallError(
        `${spec.id}: installing its apt prerequisites (${install.apt.join(', ')}) failed.\n${apt.detail.slice(-600)}`,
      );
    }
  }

  const script = renderInstallRecipe(install.recipe);
  // `box-user` recipes must NOT be escalated: Claude's native installer writes
  // to the invoking user's ~/.local/bin, so running it as root would install
  // into /root and leave the box user with no `claude` on PATH.
  const cmd = install.runAs === 'root' ? asRootScript(script) : ['sh', '-lc', script];
  const run = await transport.exec(cmd, install.runAs === 'root' ? { user: 'root' } : undefined);
  if (run.exitCode !== 0) {
    throw new AgentInstallError(
      `${spec.id} is not in this box's image and installing it failed (exit ${String(run.exitCode)}). ` +
        `This box was likely created from a checkpoint or base image captured before ` +
        `${spec.id} support — recapture the project checkpoint from a fresh box. ` +
        `Install output:\n${`${run.stdout}\n${run.stderr}`.trim().slice(-600)}`,
    );
  }

  if (install.postInstall) {
    const post = await transport.exec(asRootScript(install.postInstall), { user: 'root' });
    if (post.exitCode !== 0) {
      throw new AgentInstallError(
        `${spec.id}: post-install step failed (exit ${String(post.exitCode)}).\n${`${post.stdout}\n${post.stderr}`.trim().slice(-600)}`,
      );
    }
  }

  // Confirm the binary actually landed on the box user's PATH. An installer
  // that exits 0 without producing a usable binary is a real failure mode
  // (a 403 masked by a wrapper, a wrong install prefix), and finding out here
  // beats a confusing "session exited immediately" at attach time.
  const verify = await transport.exec(['sh', '-lc', `command -v ${spec.binary}`]);
  if (verify.exitCode !== 0) {
    throw new AgentInstallError(
      `${spec.id}: the installer reported success but \`${spec.binary}\` is still not on PATH in the box.`,
    );
  }

  // Seed the login, as FILES rather than a mount.
  //
  // Reaching here means the box was not built for this agent, so its config
  // volume is not mounted — and docker fixes mounts at `docker run`, so we
  // cannot add one to a running container. Syncing the host-side volume would
  // write somewhere this box can't see and leave the agent unauthenticated
  // with no visible error. Pushing the credential file is what the cloud
  // providers already do on every create (`TransportCaps.ephemeralFs`), so
  // this is the established path, not a workaround. The credential watcher and
  // `extractAgentCredentials` still carry any resulting login back to the host.
  //
  // Best-effort: a box whose agent simply isn't logged in on the host is a
  // normal state, and the agent's own login flow handles it.
  try {
    const credential = await resolveHostCredential(spec.id);
    if (credential !== null) {
      await pushCredentialToBox(transport, spec.id, credential);
      opts.onProgress?.(`seeded ${spec.id} credentials into the box`);
    }
  } catch (err) {
    opts.onProgress?.(
      `could not seed ${spec.id} credentials (${err instanceof Error ? err.message : String(err)}); sign in inside the box`,
    );
  }

  return { installed: true };
}
