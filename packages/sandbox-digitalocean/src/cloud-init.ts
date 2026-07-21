/**
 * Cloud-init `#cloud-config` user-data generators.
 *
 * Two flavors:
 *   - **prepare** (`generatePrepareCloudInit`): for the temporary VPS that
 *     `prepareDigitalOcean()` boots to bake the base snapshot. Just injects a
 *     `root` SSH key — the install script does everything else over ssh.
 *   - **box** (`generateBoxCloudInit`): for per-box VPSes provisioned from
 *     the base snapshot. Injects the per-box ssh pubkey for `vscode`,
 *     optionally writes `/etc/hosts` aliases and `box.env`.
 *
 * The cloud-init format is documented at https://cloudinit.readthedocs.io.
 * We emit it as a small hand-rolled YAML doc — using a full yaml lib would
 * be overkill for the handful of fields we touch (and pulls in the same
 * `yaml` dep `sandbox-cloud` already has, but we keep this package's dep
 * surface minimal).
 */

export interface PrepareCloudInitOptions {
  /** ed25519/rsa public key string (one line, OpenSSH format). */
  sshPubkey: string;
}

/**
 * Cloud-init for the temporary prepare VPS. We log in as `root` here (it's a
 * throwaway VPS that lives ~10–15 min) and run `install-box.sh` over ssh.
 * The install script then creates the `vscode` user, installs everything,
 * and writes the sshd hardening drop-in that disables root login — which
 * doesn't take effect until we reload sshd at the end of the script (the
 * orchestrator finishes its scp/ssh dance before that point).
 */
export function generatePrepareCloudInit(opts: PrepareCloudInitOptions): string {
  const pubkey = opts.sshPubkey.trim();
  return [
    '#cloud-config',
    // IMPORTANT: keep every emitted line ASCII-only. DigitalOcean's user-data
    // delivery truncates the cloud-config at the first non-ASCII byte (an em-dash
    // here silently dropped the whole doc -> no key injected -> ssh publickey
    // denied). See generateBoxCloudInit for the same constraint.
    '# AgentBox temporary prepare VPS - used by `agentbox prepare --provider digitalocean`',
    '# to bake the base snapshot. SSH key is single-use and discarded on VPS destroy.',
    'disable_root: false',
    'ssh_pwauth: false',
    // Inject the single-use key as a TOP-LEVEL `ssh_authorized_keys` (applies to
    // the default user, which is `root` on DigitalOcean images). The `users:`
    // block form does NOT inject a key for root on DO's Ubuntu 24.04 (cloud-init
    // special-cases root under `disable_root`), so key auth failed with
    // "Permission denied (publickey)". The top-level form is reliable.
    'ssh_authorized_keys:',
    `  - ${yamlScalar(pubkey)}`,
    // DigitalOcean's Ubuntu 24.04 stock image ships root's password force-expired
    // (last-change date = 0), so PAM demands a change on first login — which
    // blocks even key-authed non-TTY commands ("Password change required but no
    // TTY available"). `chpasswd.expire:false` covers cloud-init's own run; the
    // runcmd resets root's last-change date to TODAY (clearing the forced-change
    // that `chage -E/-I/-M` alone does NOT touch) and disables all expiry.
    'chpasswd:',
    '  expire: false',
    'runcmd:',
    '  - [ passwd, -d, root ]',
    '  - [ bash, -lc, "chage -d $(date +%Y-%m-%d) -E -1 -I -1 -M 99999 -m 0 root" ]',
    '  - [ bash, -lc, "echo agentbox-prepare-ready" ]',
    '',
  ].join('\n');
}

export interface BoxCloudInitOptions {
  /** ed25519/rsa public key string (one line, OpenSSH format). */
  sshPubkey: string;
  /**
   * Box name. Used to write a `<boxName>.localhost → 127.0.0.1` /etc/hosts
   * entry so non-browser in-box clients (curl, fetch in Node) can hit the
   * symmetric Portless URL the host browser sees.
   */
  boxName: string;
  /**
   * Lines for `/etc/agentbox/box.env` — set as `KEY=VALUE` pairs. Cloud-init
   * `write_files` writes them as-is; no shell escaping is applied because
   * the file is sourced via `set -a; . /etc/agentbox/box.env; set +a`.
   */
  boxEnv?: Record<string, string>;
}

/**
 * Cloud-init for per-box VPSes provisioned from the base snapshot. The
 * base snapshot already has the `vscode` user, sshd hardening, agentbox-ctl,
 * etc. — this just injects the per-box key and any per-box config.
 */
export function generateBoxCloudInit(opts: BoxCloudInitOptions): string {
  const pubkey = opts.sshPubkey.trim();
  const lines: string[] = [
    '#cloud-config',
    // ASCII-only (see generatePrepareCloudInit): DO truncates user-data at the
    // first non-ASCII byte, which would drop the whole cloud-config.
    `# AgentBox per-box VPS - box '${opts.boxName}'`,
    'disable_root: true',
    'ssh_pwauth: false',
    // Same first-login expiry guard as the prepare cloud-init — keeps
    // DigitalOcean's Ubuntu hardening from blocking our key-based vscode login.
    'chpasswd:',
    '  expire: false',
    'users:',
    '  - name: vscode',
    '    lock_passwd: false',
    '    sudo: ALL=(ALL) NOPASSWD:ALL',
    '    ssh_authorized_keys:',
    `      - ${yamlScalar(pubkey)}`,
  ];

  const writeFiles: string[] = [
    '    path: /etc/hosts',
    '    append: true',
    `    content: "127.0.0.1 ${opts.boxName}.localhost\\n"`,
  ];
  lines.push('write_files:');
  lines.push('  - ' + writeFiles[0]);
  for (let i = 1; i < writeFiles.length; i++) {
    lines.push('    ' + writeFiles[i]);
  }

  if (opts.boxEnv && Object.keys(opts.boxEnv).length > 0) {
    const envContent = Object.entries(opts.boxEnv)
      .map(([k, v]) => `${k}=${v}`)
      .join('\\n') + '\\n';
    lines.push('  - path: /etc/agentbox/box.env');
    lines.push('    permissions: "0644"');
    lines.push(`    content: "${envContent}"`);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Quote a string as a YAML scalar. ssh pubkeys may contain spaces and `+`
 * characters; the safe move is to wrap in double quotes and escape `"` /
 * `\` if they appear (they don't for ed25519/rsa). Returns the value
 * already-quoted (so the caller embeds it after the `- ` prefix).
 */
function yamlScalar(value: string): string {
  // No `"` or `\` in a valid OpenSSH pubkey, so a bare double-quote wrap is
  // safe; we still guard so a future caller doesn't surprise us.
  if (/["\\]/.test(value)) {
    return JSON.stringify(value);
  }
  return `"${value}"`;
}
