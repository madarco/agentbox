import { log, spinner } from '@clack/prompts';
import {
  agentSpecsForCloud,
  ensureAgentVolumesForCloud,
  seedAgentVolumesIfFresh,
  type CloudAgentKind,
} from '@agentbox/sandbox-cloud';
import { Command } from 'commander';
import { daytonaBackend } from './backend.js';
import {
  ensureDaytonaCredentials,
  maskKey,
  readDaytonaCredStatus,
  secretsPath,
} from './credentials.js';
import { readPreparedDaytonaState } from './prepared-state.js';

interface LoginOpts {
  status?: boolean;
}

function reportError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  log.error(message);
  process.exitCode = 1;
}

const loginSub = new Command('login')
  .description('Set up (or rotate) Daytona credentials for cloud boxes')
  .option('--status', 'show what is currently configured (masked) and exit')
  .action(async (opts: LoginOpts) => {
    try {
      if (opts.status) {
        printStatus();
        return;
      }
      if (!process.stdin.isTTY) {
        process.stderr.write(
          'daytona login needs an interactive terminal — set DAYTONA_API_KEY in the environment for non-interactive use.\n',
        );
        process.exitCode = 1;
        return;
      }
      await ensureDaytonaCredentials({ force: true });
      // Credentials alone don't get a user a working box — they also need a
      // baked base snapshot. Nudge toward `prepare` so the login → first-create
      // path doesn't hit the (otherwise-clean) "no Daytona base snapshot"
      // error. No layering break.
      if (readPreparedDaytonaState()?.base === undefined) {
        log.info(
          'Base snapshot not built yet — run `agentbox prepare --provider daytona` (or `agentbox install`) to bake it.',
        );
      }
    } catch (err) {
      reportError(err);
    }
  });

function printStatus(): void {
  const s = readDaytonaCredStatus();
  if (s.source === 'none') {
    process.stdout.write(
      'daytona: not configured\n' +
        '  run `agentbox daytona login` to set up credentials\n',
    );
    return;
  }
  const lines = ['daytona: configured', `  source: ${s.source}`];
  if (s.source === 'secrets.env') lines.push(`  file:   ${secretsPath()}`);
  if (s.apiKey) lines.push(`  apiKey: ${maskKey(s.apiKey)}`);
  if (s.jwtToken) lines.push(`  jwt:    ${maskKey(s.jwtToken)}`);
  if (s.organizationId) lines.push(`  orgId:  ${s.organizationId}`);
  process.stdout.write(lines.join('\n') + '\n');
}

interface ResyncOpts {
  agent?: string;
}

const KNOWN_AGENTS: readonly CloudAgentKind[] = ['claude', 'codex', 'opencode'];

/**
 * Parse `--agent` into the list of agents to refresh. Defaults to all three;
 * accepts a single name or 'all'. Throws on unknown agent name so a typo
 * surfaces immediately instead of silently resyncing nothing.
 */
function resolveAgentSelection(raw: string | undefined): CloudAgentKind[] {
  if (!raw || raw === 'all') return [...KNOWN_AGENTS];
  if (!(KNOWN_AGENTS as readonly string[]).includes(raw)) {
    throw new Error(
      `unknown agent '${raw}'. Expected one of: ${KNOWN_AGENTS.join(', ')}, all.`,
    );
  }
  return [raw as CloudAgentKind];
}

const resyncSub = new Command('resync')
  .description(
    'Re-upload host agent credentials (~/.claude, ~/.codex, opencode) into the shared Daytona volumes.',
  )
  .option(
    '-a, --agent <name>',
    'which agent to refresh: claude | codex | opencode | all',
    'all',
  )
  .action(async (opts: ResyncOpts) => {
    try {
      const agents = resolveAgentSelection(opts.agent);
      const specs = agentSpecsForCloud().filter((s) => agents.includes(s.kind));

      // Spin up a single throwaway sandbox with all selected volumes mounted.
      // One sandbox amortizes the snapshot/start cost across multiple agents;
      // seedAgentVolumesIfFresh with force:true overwrites each one in turn.
      // Image: the same default `agentbox/box:dev` used for normal cloud
      // boxes. Daytona's snapshot cache should hit if the user has provisioned
      // a real box recently. Resources are minimal — we only need tar + chown.
      const sb = spinner();
      sb.start(`provisioning throwaway sandbox to refresh: ${agents.join(', ')}`);

      const ensured = await ensureAgentVolumesForCloud(daytonaBackend, {
        onLog: (line) => log.info(line),
      });
      if (ensured.agents.length === 0) {
        sb.stop('no agent volumes available — the daytona backend has no volume primitive');
        return;
      }
      // Restrict to only what the user asked for.
      const mounts = ensured.mounts.filter((m) =>
        specs.some((s) => s.credentialsMountPath === m.mountPath),
      );

      const handle = await daytonaBackend.provision({
        name: `agentbox-resync-${Date.now().toString(36)}`,
        image: 'agentbox/box:dev',
        resources: { cpu: 1, memory: 1, disk: 4 },
        env: {},
        volumes: mounts,
        onLog: (line) => sb.message(line.slice(0, 80)),
      });
      sb.stop(`throwaway sandbox ${handle.sandboxId} provisioned`);

      try {
        const sb2 = spinner();
        sb2.start('re-seeding host credentials into volumes (force)');
        await seedAgentVolumesIfFresh(daytonaBackend, handle, {
          agents,
          force: true,
          onLog: (line) => sb2.message(line.slice(0, 80)),
        });
        sb2.stop('credentials refreshed');
      } finally {
        const sb3 = spinner();
        sb3.start('destroying throwaway sandbox');
        try {
          await daytonaBackend.destroy(handle);
        } catch (err) {
          sb3.stop(
            `destroy failed (sandbox may linger): ${err instanceof Error ? err.message : String(err)}`,
          );
          return;
        }
        sb3.stop('throwaway sandbox destroyed');
      }

      log.success(
        `Daytona agent volumes refreshed: ${agents.join(', ')}. ` +
          `Next \`agentbox create --provider daytona\` will use the updated credentials.`,
      );
    } catch (err) {
      reportError(err);
    }
  });

// NB: the old `agentbox daytona publish-snapshot` subcommand has been removed.
// Daytona deprecated the `_experimental_createSnapshot` API it relied on
// (`POST /api/sandbox/<id>/snapshot` now 404s). The replacement is
// `agentbox prepare --provider daytona`, which uses the documented
// `daytona.snapshot.create({ name, image })` API with a layered `Image`
// (Dockerfile.box + addLocalFile + runCommands) — no sandbox involved.

export const daytonaCommand = new Command('daytona')
  .description(
    'Daytona cloud provider — credentials, plus sugar for `--provider daytona` (e.g. `agentbox daytona create|claude|codex|opencode`)',
  )
  .addCommand(loginSub, { isDefault: true })
  .addCommand(resyncSub);
