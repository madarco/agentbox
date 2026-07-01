/**
 * `agentbox install herdr` — generate and link a Herdr plugin
 * (https://herdr.dev/docs/plugins) that adds:
 *   - a boxes-list **overlay** (`prefix+a`) running `agentbox list --herdr --watch`
 *   - a **new box** shortcut (`prefix+shift+a`) opening `agentbox` in a new tab
 *   - a **Ctrl+click** link handler that opens a box's web app (`agentbox://…`)
 *
 * The same plugin is reachable two ways, both producing identical behavior:
 *   - discovery: `herdr plugin install madarco/agentbox` → the repo-root manifest
 *     (`herdr-plugin.toml`); its `[[build]]` runs `build.sh` → `agentbox install
 *     herdr --plugin-keys`. The manifest lives at the repo root (not a subdir) so
 *     the Herdr marketplace, which indexes `herdr-plugin.toml` from each tagged
 *     repo's root, can discover it.
 *   - local: `agentbox install herdr` → the same files under `~/.agentbox`, linked.
 *
 * Herdr runs plugin commands as a bare argv with no shell expansion and an
 * unreliable PATH (e.g. under nvm). So agentbox commands route through a small
 * **shim** (`agentbox-shim.sh`) written at install time with the absolute CLI
 * path — which keeps the manifest itself fully static (committable + identical
 * across machines). Keybindings can't live in the manifest (Herdr ignores
 * manifest keys), so they're spliced into the user's `config.toml`.
 */

import { intro, log, note, outro } from '@clack/prompts';
import { Command, Option } from 'commander';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * The plugin's own version — independent of the CLI version so the committed
 * `herdr-plugin.toml` stays stable across releases. Bump when the plugin's
 * manifest changes.
 */
const PLUGIN_VERSION = '0.2.0';

/** Directory the locally-generated plugin lives in (stable across upgrades). */
export function herdrPluginDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env['AGENTBOX_HOME'] ?? join(homedir(), '.agentbox');
  return join(home, 'herdr', 'plugin');
}

/** Herdr's config file. `HERDR_CONFIG_PATH` overrides; else XDG/`~/.config`. */
export function herdrConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['HERDR_CONFIG_PATH'];
  if (override && override.length > 0) return override;
  const xdg = env['XDG_CONFIG_HOME'];
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config');
  return join(base, 'herdr', 'config.toml');
}

/** The herdr control binary: the in-session path when available, else PATH. */
export function herdrBinary(env: NodeJS.ProcessEnv = process.env): string {
  const b = env['HERDR_BIN_PATH'];
  return b && b.length > 0 ? b : 'herdr';
}

/**
 * The static plugin manifest. Pure + parameterless, so the committed root
 * `herdr-plugin.toml` is byte-identical to what the local install writes (a test
 * asserts this). It lives at the repo root so the Herdr marketplace can index it.
 * agentbox commands go through `agentbox-shim.sh`; the pane-open action uses bare
 * `herdr` (reliably on PATH inside a Herdr pane).
 */
export function buildHerdrManifest(): string {
  return `# AgentBox Herdr plugin (https://herdr.dev/docs/plugins).
# Install:  herdr plugin install madarco/agentbox
# Or, with the AgentBox CLI already installed:  agentbox install herdr
#
# agentbox commands route through ./agentbox-shim.sh, written at install time
# with the absolute path to your AgentBox CLI — Herdr runs plugin commands as a
# bare argv with no shell expansion / unreliable PATH (e.g. under nvm).
id = "agentbox"
name = "AgentBox"
version = "${PLUGIN_VERSION}"
min_herdr_version = "0.7.0"
platforms = ["linux", "macos", "windows"]
description = "AgentBox: live boxes overlay, shortcuts, and Ctrl+click to open a box web app."

[[build]]
command = ["sh", "build.sh"]

[[panes]]
id = "boxes"
title = "AgentBox"
placement = "overlay"
command = ["sh", "agentbox-shim.sh", "list", "--herdr", "--watch"]

[[actions]]
id = "boxes"
title = "AgentBox: boxes overlay"
contexts = ["workspace"]
command = ["herdr", "plugin", "pane", "open", "--plugin", "agentbox", "--entrypoint", "boxes", "--placement", "overlay"]

[[actions]]
id = "new"
title = "AgentBox: new box"
contexts = ["workspace"]
command = ["sh", "agentbox-shim.sh", "herdr", "new"]

[[actions]]
id = "link"
title = "AgentBox: open box link"
contexts = ["workspace"]
command = ["sh", "agentbox-shim.sh", "herdr", "link"]

# Keybindings are NOT declared here — Herdr ignores manifest keys. They're added
# to the user's config.toml by \`agentbox install herdr\` / the build step.

[[link_handlers]]
id = "web"
title = "AgentBox: open box web app"
pattern = "^agentbox://"
action = "link"
`;
}

