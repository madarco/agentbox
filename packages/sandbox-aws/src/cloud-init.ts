/**
 * Cloud-init `#cloud-config` user-data generators.
 *
 * Two flavors:
 *   - **prepare** (`generatePrepareCloudInit`): for the temporary instance that
 *     `prepareAws()` boots to bake the base AMI. Injects a single-use `root`
 *     SSH key; the install script does everything else over ssh.
 *   - **box** (`generateBoxCloudInit`): for per-box instances launched from the
 *     baked AMI. Injects the per-box `vscode` key, the `<box>.localhost`
 *     /etc/hosts alias, and (optionally) `/etc/agentbox/box.env`.
 *
 * ## Why prepare logs in as root, the hard way
 *
 * `install-box.sh` renames whatever account owns UID 1000 to `vscode`
 * (`usermod -l`), so the baked image matches the docker provider's layout. On a
 * Canonical AMI that account is **`ubuntu`** — and `usermod -l` refuses to
 * rename a user that has running processes. If we ssh'd in as `ubuntu`, our own
 * login shell would block the rename and the bake would fail.
 *
 * So the prepare instance must be reached as `root`. Getting root key auth is
 * fiddlier on EC2 than on hetzner/digitalocean, whose stock images make `root`
 * the *default* cloud-init user (so a top-level `ssh_authorized_keys:` lands
 * there). On EC2 the default user is `ubuntu`, so the same block would inject
 * the key for the wrong account. We therefore write root's `authorized_keys`
 * explicitly from `runcmd`, which runs last and overwrites whatever cloud-init's
 * own ssh module put there (including the `disable_root` forced-command banner).
 *
 * Ubuntu's sshd ships `PermitRootLogin prohibit-password`, so key-based root
 * login is allowed once the key is in place.
 *
 * Emitted as a small hand-rolled YAML doc — a full YAML lib is overkill for the
 * handful of fields we touch. Keep every line ASCII (the sibling providers hit
 * user-data truncation on a stray em-dash; EC2 base64-encodes the blob so it is
 * less fragile, but there is no reason to find out).
 */

/**
 * Secrets that must never land in the world-readable (0644) cloud-init
 * `/etc/agentbox/box.env`. The relay token reaches in-box ctl via the daemon's
 * 0600 `relay.env`; the bridge token stays in the daemon's process env.
 *
 * DigitalOcean's naive `startsWith('AGENTBOX_')` filter leaks all three — this
 * is Hetzner's version, and the one worth copying.
 */
const CLOUD_INIT_BOX_ENV_EXCLUDE = new Set<string>([
  'AGENTBOX_RELAY_URL',
  'AGENTBOX_RELAY_TOKEN',
  'AGENTBOX_BRIDGE_TOKEN',
]);

/**
 * Build the cloud-init `box.env` passthrough: the `AGENTBOX_*` identity/portless
 * vars an in-box shell needs, minus the secrets above.
 */
export function cloudInitBoxEnv(
  env: Record<string, string | undefined> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && k.startsWith('AGENTBOX_') && !CLOUD_INIT_BOX_ENV_EXCLUDE.has(k)) {
      out[k] = v;
    }
  }
  return out;
}

export interface PrepareCloudInitOptions {
  /** ed25519/rsa public key string (one line, OpenSSH format). */
  sshPubkey: string;
}

export function generatePrepareCloudInit(opts: PrepareCloudInitOptions): string {
  const pubkey = opts.sshPubkey.trim();
  return [
    '#cloud-config',
    '# AgentBox temporary bake instance - used by `agentbox prepare --provider aws`',
    '# to build the base AMI. The SSH key is single-use and discarded when the',
    '# instance is terminated.',
    'disable_root: false',
    'ssh_pwauth: false',
    'runcmd:',
    // Written from runcmd (the final stage) so it lands AFTER cloud-init's own
    // ssh module, whose `disable_root` handling would otherwise prepend a
    // forced-command banner to root's authorized_keys and lock us out.
    "  - [ install, -d, -m, '0700', -o, root, -g, root, /root/.ssh ]",
    `  - [ bash, -lc, ${yamlScalar(`printf '%s\\n' ${shellQuote(pubkey)} > /root/.ssh/authorized_keys`)} ]`,
    "  - [ chmod, '0600', /root/.ssh/authorized_keys ]",
    "  - [ chown, 'root:root', /root/.ssh/authorized_keys ]",
    // Ubuntu ships root with a locked password (`!`). Key auth works anyway on a
    // stock sshd, but PAM's account stack can reject a locked account on some
    // hardened images. Blanking it costs nothing and removes the failure mode —
    // `ssh_pwauth: false` means an empty password still cannot be used to log in.
    '  - [ passwd, -d, root ]',
    '  - [ bash, -lc, "echo agentbox-prepare-ready" ]',
    '',
  ].join('\n');
}

export interface BoxCloudInitOptions {
  /** ed25519/rsa public key string (one line, OpenSSH format). */
  sshPubkey: string;
  /**
   * Box name. Used to write a `<boxName>.localhost -> 127.0.0.1` /etc/hosts
   * entry so non-browser in-box clients (curl, fetch in Node) can hit the same
   * symmetric Portless URL the host browser sees.
   */
  boxName: string;
  /**
   * Lines for `/etc/agentbox/box.env`, as `KEY=VALUE` pairs. Written as-is; the
   * file is sourced via `set -a; . /etc/agentbox/box.env; set +a`. Pass it
   * through `cloudInitBoxEnv()` first — this file is world-readable.
   */
  boxEnv?: Record<string, string>;
}

/**
 * Cloud-init for a per-box instance launched from the baked AMI. The AMI already
 * has the `vscode` user, the sshd hardening, agentbox-ctl and the agents — this
 * only injects the per-box key and per-box config.
 */
export function generateBoxCloudInit(opts: BoxCloudInitOptions): string {
  const pubkey = opts.sshPubkey.trim();
  const lines: string[] = [
    '#cloud-config',
    `# AgentBox per-box EC2 instance - box '${opts.boxName}'`,
    'disable_root: true',
    'ssh_pwauth: false',
    'users:',
    '  - name: vscode',
    '    lock_passwd: false',
    '    sudo: ALL=(ALL) NOPASSWD:ALL',
    '    ssh_authorized_keys:',
    `      - ${yamlScalar(pubkey)}`,
    'write_files:',
    '  - path: /etc/hosts',
    '    append: true',
    `    content: "127.0.0.1 ${opts.boxName}.localhost\\n"`,
  ];

  if (opts.boxEnv && Object.keys(opts.boxEnv).length > 0) {
    const envContent =
      Object.entries(opts.boxEnv)
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
 * Quote a string as a YAML double-quoted scalar. ssh pubkeys contain spaces and
 * `+`, so a bare scalar is not safe; `"` / `\` don't appear in a valid OpenSSH
 * pubkey but we guard anyway so a future caller can't surprise us.
 */
function yamlScalar(value: string): string {
  if (/["\\]/.test(value)) {
    return JSON.stringify(value);
  }
  return `"${value}"`;
}

/** Single-quote for the shell (the pubkey is embedded in a `bash -lc` string). */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
