/**
 * `agentbox prepare` — provider-neutral "build the base image" command.
 *
 * Three modes:
 *
 *   - `agentbox prepare`               → status only: show the inventory of
 *                                        prepared base images / shared
 *                                        volumes across all providers, plus
 *                                        the project's pinned `box.image`.
 *   - `agentbox prepare --provider X`  → run prepare for X, then re-print
 *                                        the relevant status section.
 *   - `agentbox prepare --status`      → status only (explicit; same as
 *                                        no-args, but useful when scripted).
 *
 * Docker `prepare` builds `agentbox/box:dev` locally. Daytona `prepare`
 * builds a layered `Image` (Dockerfile.box + the three agent static tarballs)
 * and registers it via `daytona.snapshot.create({ name, image })`, then pins
 * `box.image: <name>` into the project config.
 *
 * Replaces the old `agentbox daytona publish-snapshot` (which used the
 * broken `_experimental_createSnapshot` API).
 */

import { intro, log, spinner } from '@clack/prompts';
import { loadEffectiveConfig, setConfigValue } from '@agentbox/config';
import {
  DEFAULT_BOX_IMAGE,
  SHARED_CLAUDE_VOLUME,
  SHARED_CODEX_VOLUME,
  SHARED_OPENCODE_VOLUME,
  imageInfo,
  volumeExists,
  type ImageInfo,
} from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { getProvider, isKnownProvider } from '../provider/registry.js';

interface PrepareOptions {
  provider?: string;
  name?: string;
  force?: boolean;
  yes?: boolean;
  status?: boolean;
}

interface DockerStatus {
  daemon: 'reachable' | 'unreachable';
  image?: ImageInfo;
  volumes: Array<{ name: string; exists: boolean }>;
}

async function dockerStatus(): Promise<DockerStatus> {
  let img: ImageInfo;
  try {
    img = await imageInfo(DEFAULT_BOX_IMAGE);
  } catch {
    return { daemon: 'unreachable', volumes: [] };
  }
  const names = [SHARED_CLAUDE_VOLUME, SHARED_CODEX_VOLUME, SHARED_OPENCODE_VOLUME];
  const volumes = await Promise.all(
    names.map(async (name) => ({ name, exists: await volumeExists(name).catch(() => false) })),
  );
  return { daemon: 'reachable', image: img, volumes };
}

function humanBytes(n?: number): string {
  if (n === undefined || !Number.isFinite(n)) return '—';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${String(n)} B`;
}

function humanAge(iso?: string): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const ageSec = Math.max(0, (Date.now() - t) / 1000);
  if (ageSec < 60) return `${ageSec.toFixed(0)}s ago`;
  if (ageSec < 3600) return `${(ageSec / 60).toFixed(0)}m ago`;
  if (ageSec < 86400) return `${(ageSec / 3600).toFixed(1)}h ago`;
  return `${(ageSec / 86400).toFixed(1)}d ago`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

async function renderDocker(status: DockerStatus): Promise<string[]> {
  const out: string[] = ['docker:'];
  if (status.daemon === 'unreachable') {
    out.push('  docker daemon unreachable (is Docker running?)');
    return out;
  }
  if (!status.image?.exists) {
    out.push(`  image  ${DEFAULT_BOX_IMAGE}  (not built — run \`agentbox prepare --provider docker\`)`);
  } else {
    out.push(
      `  image  ${pad(DEFAULT_BOX_IMAGE, 30)} ${pad(humanBytes(status.image.sizeBytes), 10)} built ${humanAge(status.image.createdAt)}`,
    );
  }
  for (const v of status.volumes) {
    if (v.exists) {
      out.push(`  vol    ${pad(v.name, 30)} present`);
    } else {
      out.push(`  vol    ${pad(v.name, 30)} (none — seeded lazily on first \`agentbox claude/codex/opencode\`)`);
    }
  }
  return out;
}

interface DaytonaStatusUnknown {
  configured: false;
  reason?: string;
}
interface DaytonaStatusOk {
  configured: true;
  snapshots: Array<{ name: string; state?: string; sizeGb?: number; createdAt?: string; errorReason?: string }>;
  volumes: Array<{ name: string; state?: string; lastUsedAt?: string }>;
  reason?: string;
}
type DaytonaStatusResult = DaytonaStatusUnknown | DaytonaStatusOk;

async function daytonaStatus(): Promise<DaytonaStatusResult> {
  try {
    const mod = await import('@agentbox/sandbox-daytona');
    return (await mod.getDaytonaStatus()) as DaytonaStatusResult;
  } catch (err) {
    return { configured: false, reason: err instanceof Error ? err.message.split('\n')[0] : String(err) };
  }
}

function renderDaytona(status: DaytonaStatusResult, pinnedImage?: string): string[] {
  const out: string[] = ['daytona:'];
  if (!status.configured) {
    out.push(
      `  (not configured — \`agentbox daytona login\` to set up${status.reason ? `; ${status.reason}` : ''})`,
    );
    return out;
  }
  if (status.reason) out.push(`  warn: ${status.reason}`);
  if (status.snapshots.length === 0) {
    out.push('  no agentbox snapshots — run `agentbox prepare --provider daytona`');
  } else {
    for (const s of status.snapshots) {
      const sizeStr = s.sizeGb !== undefined ? `${s.sizeGb.toFixed(2)} GB` : '—';
      const pinned = pinnedImage && pinnedImage === s.name ? '  (pinned in project)' : '';
      const tail =
        s.state === 'error' && s.errorReason
          ? `  error: ${s.errorReason.slice(0, 80)}`
          : `  ${humanAge(s.createdAt)}`;
      out.push(
        `  snap   ${pad(s.name, 40)} ${pad(s.state ?? '—', 10)} ${pad(sizeStr, 10)}${tail}${pinned}`,
      );
    }
  }
  if (status.volumes.length === 0) {
    out.push('  no agentbox volumes — created lazily on first cloud `agentbox create`');
  } else {
    for (const v of status.volumes) {
      const last = v.lastUsedAt ? `  last used ${humanAge(v.lastUsedAt)}` : '';
      out.push(`  vol    ${pad(v.name, 40)} ${pad(v.state ?? '—', 10)}${last}`);
    }
  }
  return out;
}

