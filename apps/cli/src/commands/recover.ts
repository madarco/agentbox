/**
 * `agentbox recover` — re-establish a box's host-side connectivity WITHOUT
 * power-cycling it, relaunch the agent it was running, and (optionally) attach.
 *
 * A box's host-side state (the relay's in-memory registry + CloudBoxPoller, the
 * Hetzner SSH ControlMaster + port forwards, the host portless aliases, the
 * detached agent tmux session) is separate from the box itself and is lost on a
 * host reboot / relay restart / new CLI process — while the sandbox keeps
 * running. `start`/`unpause` only fix this by power-cycling the box, and can't
 * touch a box that's missing from local state at all. `recover`:
 *
 *   1. ensures the host relay is up and re-pushes every persisted box to it
 *      (rehydrate → restarts the cloud pollers),
 *   2. calls `provider.reconnect(box)` — re-resolves preview URLs, re-opens the
 *      Hetzner tunnel, re-registers portless + the relay poller, relaunches the
 *      in-box daemons — without a power-cycle when the box is already up,
 *   3. relaunches the agent the box was running (resuming its session, or
 *      starting `box.lastAgent` fresh when nothing is resumable),
 *   4. attaches to it (single-box; skipped for `--all` / `--no-attach`).
 *
 * With `--provider <p> --adopt [ref]` it first rebuilds a `BoxRecord` for a box
 * that's missing from local state (e.g. created on another host) from what the
 * live sandbox exposes, regenerating fresh relay/bridge tokens, then recovers it.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { isCancel, log, select } from '@clack/prompts';
import {
  generateBoxId,
  normalizeLastAgent,
  type BoxRecord,
  type CloudBackend,
  type CloudSandboxSummary,
} from '@agentbox/core';
import { ensureRelay, generateRelayToken, readState, recordBox } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { restoreAgentSessions } from '../agent-sessions.js';
import { withFirewallRepair } from '../lib/firewall-repair.js';
import { resolveBoxOrExit } from '../box-ref.js';
import { providerForBox } from '../provider/registry.js';
import { cloudBackendForProvider } from '../provider/cloud-backend.js';
import { isKnownProvider } from '../provider/registry.js';
import { attachToRunningAgent } from './attach.js';
import { rehydrateFromState } from './relay.js';
import { handleLifecycleError } from './_errors.js';
import { resolveCustodyTarget } from './control-plane.js';
import { ControlPlaneAdminClient } from '../control-plane/admin-client.js';
import { CustodyClient } from '../control-plane/custody-client.js';
import { pullBoxSshKeys } from '../control-plane/hub-pull.js';
import { hostReachable } from '../control-plane/hub-list.js';

/** Is the control box up? A live host answers in milliseconds. */
const CUSTODY_PROBE_MS = 1500;
/** Bound on the key download itself, once the host is known to be up. */
const CUSTODY_PULL_MS = 10_000;

interface RecoverOpts {
  all?: boolean;
  attach?: boolean;
  firewallSync?: boolean;
  provider?: string;
  adopt?: boolean;
  attachIn?: string;
  inline?: boolean;
}

/**
 * The per-box Hetzner SSH private key. Mirrors `defaultBoxSshDir` in
 * `@agentbox/sandbox-hetzner` (kept inline so recover doesn't statically pull
 * the Hetzner SDK). A missing key means the box was created on another host —
 * we can't drive it from here.
 */