/** Single-quote a string for /bin/sh. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The shim that the manifest's agentbox commands run. Written at install time
 * with the absolute node + CLI entry, so it works regardless of the Herdr
 * server's PATH. Pure (path in → content out).
 */
export function herdrShimContent(node: string, cliEntry: string): string {
  return `#!/bin/sh
# Generated by \`agentbox install herdr\`. Routes Herdr plugin commands to the
# AgentBox CLI by absolute path (Herdr runs commands without a reliable PATH).
exec ${shq(node)} ${shq(cliEntry)} "$@"
`;
}

/**
 * The committed plugin's `build.sh` — runs during `herdr plugin install`. If the
 * AgentBox CLI is present it finishes setup (shim + keybindings + reload) via
 * `--plugin-keys`; if not, it prints how to get it and exits 0 so the plugin
 * still installs (inert until the CLI arrives). Never aborts the install.
 */
export function herdrBuildScript(): string {
  return `#!/bin/sh
# AgentBox Herdr plugin bootstrap — runs during \`herdr plugin install\`.
# (Local installs via \`agentbox install herdr\` set things up directly instead.)
AGB="$(command -v agentbox || true)"
if [ -z "$AGB" ]; then
  echo "AgentBox CLI not found — the Herdr plugin is installed but inert."
  echo "Install it and finish setup:"
  echo "  npm i -g @madarco/agentbox && agentbox install herdr"
  exit 0
fi
"$AGB" install herdr --plugin-keys || \\
  echo "AgentBox plugin setup hit an issue; finish with: agentbox install herdr"
exit 0
`;
}

const KEY_BEGIN = '# >>> agentbox install herdr (managed) >>>';
const KEY_END = '# <<< agentbox install herdr (managed) <<<';

/**
 * The keybinding block for `~/.config/herdr/config.toml`. Plugin manifests
 * **cannot** declare keybindings (verified against Herdr 0.7 — manifest
 * `[[keys.command]]` is ignored); custom keys live in the user's config.toml and
 * bind to a plugin action via `type = "plugin_action"`.
 */
export function herdrKeybindingsBlock(): string {
  return `${KEY_BEGIN}
# Remove this block (or run \`herdr config reset-keys\`) to drop the shortcuts.
[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "agentbox.boxes"
description = "AgentBox: boxes overlay"

[[keys.command]]
key = "prefix+shift+a"
type = "plugin_action"
command = "agentbox.new"
description = "AgentBox: new box"
${KEY_END}`;
}

/**
 * Idempotently splice our managed keybinding block into an existing config.toml
 * body: strip any prior managed block, then append the fresh one. Pure — tested.
 */