async function showStatus(opts: { onlyProvider?: string }): Promise<void> {
  const cfg = await loadEffectiveConfig(process.cwd()).catch(() => null);
  const pinnedRaw = cfg?.effective.box.image;
  // Only treat as "user-pinned" if it differs from the docker default tag
  // — that one is just the fallback ref the docker provider builds locally.
  const pinned =
    typeof pinnedRaw === 'string' && pinnedRaw.length > 0 && pinnedRaw !== DEFAULT_BOX_IMAGE
      ? pinnedRaw
      : undefined;
  const lines: string[] = [];

  const wantDocker = !opts.onlyProvider || opts.onlyProvider === 'docker';
  const wantDaytona = !opts.onlyProvider || opts.onlyProvider === 'daytona';

  if (wantDocker) {
    const status = await dockerStatus();
    lines.push(...(await renderDocker(status)));
  }
  if (wantDaytona) {
    if (lines.length > 0) lines.push('');
    const status = await daytonaStatus();
    lines.push(...renderDaytona(status, pinned));
  }
  if (pinned) {
    lines.push('');
    lines.push(`project pin:  box.image = ${pinned}`);
  }
  process.stdout.write(lines.join('\n') + '\n');
}

export const prepareCommand = new Command('prepare')
  .description(
    'Build base sandbox images / snapshots, or show what is already prepared across providers.',
  )
  .option(
    '-p, --provider <name>',
    'provider to prepare (docker | daytona | hetzner | vercel). Omit for status-only.',
  )
  .option(
    '-n, --name <name>',
    'snapshot name (Daytona only; default: agentbox-base-<timestamp>)',
  )
  .option('-f, --force', 'rebuild even if the image / snapshot already exists')
  .option('-y, --yes', 'skip confirmation prompts (cost / time warnings)')
  .option('--status', 'show status without preparing anything')
  .action(async (opts: PrepareOptions) => {
    // Status-only path: no provider, or explicit --status.
    if (!opts.provider || opts.status) {
      await showStatus({});
      return;
    }

    const providerName = opts.provider.trim();
    if (!isKnownProvider(providerName)) {
      process.stderr.write(
        `error: --provider must be one of: docker, daytona, hetzner\n`,
      );
      process.exit(1);
    }

    intro(`preparing ${providerName} base image`);
    if (providerName === 'daytona' && !opts.yes && process.stdin.isTTY) {
      process.stdout.write(
        'This will trigger a Daytona image build (~7 min cold, ~seconds with cache) and ' +
          'register a named snapshot in your org.\n' +
          'Re-run with --yes to skip this notice.\n',
      );
    }

    const provider = await getProvider(providerName);
    if (typeof provider.prepare !== 'function') {
      log.error(`provider '${providerName}' does not implement prepare`);
      process.exit(1);
    }

    const sp = spinner();
    sp.start(`preparing ${providerName}…`);
    try {
      const result = await provider.prepare({
        name: opts.name,
        hostWorkspace: process.cwd(),
        force: opts.force,
        onLog: (line) => sp.message(line.slice(0, 80)),
      });
      if (result.snapshotName !== undefined) {
        sp.stop(`prepared ${providerName}: snapshot '${result.snapshotName}'`);
        try {
          const written = await setConfigValue(
            'project',
            'box.image',
            result.snapshotName,
            process.cwd(),
          );
          log.success(`box.image = ${result.snapshotName} (written to ${written.path})`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(
            `prepared snapshot '${result.snapshotName}', but failed to pin it into the project config: ${msg}\n` +
              `Run \`agentbox config set --project box.image ${result.snapshotName}\` manually.`,
          );
        }
      } else {
        sp.stop(`prepared ${providerName}`);
      }

      // Show the relevant status section after a successful prepare.
      process.stdout.write('\n');
      await showStatus({ onlyProvider: providerName });
      log.info(
        'tip: install the agentbox host skill so Claude Code on this machine can drive AgentBox for you:\n' +
          '  npx skills add https://github.com/madarco/agentbox --skill agentbox',
      );
    } catch (err) {
      sp.stop(`prepare failed: ${describeError(err)}`);
      process.exit(1);
    }
  });

/**
 * Unwrap the cause chain on Error objects so opaque wrappers like Node's
 * `TypeError: fetch failed` (whose `.message` carries zero context but
 * whose `.cause` is e.g. `{ code: 'ECONNREFUSED', address, port }`)
 * surface the real reason in the CLI's one-line failure message.
 */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts: string[] = [err.message];
  let cause: unknown = (err as Error & { cause?: unknown }).cause;
  // Bound the walk so a cyclic / pathological cause chain can't OOM.
  for (let i = 0; i < 5 && cause; i++) {
    if (cause instanceof Error) {
      parts.push(`caused by: ${cause.message}`);
      const code = (cause as Error & { code?: unknown }).code;
      if (typeof code === 'string') parts.push(`(${code})`);
      cause = (cause as Error & { cause?: unknown }).cause;
    } else if (typeof cause === 'object') {
      parts.push(`caused by: ${JSON.stringify(cause)}`);
      break;
    } else {
      parts.push(`caused by: ${String(cause)}`);
      break;
    }
  }
  return parts.join(' — ');
}
