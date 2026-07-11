import { readFile } from 'node:fs/promises';
import { confirm, isCancel, log } from '@clack/prompts';
import { resolveCloudSshTarget } from '@agentbox/sandbox-core';
import { Command } from 'commander';
import { resolveBoxOrExit } from '../box-ref.js';
import { restoreAgentSessions } from '../agent-sessions.js';
import { runGitCredsGate } from '../lib/git-creds-gate.js';
import { providerForBox } from '../provider/registry.js';
import { handleLifecycleError } from './_errors.js';

interface ConnectOptions {
  addKey?: string;
  exportKey?: boolean;
  dangerouslyGitCredentials?: boolean;
  json?: boolean;
  yes?: boolean;
}

/** A public SSH key line looks like `ssh-ed25519 AAAA… [comment]` / `ecdsa-…` / `sk-…`. */
function looksLikePublicKey(s: string): boolean {
  return /^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-\S+|sk-ssh-\S+|sk-ecdsa-\S+)\s+\S+/.test(s.trim());
}

function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export const connectCommand = new Command('connect')
  .description(
    'Print a VPS box\'s SSH connection details (to drive it from a phone / other SSH client with the laptop off), ' +
      'add another device\'s key, export the box key, or copy git credentials into the box so it pushes on its own ' +
      '(--dangerously-git-credentials). Pair with `agentbox inbound <box> open` so the box is reachable off-network. ' +
      'Hetzner / DigitalOcean only.',
  )
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option(
    '--add-key <pubkey>',
    "append an SSH PUBLIC key (a key string, or @path to a .pub file) to the box so another device connects with its OWN key — the box's own key never leaves the host (recommended)",
  )
  .option(
    '--export-key',
    "print the box's PRIVATE key to import into a mobile SSH client (Terminus/Blink). The key leaves the host — a new trust edge; confirm required",
  )
  .option(
    '--dangerously-git-credentials',
    "copy a git credential INTO a running box so it can push/pull on its own with your PC off (git.pushMode=direct) — the post-create equivalent of `create --dangerously-with-credentials`. An interactive prompt asks token (HTTPS, unsigned) vs SSH (signs, riskiest). DANGEROUS: the credential lives in the box + its snapshots. Requires a real terminal; cloud only. Restart the agent session afterward.",
  )
  .option('--json', 'machine-readable connection bundle')
  .option('-y, --yes', 'skip the confirmation prompt for --export-key')
  .action(async (idOrName: string | undefined, opts: ConnectOptions) => {
    try {
      const box = await resolveBoxOrExit(idOrName);
      const provider = await providerForBox(box);

      // --- git-credentials mode: make an already-running box push on its own ---
      if (opts.dangerouslyGitCredentials) {
        if (opts.addKey || opts.exportKey) {
          log.error('--dangerously-git-credentials cannot be combined with --add-key / --export-key.');
          process.exit(2);
        }
        if (!provider.enableDirectGit || !provider.buildAttach) {
          log.error(
            `\`connect --dangerously-git-credentials\` needs an SSH cloud box (hetzner / digitalocean) — ` +
              `provider '${box.provider ?? 'docker'}' isn't supported here` +
              (provider.enableDirectGit
                ? ''
                : ' (docker boxes bind-mount the host .git, so git direct mode is N/A)') +
              '.',
          );
          process.exit(2);
        }
        // Resolve the credential host-side (TTY-required token-vs-ssh prompt).
        const projectRoot = box.projectRoot ?? box.workspacePath ?? process.cwd();
        const gate = await runGitCredsGate({ projectRoot, onLog: (l) => log.step(l) });
        if (gate.decision === 'cancel') {
          log.info('cancelled');
          return;
        }
        if (gate.decision === 'skip' || gate.entries.length === 0) {
          log.warn(
            'no git credential could be resolved for this repo (no token / ssh key found); nothing was applied.',
          );
          return;
        }
        // Bring the box online (exec needs it) — reuses the SSH-support check.
        await resolveCloudSshTarget(box, provider, {
          bringOnline: true,
          logInfo: (l) => log.step(l),
        });
        await provider.enableDirectGit(box, gate.entries, {
          hostRepo: projectRoot,
          onLog: (l) => log.step(l),
        });
        log.success(
          `git direct mode enabled for ${box.name} — it can now \`git push\` / \`pull\` on its own with your laptop off.`,
        );
        // A running agent session's env is frozen, so it keeps using the relay
        // until restarted. Offer to restart it now (resuming the conversation).
        const lastAgent = box.lastAgent;
        if (lastAgent && process.stdin.isTTY && !opts.yes) {
          const restart = await confirm({
            message: `Restart the box's ${lastAgent} session now so it uses direct mode? (it resumes the same conversation)`,
            initialValue: true,
          });
          if (!isCancel(restart) && restart) {
            await restoreAgentSessions(box, provider, {
              restoreOnly: lastAgent,
              force: true,
              onLog: (l) => log.step(l),
            });
            log.success(`${lastAgent} restarted in the background — it now pushes direct.`);
            return;
          }
        }
        process.stdout.write(
          lastAgent
            ? `A running ${lastAgent} session keeps using the relay until it restarts. When you're ready:\n` +
                `  agentbox ${lastAgent} ${box.name}   # (or: agentbox recover ${box.name})\n`
            : 'New shells and agent sessions get direct mode automatically.\n',
        );
        return;
      }

      if (!provider.buildAttach) {
        log.error(
          `\`connect\` needs an SSH box — provider '${box.provider ?? 'docker'}' isn't reachable over SSH ` +
            '(only hetzner / digitalocean boxes are).',
        );
        process.exit(2);
      }
      // add-key needs a live box (exec); the read-only bundle / export don't.
      const conn = await resolveCloudSshTarget(box, provider, {
        bringOnline: Boolean(opts.addKey),
        logInfo: (l) => log.step(l),
      });
      if (!conn.identityFile) {
        log.error(`box '${box.name}' has no persistent SSH key — only hetzner / digitalocean boxes are supported.`);
        process.exit(2);
      }

      if (opts.addKey) {
        const raw = opts.addKey.startsWith('@')
          ? (await readFile(opts.addKey.slice(1), 'utf8')).trim()
          : opts.addKey.trim();
        if (!looksLikePublicKey(raw)) {
          log.error(
            'that does not look like an SSH public key (expected e.g. `ssh-ed25519 AAAA… comment`). ' +
              'Pass the public key string or @path-to-key.pub.',
          );
          process.exit(2);
        }
        const q = shellSingleQuote(raw);
        const script =
          'set -e; mkdir -p ~/.ssh && chmod 700 ~/.ssh; ' +
          'touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys; ' +
          `if grep -qxF ${q} ~/.ssh/authorized_keys; then echo already-present; else echo ${q} >> ~/.ssh/authorized_keys && echo added; fi`;
        const res = await provider.exec(box, ['bash', '-lc', script]);
        if (res.exitCode !== 0) {
          log.error(`failed to add key: ${res.stderr || res.stdout || `exit ${String(res.exitCode)}`}`);
          process.exit(1);
        }
        const already = res.stdout.includes('already-present');
        process.stdout.write(
          `${already ? 'key already authorized' : 'key added'} on ${box.name}. ` +
            `Connect with that device's own key:\n  ssh ${conn.user}@${conn.host}\n`,
        );
        return;
      }

      if (opts.exportKey) {
        if (!opts.yes) {
          log.warn(
            `This prints box '${box.name}''s PRIVATE key. Anyone with it can SSH in as ${conn.user}. ` +
              'Prefer `--add-key <your-device.pub>` (the box key then never leaves this host).',
          );
          const ok = await confirm({ message: 'Export the private key?', initialValue: false });
          if (isCancel(ok) || !ok) {
            log.info('cancelled');
            return;
          }
        }
        const priv = await readFile(conn.identityFile, 'utf8');
        // Raw to stdout so it can be piped/redirected cleanly into a keyfile.
        process.stdout.write(priv.endsWith('\n') ? priv : `${priv}\n`);
        return;
      }

      // Default: the connection bundle.
      const inbound = box.cloud?.inbound?.mode ?? 'locked';
      if (opts.json) {
        process.stdout.write(
          JSON.stringify(
            {
              host: conn.host,
              user: conn.user,
              identityFile: conn.identityFile,
              sshCommand: `ssh ${conn.user}@${conn.host} -i ${conn.identityFile}`,
              inbound,
            },
            null,
            2,
          ) + '\n',
        );
        return;
      }
      const reachHint =
        inbound === 'open'
          ? 'reachable from anywhere (inbound: open)'
          : `reachable from your host IP only (inbound: ${inbound}) — run \`agentbox inbound ${box.name} open\` for off-network access`;
      process.stdout.write(
        [
          `host:      ${conn.host}`,
          `user:      ${conn.user}`,
          `identity:  ${conn.identityFile}`,
          ``,
          `connect:   ssh ${conn.user}@${conn.host} -i ${conn.identityFile}`,
          ``,
          `${reachHint}.`,
          `From a phone: copy the identity file to the device (or \`--add-key <device.pub>\`), then use the connect line above.`,
        ].join('\n') + '\n',
      );
    } catch (err) {
      handleLifecycleError(err);
    }
  });
