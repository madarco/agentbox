import { spawnSync } from 'node:child_process';
import { log } from '@clack/prompts';
import {
  buildVncUrls,
  detectEngine,
  ensureBoxBrowser,
  inspectBox,
  readBoxStatus,
  startBox,
  unpauseBox,
} from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { resolveBoxOrExit } from '../box-ref.js';
import { providerForBox } from '../provider/registry.js';
import { handleLifecycleError } from './_errors.js';

interface ScreenOptions {
  print?: boolean;
  loopback?: boolean;
  ttl?: string;
}

/** Daytona's signed-URL ceiling is 24h; mirror `agentbox url`'s clamp. */
const SIGNED_URL_TTL_MIN = 1;
const SIGNED_URL_TTL_MAX = 86400;

function parseTtlOrExit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < SIGNED_URL_TTL_MIN || n > SIGNED_URL_TTL_MAX) {
    throw new Error(
      `--ttl must be an integer between ${String(SIGNED_URL_TTL_MIN)} and ${String(SIGNED_URL_TTL_MAX)} seconds`,
    );
  }
  return n;
}

export const screenCommand = new Command('screen')
  .description("Open a box's VNC (noVNC) viewer in the browser (auto-unpause/start)")
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('--print', 'print the URL to stdout instead of launching the browser')
  .option('--loopback', 'docker only: use the 127.0.0.1 URL instead of the OrbStack .orb.local URL')
  .option(
    '--ttl <seconds>',
    'cloud only: signed-URL expiry in seconds (default 3600, max 86400)',
  )
  .action(async (idOrName: string | undefined, opts: ScreenOptions) => {
    try {
      const box = await resolveBoxOrExit(idOrName);
      const provider = box.provider ?? 'docker';

      if (!box.vncEnabled) {
        throw new Error(`VNC is disabled for box ${box.name} — recreate without \`--no-vnc\``);
      }

      let url: string;
      if (provider === 'docker') {
        const insp = await inspectBox(box.id);
        if (insp.state === 'paused') {
          log.info('box is paused; unpausing');
          await unpauseBox(box.id);
        } else if (insp.state === 'stopped') {
          log.info('box is stopped; starting');
          await startBox(box.id);
        } else if (insp.state === 'missing') {
          throw new Error(`box ${box.name} has no container; was it destroyed?`);
        }

        // Point the in-box browser at the box's web service so the app is shown
        // *inside* the VNC desktop (the host browser only gets the noVNC viewer).
        // Prefer the Portless URL — `ensureBoxBrowser` routes it back out to the
        // host proxy, so the app loads on the exact URL the host browser uses
        // (one origin both sides). Fall back to the in-box `127.0.0.1:<port>` when
        // there's no Portless route; a neutral page when no web service at all.
        const persisted = await readBoxStatus(box);
        const exposePort = persisted?.services.find((s) => s.expose)?.expose?.port;
        const inBoxUrl =
          exposePort !== undefined
            ? (box.portlessUrl ?? `http://localhost:${String(exposePort)}`)
            : 'about:blank';

        const br = await ensureBoxBrowser(box.container, undefined, inBoxUrl);
        if (br.up && !br.alreadyRunning) {
          log.info(
            exposePort !== undefined
              ? `opened ${inBoxUrl} in the in-box browser (visible in the VNC view)`
              : 'started in-box browser',
          );
        } else if (br.alreadyRunning) {
          log.info('in-box browser already running; left it untouched');
        } else {
          log.warn(`could not start in-box browser: ${br.reason ?? 'unknown'}`);
        }

        const engine = await detectEngine();
        const urls = buildVncUrls(box, engine);
        // Preference when --loopback is off: portless > orb.local > loopback.
        // Portless gives a stable name across box restarts (loopback port
        // rerolls every `docker run`); orb.local is OrbStack-only; loopback is
        // the always-available fallback. `--loopback` forces the raw port.
        const resolved = opts.loopback
          ? urls.loopbackUrl
          : (urls.portlessUrl ?? urls.orbUrl ?? urls.loopbackUrl);
        if (!resolved) {
          throw new Error(
            `VNC URL unavailable (daemon may not be up); try \`agentbox inspect ${box.name}\``,
          );
        }
        url = resolved;
      } else {
        // Cloud provider: lifecycle handled by the provider; URL is a signed
        // preview URL for the in-box noVNC port (6080) — the host browser
        // can open it directly without a custom header.
        if (!box.vncPassword) {
          throw new Error(
            `cloud box ${box.name} has no VNC password recorded — recreate it to enable \`agentbox screen\``,
          );
        }
        const ttl = parseTtlOrExit(opts.ttl);
        const p = await providerForBox(box);
        const state = await p.probeState(box);
        if (state === 'paused') {
          log.info('box is paused; resuming');
          await p.resume(box);
        } else if (state === 'stopped') {
          log.info('box is stopped; starting');
          await p.start(box);
        } else if (state === 'missing') {
          throw new Error(`cloud sandbox for ${box.name} is missing; was it deleted?`);
        }

        // Open the box's web app *inside* the VNC desktop (the host browser only
        // gets the noVNC viewer), mirroring the docker path. The in-box Chromium
        // loads the same public preview URL the host uses — the box can reach its
        // own `*.vercel.run` domain (verified), so it's one origin both sides.
        // Only when a web service is declared; best-effort, never fails `screen`.
        const persisted = await readBoxStatus(box);
        const hasWebService = persisted?.services.some((s) => s.expose) ?? false;
        if (hasWebService) {
          try {
            const webUrl = await p.resolveUrl(box, { kind: 'web' });
            const q = `'${webUrl.replace(/'/g, "'\\''")}'`;
            const br = await p.exec(box, ['bash', '-lc', `agent-browser open --headed ${q}`], {
              user: 'vscode',
            });
            if (br.exitCode === 0) {
              log.info(`opened ${webUrl} in the in-box browser (visible in the VNC view)`);
            } else {
              log.warn(
                `could not open in-box browser (continuing): ${br.stderr.trim() || br.stdout.trim() || `exit ${String(br.exitCode)}`}`,
              );
            }
          } catch (err) {
            log.warn(
              `in-box browser skipped: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        const base = await p.resolveUrl(box, { kind: 'vnc', ttl });
        // Append noVNC's auto-connect query so the browser jumps straight to
        // the desktop without prompting for a password — same shape Docker's
        // `buildVncUrls` produces. Strip any trailing slash from the signed
        // host so the path concatenation stays canonical.
        url = `${base.replace(/\/$/, '')}/vnc.html?autoconnect=1&password=${encodeURIComponent(box.vncPassword)}`;
      }

      if (opts.print) {
        process.stdout.write(`${url}\n`);
        return;
      }

      const opened = spawnSync('open', [url], { stdio: 'inherit' });
      if (opened.status !== 0) {
        throw new Error(`open ${url} failed (exit ${String(opened.status ?? 'n/a')})`);
      }
      process.stdout.write(`opened ${url}\n`);
    } catch (err) {
      handleLifecycleError(err);
    }
  });