function hetznerKeyPath(sandboxId: string): string {
  return join(homedir(), '.agentbox', 'boxes', sandboxId, 'ssh', 'id_ed25519');
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** True when this box can't be controlled from this host (Hetzner key gone). */
async function hetznerKeyMissing(box: BoxRecord): Promise<boolean> {
  if ((box.provider ?? 'docker') !== 'hetzner') return false;
  const sandboxId = box.cloud?.sandboxId;
  if (!sandboxId) return false;
  return !(await fileExists(hetznerKeyPath(sandboxId)));
}

/**
 * A missing per-box key isn't fatal when a control box is configured: the box
 * may have been created there (or by another PC that pushed its key up), and
 * custody holds the material. Try one download before declaring the box
 * uncontrollable. Best-effort — returns true only when the key now exists.
 */
async function tryPullKeyFromCustody(box: BoxRecord): Promise<boolean> {
  try {
    const target = await resolveCustodyTarget(undefined, { quiet: true });
    if (!target) return false;
    // Probe + bound exactly like the other control-box calls: an unreachable
    // host can't be cancelled mid-connect (undici holds the socket for ~10s),
    // and `recover --all` would pay that for every Hetzner box in state.
    if (!(await hostReachable(target.url, CUSTODY_PROBE_MS))) return false;
    const signal = AbortSignal.timeout(CUSTODY_PULL_MS);
    const clientTarget = {
      ...target,
      fetchImpl: ((url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        fetch(url, { ...init, signal })) as typeof fetch,
    };
    await pullBoxSshKeys({
      admin: new ControlPlaneAdminClient(clientTarget),
      custody: new CustodyClient(clientTarget),
      box: box.cloud?.sandboxId ?? box.name,
    });
    return !(await hetznerKeyMissing(box));
  } catch {
    return false;
  }
}

/** Read the box's checked-out branch, best-effort (adopted boxes only). */
async function readBoxBranch(box: BoxRecord): Promise<string | undefined> {
  try {
    const provider = await providerForBox(box);
    const r = await provider.exec(box, ['git', '-C', '/workspace', 'branch', '--show-current'], {
      user: 'vscode',
    });
    const branch = r.exitCode === 0 ? r.stdout.trim() : '';
    return branch.length > 0 ? branch : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Recover one already-known box: reconnect host-side, relaunch its agent, and
 * (optionally) attach. Returns false on a non-fatal skip (e.g. Hetzner key
 * gone) so `--all` keeps going.
 */
async function recoverKnownBox(
  box: BoxRecord,
  opts: { attach: boolean; firewallSync: boolean },
): Promise<boolean> {
  if ((await hetznerKeyMissing(box)) && !(await tryPullKeyFromCustody(box))) {
    log.warn(
      `${box.name}: per-box SSH key not found at ${hetznerKeyPath(box.cloud?.sandboxId ?? box.id)} (and not in the control box's custody) — this box was created on another host and can't be controlled from here. Skipping.`,
    );
    return false;
  }
  const provider = await providerForBox(box);
  // Reconnect is an explicit connection-establishment, so a connect failure may
  // be a host IP change that locked the Hetzner firewall — self-heal it (only
  // when the egress actually changed) and retry once.
  const record = await withFirewallRepair(
    provider,
    box,
    { enabled: opts.firewallSync, onLog: (line) => log.success(line) },
    () => provider.reconnect(box),
  );
  log.success(`reconnected ${record.name}`);
  // Bring back exactly the box's last agent: resume its session if there's one
  // to resume, else start it fresh (adopted box / cleared pointer; the only
  // path for OpenCode). When `lastAgent` is unknown (a box created before the
  // field existed), fall back to resuming whatever was actually running.
  // Read-time normalization keeps a legacy/forked record that stored the wire
  // spelling `'claude-code'` resolving to the canonical `'claude'` here.
  const lastAgent = normalizeLastAgent(record.lastAgent);
  await restoreAgentSessions(record, provider, {
    restoreOnly: lastAgent,
    onLog: (line) => log.info(line),
  });
  if (opts.attach) {
    const result = await attachToRunningAgent(record, {});
    if (result === 'none') {
      log.warn(
        `${record.name} reconnected but no agent session came up${lastAgent ? ` (last agent: ${lastAgent})` : ''}. Start one with: agentbox ${lastAgent ?? 'claude'} ${record.name}`,
      );
    }
  }
  return true;
}

/**
 * Adopt a box that's missing from local state: pick a live sandbox (by ref, or
 * prompt), rebuild a minimal `BoxRecord` with freshly-minted relay/bridge
 * tokens, persist it, and return it for recovery. Cloud-only.
 */
async function adoptUnknownBox(
  provider: string,
  ref: string | undefined,
): Promise<BoxRecord | null> {
  const backend = (await cloudBackendForProvider(provider)) as CloudBackend | null;
  if (!backend) {
    log.error(`--adopt is cloud-only; '${provider}' has no remote sandbox list`);
    process.exit(2);
  }
  if (!backend.list) {
    log.error(`${provider} backend doesn't expose list(); cannot enumerate sandboxes to adopt`);
    process.exit(2);
  }
  const [remote, state] = await Promise.all([backend.list(), readState()]);
  const knownIds = new Set<string>();
  for (const b of state.boxes) {
    if ((b.provider ?? 'docker') === provider && b.cloud?.sandboxId)
      knownIds.add(b.cloud.sandboxId);
  }
  // Ours = labelled by us (a friendly name mirrors the `agentbox.name` tag) and
  // not already tracked locally. Don't touch sandboxes from other tooling.
  const candidates: CloudSandboxSummary[] = remote.filter(
    (sb) => !knownIds.has(sb.sandboxId) && (sb.name ?? '').length > 0,
  );
  if (candidates.length === 0) {
    log.info(`no un-tracked ${provider} sandboxes to adopt`);
    return null;
  }
  let chosen: CloudSandboxSummary | undefined;
  if (ref) {
    chosen = candidates.find((sb) => sb.sandboxId === ref || sb.name === ref);
    if (!chosen) {
      log.error(`no adoptable ${provider} sandbox matches '${ref}'`);
      process.exit(1);
    }
  } else if (candidates.length === 1) {
    chosen = candidates[0];
  } else {
    const picked = await select<CloudSandboxSummary>({
      message: `Which ${provider} sandbox to adopt?`,
      options: candidates.map((sb) => ({
        value: sb,
        label: sb.name ?? sb.sandboxId,
        hint: [sb.sandboxId, sb.state, sb.createdAt].filter(Boolean).join('  '),
      })),
    });
    if (isCancel(picked)) {
      log.info('cancelled');
      return null;
    }
    chosen = picked;
  }
  const sb = chosen;
  if (!sb) return null;
  // Rebuild a minimal record. Tokens are regenerated (and re-injected into the
  // box automatically when reconnect relaunches the ctl daemon, which writes
  // /run/agentbox/relay.env). Host-side project linkage (projectRoot/index,
  // worktree host-repo paths) can't be reconstructed from the box — warn.
  const record: BoxRecord = {
    id: generateBoxId(),
    name: sb.name ?? sb.sandboxId,
    provider,
    container: `cloud:${sb.sandboxId}`,
    image: '',
    workspacePath: '/workspace',
    relayToken: generateRelayToken(),
    createdAt: sb.createdAt ?? new Date().toISOString(),
    cloud: {
      backend: provider,
      sandboxId: sb.sandboxId,
      bridgeToken: generateRelayToken(),
      webPort: backend.webProxyPort,
    },
  };
  if ((await hetznerKeyMissing(record)) && !(await tryPullKeyFromCustody(record))) {
    log.error(
      `cannot adopt ${record.name}: per-box SSH key not found at ${hetznerKeyPath(sb.sandboxId)}, and no copy is in the control box's custody — a Hetzner box can only be controlled from a host that has its private key.`,
    );
    process.exit(1);
  }
  const branch = await readBoxBranch(record);
  if (branch) {
    // Best-effort: only the box-visible branch + path are knowable from the
    // box. Host-repo paths can't be reconstructed (warned below).
    record.gitWorktrees = [
      {
        kind: 'root',
        branch,
        containerPath: '/workspace',
        hostMainRepo: '',
        gitWorktreePath: '',
        relPathFromWorkspace: '',
      },
    ];
  }
  await recordBox(record);
  log.success(`adopted ${record.name} (${provider} sandbox ${sb.sandboxId})`);
  log.warn(
    'host-side project linkage (project index, git worktree host paths) could not be reconstructed from the box.',
  );
  return record;
}

export const recoverCommand = new Command('recover')
  .description(
    'Reconnect to an already-running box without power-cycling it: ensure the relay is up, re-open the host transport (Hetzner SSH tunnel) + portless aliases, re-register with the relay, relaunch the agent it was running, and attach. With --all, recover every box in state. With --provider <p> --adopt [ref], first rebuild local state for a box created elsewhere.',
  )
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project). With --adopt: the sandbox id or name to adopt.',
  )
  .option('--all', 'recover every box in local state (skips attach)')
  .option('--no-attach', 'restore only; do not attach to the agent')
  .option(
    '--no-firewall-sync',
    "don't auto-sync a Hetzner box's firewall to your current egress IP on a connect failure",
  )
  .option('--provider <name>', 'cloud provider for --adopt (daytona|hetzner|vercel|e2b)')
  .option('--adopt', 'rebuild local state from a live sandbox that is missing from this host')
  .action(async function (this: Command, idOrName: string | undefined) {
    const opts = this.optsWithGlobals() as RecoverOpts;
    try {
      // The relay may have died with the host session — bring it back and
      // re-push every persisted box (restarts the cloud pollers) before
      // reconnecting individual boxes.
      await ensureRelay();
      await rehydrateFromState();

      if (opts.adopt) {
        const provider = opts.provider;
        if (!provider || !isKnownProvider(provider) || provider === 'docker') {
          log.error('--adopt requires --provider <daytona|hetzner|vercel|e2b>');
          process.exit(2);
        }
        const adopted = await adoptUnknownBox(provider, idOrName);
        if (!adopted) return;
        await recoverKnownBox(adopted, {
          attach: opts.attach !== false,
          firewallSync: opts.firewallSync !== false,
        });
        return;
      }

      if (opts.all) {
        const state = await readState();
        if (state.boxes.length === 0) {
          log.info('no boxes in local state to recover');
          return;
        }
        let ok = 0;
        for (const box of state.boxes) {
          try {
            if (
              await recoverKnownBox(box, {
                attach: false,
                firewallSync: opts.firewallSync !== false,
              })
            )
              ok++;
          } catch (err) {
            log.warn(
              `${box.name}: recover failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        log.success(`recovered ${String(ok)}/${String(state.boxes.length)} box(es)`);
        return;
      }

      const box = await resolveBoxOrExit(idOrName);
      await recoverKnownBox(box, {
        attach: opts.attach !== false,
        firewallSync: opts.firewallSync !== false,
      });
    } catch (err) {
      handleLifecycleError(err);
    }
  });
