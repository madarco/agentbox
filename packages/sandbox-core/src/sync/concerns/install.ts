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
import { resolveAgentInstall } from '@agentbox/core';
import { pushCredentialToBox, resolveHostCredential } from './credentials.js';
import type { AgentInstallRecipe, AgentSettings } from '@agentbox/core';

/**
 * This agent's declared settings, or {} when the config can't be read.
 *
 * Lazy import so `@agentbox/config` stays off this module's static graph, and
 * `agentSettingsFor` already swallows: an install must not fail because a
 * config layer is unreadable, and every consumer treats an absent setting as
 * "the declared default".
 */
async function resolveConfiguredSettings(agent: string): Promise<AgentSettings | undefined> {
  try {
    const { agentSettingsFor } = await import('@agentbox/config');
    return await agentSettingsFor(agent);
  } catch {
    return undefined;
  }
}

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
 *
 * THE SCRIPT RIDES AS A POSITIONAL PARAMETER, never interpolated into a quoted
 * string. It used to be embedded as `sudo -n sh -c "<script with \" escaped>"`,
 * which made the two branches expand at DIFFERENT times: everything `$`-shaped
 * in the sudo branch — `$(command -v claude)`, and any variable the script sets
 * for itself — was substituted by the OUTER shell, as the box user, before sudo
 * ran. So a `postInstall` reading a variable its own prefix exported saw it
 * empty on every cloud provider and correct on docker. Passing it as `$1` means
 * the inner shell does the expansion in both branches, and no escaping is
 * involved at all.
 */
function asRootScript(script: string): string[] {
  return [
    'sh',
    '-c',
    'if [ "$(id -u)" = 0 ]; then sh -c "$1"; else sudo -n sh -c "$1"; fi',
    'agentbox-install',
    script,
  ];
}

/**
 * `KEY=value` exports for an agent's resolved settings, as one shell prefix.
 *
 * The generic escape hatch. `alternatesFrom` and `tuiEnvFrom` cover the two
 * things AgentBox itself knows how to do with a setting; this covers everything
 * else, because an agent that arrives as an npm package can put arbitrary logic
 * in its own `postInstall` and needs its settings there. Nothing in this repo
 * has to learn what the setting means.
 *
 * Prefixed to the recipe AND the post-install so both see them — they are two
 * `exec` calls, not one shell. Values are single-quoted with the standard
 * `'\''` escape: a setting's value is user-supplied config.
 */
export function renderAgentSettingEnv(settings?: AgentSettings): string {
  const entries = Object.entries(settings ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
  if (entries.length === 0) return '';
  const assignments = entries.map(([key, value]) => `${settingEnvName(key)}=${shQuote(value)}`);
  // `export`, not a bare assignment: the recipe spawns processes (npm, an
  // installer script) and a shell variable would not reach them.
  return `export ${assignments.join(' ')}; `;
}

/** `install` -> `AGENTBOX_AGENT_SETTING_INSTALL`. */
export function settingEnvName(key: string): string {
  return `AGENTBOX_AGENT_SETTING_${key.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}`;
}

/** Single-quote for sh. A setting's value is user-supplied config. */
function shQuote(value: string | boolean): string {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
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

/**
 * Install an agent's OS prerequisites, whichever package manager the box has.
 *
 * Dispatches at RUN time rather than bake time because the same recipe is
 * rendered for every provider and there is nothing in an `AgentSyncSpec` that
 * knows the target distro: Debian/Ubuntu everywhere except Vercel, whose
 * sandboxes are Amazon Linux 2023 (dnf). Emitting `apt-get` unconditionally
 * exits 127 there, which used to abort a whole box create.
 *
 * Exit 66 (`EX_NOINPUT`) distinguishes "no package manager I recognise" from a
 * real install failure, so the caller can treat the two differently.
 */
export function renderPackageInstall(pkgs: readonly string[]): string {
  const list = pkgs.join(' ');
  return [
    'if command -v apt-get >/dev/null 2>&1; then',
    `  apt-get update && apt-get install -y --no-install-recommends ${list} && rm -rf /var/lib/apt/lists/*;`,
    'elif command -v dnf >/dev/null 2>&1; then',
    `  dnf install -y ${list};`,
    'elif command -v microdnf >/dev/null 2>&1; then',
    `  microdnf install -y ${list};`,
    'else',
    `  echo "no supported package manager (apt-get/dnf) for: ${list}" >&2; exit 66;`,
    'fi',
  ].join(' ');
}

/** OS prerequisites, if any. Always root. */
async function installPackages(
  transport: SyncTransport,
  pkgs: readonly string[],
): Promise<{ ok: boolean; detail: string }> {
  const r = await transport.exec(asRootScript(renderPackageInstall(pkgs)), { user: 'root' });
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
  opts: { onProgress?: (line: string) => void; settings?: AgentSettings } = {},
): Promise<EnsureAgentInstalledResult> {
  const spec = resolveAgentSpec(agent);
  const probe = await transport.exec(['sh', '-c', `command -v ${spec.binary}`]);
  if (probe.exitCode === 0) return { installed: false };

  opts.onProgress?.(`installing ${spec.id} (absent from this box image)`);
  // The agent's own settings pick an alternate recipe when it declared one
  // (`claude.install: npm`); an agent that declared none falls through to its
  // default recipe.
  //
  // Default them from config rather than requiring every caller to pass them:
  // the bake path threads settings explicitly, but the runtime callers (claude
  // start, the dashboard's agent switch, the cloud attach paths) do not — and a
  // host that set npm BECAUSE the native CDN 403s would otherwise hit that same
  // CDN when adding claude to an existing box.
  const settings = opts.settings ?? (await resolveConfiguredSettings(spec.id));
  const install = resolveAgentInstall(spec.install, settings);

  if (install.packages && install.packages.length > 0) {
    const pkgs = await installPackages(transport, install.packages);
    if (!pkgs.ok) {
      const names = install.packages.join(', ');
      if (install.packagesOptional) {
        // A soft dependency must never cost the user a box. Codex's bubblewrap
        // is the case that matters: without it Codex falls back to a bundled
        // sandbox and warns, so aborting create over it trades a warning for a
        // total failure -- and on Amazon Linux the package may not exist at all.
        opts.onProgress?.(
          `${spec.id}: optional prerequisites (${names}) could not be installed; continuing without them`,
        );
      } else {
        throw new AgentInstallError(
          `${spec.id}: installing its prerequisites (${names}) failed.\n${pkgs.detail.slice(-600)}`,
        );
      }
    }
  }

  const settingEnv = renderAgentSettingEnv(settings);
  const script = settingEnv + renderInstallRecipe(install.recipe);
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
    const post = await transport.exec(asRootScript(settingEnv + install.postInstall), {
      user: 'root',
    });
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
