import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { log, spinner } from '@clack/prompts';
import { loadEffectiveConfig } from '@agentbox/config';
import {
  ensureHub,
  getHubStatus,
  stopHub,
  controlPlaneDeployPath,
  hostOpenCommand,
  type HubStatus,
  type ControlPlaneDeployRecord,
} from '@agentbox/sandbox-core';
import { Command } from 'commander';
import { handleLifecycleError } from './_errors.js';
import { rehydrateFromState } from './relay.js';
import { ensurePortlessProxyQuietly, resolvePortlessEnabled } from '../portless-prompt.js';
import {
  resolveCustodyApiTarget,
  resolveHubApiTarget,
  controlPlaneSubcommands,
  probeControlPlaneStatus,
  localExposedLoopbackUrl,
} from './control-plane.js';
import { restoreTunnelIfExposed, stopTunnelIfExposed } from '../control-plane/expose.js';
import { loadControlPlaneEnv } from '../control-plane/env-file.js';
import { channelOfVersion } from '../lib/channel.js';
import { AGENTBOX_VERSION } from '../version.js';
import { CustodyClient } from '../control-plane/custody-client.js';
import { HubApiClient } from '../control-plane/hub-api-client.js';
import type { HubApiBox } from '../control-plane/hub-api-client.js';
import { pullBoxSshKeys } from '../control-plane/hub-pull.js';
import { adoptHubBox, HubBoxNotFoundError } from '../control-plane/hub-adopt.js';

/**
 * Resolve `portless.enabled` and, when the user has opted in, make sure a proxy
 * is actually up before the hub reports its URL — a proxy does not survive a
 * reboot, so "the hub is on agentbox.localhost" was regularly a lie. Only
 * `true` starts one: an unset preference still registers the alias (that costs
 * nothing) but must not spawn a daemon nobody asked for.
 */
async function resolvePortlessForHub(): Promise<boolean | undefined> {
  const enabled = await resolvePortlessEnabled();
  if (enabled === true) await ensurePortlessProxyQuietly();
  return enabled;
}