export function upsertHerdrKeybindings(existing: string, block: string): string {
  const stripped = existing.replace(
    new RegExp(`\\n*${escapeRe(KEY_BEGIN)}[\\s\\S]*?${escapeRe(KEY_END)}\\n*`, 'g'),
    '\n',
  );
  const head = stripped.replace(/\s+$/, '');
  return (head.length > 0 ? `${head}\n\n` : '') + block + '\n';
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Write the agentbox shim into `dir`, executable. */
function writeShim(dir: string): void {
  const p = join(dir, 'agentbox-shim.sh');
  writeFileSync(p, herdrShimContent(process.execPath, process.argv[1] ?? 'agentbox'));
  chmodSync(p, 0o755);
}

/** Splice the keybindings into config.toml + reload the running server. */
function applyKeybindings(): string {
  const cfg = herdrConfigPath();
  const existing = existsSync(cfg) ? readFileSync(cfg, 'utf8') : '';
  mkdirSync(dirname(cfg), { recursive: true });
  writeFileSync(cfg, upsertHerdrKeybindings(existing, herdrKeybindingsBlock()));
  spawnSync(herdrBinary(), ['server', 'reload-config'], { stdio: 'ignore' });
  return cfg;
}

interface InstallHerdrOptions {
  dryRun?: boolean;
  pluginKeys?: boolean;
}

export const installHerdrCommand = new Command('herdr')
  .description(
    'Install a Herdr plugin: a boxes-list overlay, keyboard shortcuts, and Ctrl+click to open a box web app.',
  )
  .option('--dry-run', 'print the generated files without writing or linking anything')
  // Internal: invoked by the committed plugin's build.sh after a `herdr plugin
  // install`. The manifest is already registered, so only finish setup.
  .addOption(new Option('--plugin-keys', 'finish setup for a herdr-installed plugin').hideHelp())
  .action((opts: InstallHerdrOptions) => {
    // Build-step mode: the plugin is already registered by `herdr plugin
    // install`; just drop the shim next to the manifest (cwd = plugin root) and
    // wire the keybindings.
    if (opts.pluginKeys) {
      writeShim(process.cwd());
      const cfg = applyKeybindings();
      process.stdout.write(
        `AgentBox: Herdr shortcuts installed (prefix a / prefix shift a) in ${cfg}.\n`,
      );
      return;
    }

    const dir = herdrPluginDir();
    const file = join(dir, 'herdr-plugin.toml');
    const cfgPath = herdrConfigPath();

    if (opts.dryRun) {
      intro('agentbox install herdr (dry run)');
      process.stdout.write(`# --- ${file} ---\n${buildHerdrManifest()}\n`);
      process.stdout.write(`# --- ${join(dir, 'build.sh')} ---\n${herdrBuildScript()}\n`);
      process.stdout.write(
        `# --- ${join(dir, 'agentbox-shim.sh')} ---\n${herdrShimContent(process.execPath, process.argv[1] ?? 'agentbox')}\n`,
      );
      process.stdout.write(`# --- appended to ${cfgPath} ---\n${herdrKeybindingsBlock()}\n`);
      outro(`would write ${dir}/*, edit ${cfgPath}, and run \`herdr plugin link ${dir}\``);
      return;
    }

    mkdirSync(dir, { recursive: true });
    writeFileSync(file, buildHerdrManifest());
    const buildPath = join(dir, 'build.sh');
    writeFileSync(buildPath, herdrBuildScript());
    chmodSync(buildPath, 0o755);
    writeShim(dir);
    const cfg = applyKeybindings();

    intro('AgentBox Herdr plugin');

    // Register (or re-register) the plugin. Link first; only if that fails (an
    // existing `agentbox` plugin from a Herdr install can block the link by id)
    // unlink and retry — so a successful link is never preceded by a destructive
    // unlink that could leave the user with no plugin. Best-effort: if `herdr`
    // isn't on PATH we still wrote the files, so tell the user the commands.
    const bin = herdrBinary();
    let linked = spawnSync(bin, ['plugin', 'link', dir], { stdio: 'ignore' });
    if (linked.status !== 0) {
      spawnSync(bin, ['plugin', 'unlink', 'agentbox'], { stdio: 'ignore' });
      linked = spawnSync(bin, ['plugin', 'link', dir], { stdio: 'ignore' });
    }
    if (linked.status === 0) {
      spawnSync(bin, ['server', 'reload-config'], { stdio: 'ignore' });
    } else {
      log.warn(
        `could not run \`${bin} plugin link\` (is Herdr installed / running?).\n` +
          `Run it yourself:  herdr plugin link ${dir} && herdr server reload-config`,
      );
    }

    note(
      `Wrote ${dir}/\n` +
        `Added shortcuts to ${cfg}\n` +
        (linked.status === 0 ? `Linked with: herdr plugin link ${dir}\n` : '') +
        '\nShortcuts (under Herdr prefix, default Ctrl+b — press the prefix, then the key):\n' +
        '  prefix a        boxes overlay (all boxes)\n' +
        '  prefix shift a  new box in the current project\n' +
        '\nCtrl+click a box name in the overlay to open its web app.\n' +
        '(remove the shortcuts with `herdr config reset-keys`, or by re-running.)\n' +
        '\nTip: set the sidebar agent panel scope to "all" (agent_panel_scope = "all"\n' +
        'in ~/.config/herdr/config.toml, or toggle it in the sidebar) so attached\n' +
        'boxes stay visible when you switch projects.',
      'Installed',
    );
    outro('done');
  });