/** Best-effort: open the hub URL in the host browser (never throws). */
function openInBrowser(url: string): void {
  try {
    const child = spawn(hostOpenCommand(), [url], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    /* the caller has already printed the URL */
  }
}

/**
 * The client-facing hub the CLI + tray talk to. `mode` is `remote` when a control
 * box is configured, else `local`. `token` is the single Bearer that authorizes
 * both `/api/v1` and the `/api/events` SSE stream (the local hub token, or
 * `AGENTBOX_HUB_API_KEY` for the remote control box).
 */
export interface HubTarget {
  mode: 'local' | 'remote';
  url: string;
  token: string;
}

/**
 * Resolve the hub the CLI should talk to: the remote control box when one is
 * configured (`--url` > `relay.controlPlaneUrl`, with `AGENTBOX_HUB_API_KEY`),
 * else the local hub (`127.0.0.1:<port>` + `~/.agentbox/hub/token`). Surfaced to
 * the macOS tray via `agentbox hub target --json` so it follows the same config
 * (it can't parse the layered config itself). One Bearer authorizes both surfaces
 * in either mode (see `apps/hub/proxy.ts`).
 *
 * `preferLocal` prefers the hub on THIS machine even when a remote control box is
 * configured — the "which hub" knob for callers that have decided an operation
 * belongs here (e.g. a `cloud.viaHub=false` bake, or a base whose artifact lands
 * here). It skips only the configured REMOTE control-plane URL; it does NOT skip
 * the loopback branch, because a `hub expose`-d machine's hub IS on this machine
 * yet runs the password profile (its `/api/v1` wants `AGENTBOX_HUB_API_KEY` over
 * loopback, not the plain `~/.agentbox/hub/token`). Same precedence ladder as the
 * default, minus the remote URL — never a second resolver that could disagree.
 */
export async function resolveHubTarget(
  urlFlag?: string,
  opts: { preferLocal?: boolean } = {},
): Promise<HubTarget> {
  const cfg = await loadEffectiveConfig(process.cwd());
  const url = (urlFlag ?? cfg.effective.relay.controlPlaneUrl ?? '').replace(/\/$/, '');
  // A control box that IS this machine (`hub expose`) is reached over loopback,
  // not the box-facing LAN/tunnel URL — but it's still the `remote`-shaped API
  // (password profile, /api/v1 keyed by AGENTBOX_HUB_API_KEY). This is ALSO the
  // `preferLocal` answer for an exposed machine: the hub is right here, so the
  // plain local-hub token below would 401 against its password profile.
  //
  // Checked BEFORE the configured URL is required, because the two can disagree:
  // `hub unset-url` clears the config but leaves the exposed record, and the hub
  // keeps running the password profile. Falling through to local mode then
  // handed out the localhost token — which that hub does not accept — so
  // `hub target`, and the tray that follows it, pointed at the wrong credential.
  const loopback = urlFlag ? null : await localExposedLoopbackUrl();
  if (loopback) {
    loadControlPlaneEnv();
    return { mode: 'remote', url: loopback, token: process.env.AGENTBOX_HUB_API_KEY ?? '' };
  }
  // The configured REMOTE control box — skipped under preferLocal so the caller
  // gets this machine's plain local hub instead (the not-exposed local case).
  if (url && !opts.preferLocal) {
    loadControlPlaneEnv();
    return { mode: 'remote', url, token: process.env.AGENTBOX_HUB_API_KEY ?? '' };
  }
  const s = await getHubStatus();
  return { mode: 'local', url: `http://127.0.0.1:${String(s.port)}`, token: s.token ?? '' };
}

interface StatusOpts {
  url?: string;
  json?: boolean;
}

function renderStatus(s: HubStatus, exposed?: ControlPlaneDeployRecord | null): string {
  // The exposed CONFIG is a property of the machine, not of the running process,
  // so it is reported whether or not the hub is up. Reporting it only while
  // running made a stopped control box look like a plain local hub — with
  // autostart still installed and boxes still pointed at it.
  const exposedLines = exposed
    ? [
        ...(exposed.publicUrl ? [`  box-facing url: ${exposed.publicUrl}`] : []),
        ...(exposed.tunnel ? [`  tunnel: ${exposed.tunnel}`] : []),
        ...(exposed.autostart ? ['  autostart: on'] : []),
      ]
    : [];
  if (s.running) {
    // `mode` describes the PROCESS, so it stays keyed on the live profile: a hub
    // running plain on a machine that is configured exposed is exactly the
    // mismatch worth seeing.
    const mode =
      s.profile === 'hetzner'
        ? [`  mode: exposed (control box${s.worker ? ', worker on' : ''})`]
        : exposed
          ? ['  mode: NOT exposed yet (configured, but this process is the plain hub)']
          : [];
    return [
      `hub: running${s.ui ? '' : ' (bare relay on the port — no UI; run `agentbox hub start`)'}`,
      `  pid:  ${s.pid === null ? '?' : String(s.pid)}`,
      `  port: ${String(s.port)}`,
      `  url:  ${s.openUrl}`,
      ...mode,
      ...exposedLines,
      `  log:  ${s.logFile}`,
    ].join('\n');
  }
  const stoppedExposed = exposed ? ['  mode: exposed (configured; the hub is not running)'] : [];
  if (s.pidAlive) {
    return [
      `hub: not responding (pid ${String(s.pid)} alive but /healthz silent)`,
      ...stoppedExposed,
      ...exposedLines,
      `  log:  ${s.logFile}`,
    ].join('\n');
  }
  return ['hub: not running', ...stoppedExposed, ...exposedLines, `  log:  ${s.logFile}`].join(
    '\n',
  );
}

/**
 * What `hub deploy` recorded for the control box at `url` — the only trace of
 * which build a remote hub is running (the VPS keeps no version marker, and in
 * package mode not even a git checkout to `rev-parse`). Matched on URL so a
 * `--url` probe of somebody else's hub doesn't get this machine's record.
 * Best-effort: an absent or unreadable record just omits the line.
 */
async function readDeployRecordFor(url: string): Promise<ControlPlaneDeployRecord | null> {
  try {
    const rec = JSON.parse(
      await readFile(controlPlaneDeployPath(), 'utf8'),
    ) as ControlPlaneDeployRecord;
    return rec.url === url ? rec : null;
  } catch {
    return null;
  }
}

/** The deploy record for a control box that IS this machine (`hub expose`), or null. */
async function readLocalDeployRecord(): Promise<ControlPlaneDeployRecord | null> {
  try {
    const rec = JSON.parse(
      await readFile(controlPlaneDeployPath(), 'utf8'),
    ) as ControlPlaneDeployRecord;
    return rec.provider === 'local' ? rec : null;
  } catch {
    return null;
  }
}

export interface RemoteHubBuild {
  /** The version the hub reports, else the version that was deployed. */
  version: string | null;
  /** Where `version` came from — a live probe beats a local record. */
  versionSource: 'live' | 'deployed' | null;
  /** `nightly` / `stable`, or `source (<ref>)` for a build-from-source box. */
  channel: string | null;
  /** The deploy record's build line, e.g. `@madarco/agentbox@0.28.0 (npm)`. */
  build: string | null;
  /** Set when the control box runs a different version than this CLI. */
  drift: string | null;
}

/**
 * Reconcile what the hub reports with what this machine deployed.
 *
 * The live version wins: the record only says what was last *deployed*, which is
 * wrong after a failed update, and is absent entirely for a hub someone else set
 * up. A control box built before the images exported `AGENTBOX_CLI_VERSION`
 * reports nothing, so the record is the fallback rather than the source.
 *
 * Pure so the precedence is unit-testable.
 */
export function describeRemoteHubBuild(input: {
  liveVersion?: string | undefined;
  record: ControlPlaneDeployRecord | null;
  cliVersion: string;
}): RemoteHubBuild {
  const source = input.record?.source ?? null;
  const build = source
    ? source.kind === 'package'
      ? `@madarco/agentbox@${source.spec} (npm)`
      : `${source.repoUrl}@${source.repoRef} (built from source)`
    : null;
  // A spec may be a dist-tag or a range (`--package nightly`), not a version.
  // Treating one as a version would print `version: nightly` and, worse, classify
  // it `stable` — `channelOfVersion` only looks for a `-nightly.` suffix. Until
  // the hub reports what it actually installed, we simply don't know.
  const deployedVersion =
    source?.kind === 'package' && /^\d+\.\d+\.\d+/.test(source.spec) ? source.spec : null;
  const version = input.liveVersion ?? deployedVersion;
  const versionSource = input.liveVersion ? 'live' : deployedVersion ? 'deployed' : null;
  // A source build's "channel" is the ref itself — which is the branch the user
  // actually cares about (`nightly`, `main`, a feature branch).
  const channel =
    source?.kind === 'source'
      ? `source (${source.repoRef})`
      : version
        ? channelOfVersion(version)
        : null;
  // Only meaningful for a version we know is live; a stale record would nag forever.
  const drift =
    input.liveVersion && input.liveVersion !== input.cliVersion
      ? `this CLI is ${input.cliVersion} — run \`agentbox hub update\` to match`
      : null;
  return { version, versionSource, channel, build, drift };
}

const statusSub = new Command('status')
  .description(
    'Show hub status — the remote control box (reachability + box/event counts) when one is configured, else the local hub process',
  )
  .option(
    '--url <url>',
    'probe this control-plane URL as the remote hub (default: relay.controlPlaneUrl)',
  )
  .option('--json', 'emit status as JSON')
  .action(async (opts: StatusOpts) => {
    try {
      // A control box that IS this machine (`hub expose`): show the exposed
      // detail (profile, worker, box-facing URL, tunnel) that a plain remote
      // probe of its loopback can't. Skipped when `--url` targets another hub.
      const localExposed = opts.url ? null : await readLocalDeployRecord();
      if (localExposed) {
        const s = await getHubStatus();
        if (opts.json) {
          process.stdout.write(JSON.stringify({ ...s, exposed: localExposed }, null, 2) + '\n');
          return;
        }
        process.stdout.write(renderStatus(s, localExposed) + '\n');
        return;
      }
      const target = await resolveHubTarget(opts.url);
      // Remote (a control box is configured, or --url given): probe its /healthz.
      if (target.mode === 'remote') {
        const st = await probeControlPlaneStatus(target.url);
        const record = await readDeployRecordFor(st.url);
        const b = describeRemoteHubBuild({
          liveVersion: st.version,
          record,
          cliVersion: AGENTBOX_VERSION,
        });
        if (opts.json) {
          process.stdout.write(
            JSON.stringify({
              ...st,
              ...(b.version ? { version: b.version, versionSource: b.versionSource } : {}),
              ...(b.channel ? { channel: b.channel } : {}),
              ...(b.build ? { deployed: b.build } : {}),
            }) + '\n',
          );
          return;
        }
        process.stdout.write(
          [
            `hub: remote (${st.healthy ? 'reachable' : 'UNREACHABLE'})`,
            `  url:     ${st.url}`,
            `  health:  ${st.detail}`,
            ...(b.version
              ? [`  version: ${b.version}${b.versionSource === 'deployed' ? ' (as deployed)' : ''}`]
              : []),
            ...(b.channel ? [`  channel: ${b.channel}`] : []),
            ...(b.build ? [`  build:   ${b.build}`] : []),
            ...(b.drift ? [`  update:  ${b.drift}`] : []),
          ].join('\n') + '\n',
        );
        return;
      }
      // Local: introspect the hub daemon process on this machine.
      const s = await getHubStatus();
      // When exposed, the deploy record carries the box-facing URL / tunnel /
      // autostart that /healthz doesn't.
      const exposed = s.profile === 'hetzner' ? await readLocalDeployRecord() : null;
      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ ...s, ...(exposed ? { exposed } : {}) }, null, 2) + '\n',
        );
        return;
      }
      process.stdout.write(renderStatus(s, exposed) + '\n');
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const targetSub = new Command('target')
  .description(
    'Print the hub the CLI talks to — the remote control box when configured, else the local hub — with its API token. The seam the macOS tray follows to point at the same hub.',
  )
  .option('--url <url>', 'override the control-plane URL (default: relay.controlPlaneUrl)')
  .option('--json', 'emit { mode, url, token } as JSON (consumed by the tray)')
  .action(async (opts: { url?: string; json?: boolean }) => {
    try {
      const t = await resolveHubTarget(opts.url);
      if (opts.json) {
        process.stdout.write(JSON.stringify(t) + '\n');
        return;
      }
      const tokenNote = t.token
        ? 'present'
        : t.mode === 'remote'
          ? '(none — set AGENTBOX_HUB_API_KEY, or run `agentbox hub setup`)'
          : '(none — start the hub with `agentbox hub`)';
      process.stdout.write(
        [`hub: ${t.mode}`, `  url:   ${t.url}`, `  token: ${tokenNote}`].join('\n') + '\n',
      );
    } catch (err) {
      handleLifecycleError(err);
    }
  });

interface StartOpts {
  open?: boolean;
}

const startSub = new Command('start')
  .description('Start the hub (relay + Web UI on port 8787) and open it')
  .option('--no-open', "don't open the browser, just print the URL")
  .action(async (opts: StartOpts) => {
    try {
      const s = spinner();
      s.start('starting hub');
      // If this machine is an exposed control box with a tunnel, (re)establish it
      // first so the hub boots knowing its public URL (autostart path).
      await restoreTunnelIfExposed((line) => s.message(line));
      const ep = await ensureHub({
        onLog: (line) => s.message(line),
        portlessEnabled: await resolvePortlessForHub(),
      });
      await rehydrateFromState();
      s.stop(`hub running on ${ep.hostUrl}`);
      process.stdout.write(`\n  Open: ${ep.openUrl}\n\n`);
      if (opts.open !== false) openInBrowser(ep.openUrl);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const stopSub = new Command('stop')
  .description('Stop the hub process (idempotent)')
  .action(async () => {
    try {
      const s = spinner();
      s.start('stopping hub');
      const result = await stopHub();
      // A tunnel outliving the hub serves nothing and, worse, the next
      // `hub start` would spawn a second one over it. Idempotent + no-op when
      // this machine isn't exposed.
      await stopTunnelIfExposed((line) => s.message(line));
      s.stop(result.stopped ? `stopped hub (pid ${String(result.pid)})` : 'hub was not running');
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const restartSub = new Command('restart')
  .description('Stop then start the hub')
  .option('--no-open', "don't open the browser, just print the URL")
  .action(async (opts: StartOpts) => {
    try {
      const s = spinner();
      s.start('stopping hub');
      const stopped = await stopHub();
      s.stop(stopped.stopped ? `stopped hub (pid ${String(stopped.pid)})` : 'hub was not running');
      const s2 = spinner();
      s2.start('starting hub');
      try {
        await restoreTunnelIfExposed((line) => s2.message(line));
        const ep = await ensureHub({
          onLog: (line) => s2.message(line),
          portlessEnabled: await resolvePortlessForHub(),
        });
        await rehydrateFromState();
        s2.stop(`hub running on ${ep.hostUrl}`);
        process.stdout.write(`\n  Open: ${ep.openUrl}\n\n`);
        if (opts.open !== false) openInBrowser(ep.openUrl);
      } catch (err) {
        s2.stop('hub start failed');
        log.warn(err instanceof Error ? err.message : String(err));
        throw err;
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });

/**
 * Resolve a box ref through the hub's `/api/v1` (server-side `findBox`) for the
 * `hub pull` / `hub adopt` commands. Returns the unique match + the hub API URL
 * (persisted on the adopted record), or null after printing an actionable error
 * — an ambiguous prefix lists the candidates, a total miss throws
 * {@link HubBoxNotFoundError} for the caller's catch to render.
 */
async function resolveHubBox(
  ref: string,
  urlFlag: string | undefined,
): Promise<{ box: HubApiBox; url: string } | null> {
  const target = await resolveHubApiTarget(urlFlag);
  if (!target) {
    process.exitCode = 1;
    return null;
  }
  const matches = await new HubApiClient(target).resolveBox(ref);
  if (matches.length === 0) throw new HubBoxNotFoundError(ref);
  if (matches.length > 1) {
    log.error(`'${ref}' matches multiple boxes on the control box — pick one:`);
    for (const b of matches) process.stderr.write(`  ${b.name ?? b.id}   (id ${b.id})\n`);
    log.info('retry with a longer id prefix, the full name, or the sandbox id');
    process.exitCode = 1;
    return null;
  }
  return { box: matches[0]!, url: target.url };
}

const pullSub = new Command('pull')
  .description(
    "Download a control-box-created box's SSH keys so this PC can attach / port-forward / cp to it",
  )
  .argument('<box>', 'box id or name as shown by `agentbox hub boxes list`')
  .option('--url <url>', 'override the control-plane URL (default: relay.controlPlaneUrl)')
  .action(async (box: string, opts: { url?: string }) => {
    try {
      const resolved = await resolveHubBox(box, opts.url);
      if (!resolved) return;
      // SSH keys live in custody, over the hub's /api/v1: the byte-read needs the
      // admin token (elevated), so this only works from a machine that ran
      // `hub setup`/`expose`. remoteOnly — a control-box box has no keys on a
      // plain local hub.
      const custodyTarget = await resolveCustodyApiTarget(opts.url, { remoteOnly: true });
      if (!custodyTarget) {
        process.exitCode = 1;
        return;
      }
      const res = await pullBoxSshKeys({
        custody: new CustodyClient(custodyTarget),
        box: resolved.box,
      });
      if (res.files.length === 0) {
        log.warn(
          `No SSH key material in custody for '${box}' (boxes/${res.key}/ssh). ` +
            'The box may mint no keypair (e2b/vercel).',
        );
        process.exitCode = 1;
        return;
      }
      log.success(
        `Pulled ${String(res.files.length)} key file(s) to ${res.dest} — attach / cp / port-forward now work.`,
      );
    } catch (err) {
      if (err instanceof HubBoxNotFoundError) {
        log.error(`${err.message}. Run \`agentbox hub boxes list\` to see what's there.`);
        process.exitCode = 1;
        return;
      }
      handleLifecycleError(err);
    }
  });

const adoptSub = new Command('adopt')
  .description(
    'Rebuild local state for a control-box-created box so it resolves by name here: writes its BoxRecord and downloads its SSH keys. After this it shows in `agentbox ls` and works with attach / cp / url / screen.',
  )
  .argument('<box>', 'box id, name, or sandbox id as shown by `agentbox hub boxes list`')
  .option('--url <url>', 'override the control-plane URL (default: relay.controlPlaneUrl)')
  .action(async (box: string, opts: { url?: string }) => {
    try {
      const resolved = await resolveHubBox(box, opts.url);
      if (!resolved) return;
      // SSH keys come from custody over /api/v1 (best-effort): a thin client with
      // no admin token adopts the record and warns for SSH providers (the byte-read
      // is refused). remoteOnly — adoption is a control-box concern.
      const custodyTarget = await resolveCustodyApiTarget(opts.url, {
        quiet: true,
        remoteOnly: true,
      });
      const custody = custodyTarget ? new CustodyClient(custodyTarget) : undefined;
      const res = await adoptHubBox({
        box: resolved.box,
        custody,
        controlPlaneUrl: resolved.url,
        log: (line) => log.info(line),
      });
      const where = res.projectRoot
        ? `linked to ${res.projectRoot}`
        : 'no local clone of its repo — it shows under `agentbox ls -g` only';
      log.success(
        `${res.refreshed ? 'Refreshed' : 'Adopted'} ${res.record.name} (${res.record.provider} ${res.record.cloud?.sandboxId ?? ''}) — ${where}.`,
      );
      if (res.sshKeysMissing) {
        log.warn(
          `But the control box has no SSH key for it, so attach / cp / port-forward won't work yet. ` +
            `The key is uploaded by the host that created the box — check that it ran with a control box configured.`,
        );
      }
    } catch (err) {
      if (err instanceof HubBoxNotFoundError) {
        log.error(`${err.message}. Run \`agentbox hub boxes list\` to see what's there.`);
        process.exitCode = 1;
        return;
      }
      handleLifecycleError(err);
    }
  });

export const hubCommand = new Command('hub')
  .description(
    'Run + manage the AgentBox hub — the local relay + Web UI on http://127.0.0.1:8787 ' +
      '(also https://agentbox.localhost when Portless is installed), and the remote control box ' +
      '(setup, deploy, boxes, approvals, credentials, custody)',
  )
  .addCommand(startSub, { isDefault: true })
  .addCommand(statusSub)
  .addCommand(targetSub)
  .addCommand(stopSub)
  .addCommand(restartSub)
  .addCommand(pullSub)
  .addCommand(adoptSub);

// Fold the remote-hub admin subcommands (setup/deploy/set-url/add/worker/
// credentials/secrets/project/custody/boxes/approvals) into the one `hub` group —
// there is no separate `control-plane` command. All surfaced (not hidden).
for (const sub of controlPlaneSubcommands) hubCommand.addCommand(sub);
