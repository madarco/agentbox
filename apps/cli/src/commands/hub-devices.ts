/**
 * `agentbox hub login` / `hub logout` / `hub devices` — enrolling this PC on a
 * remote hub with its own revocable token (multi-PC Phase 1b), instead of copying
 * the hub-wide shared secrets in `control-plane.env` onto every machine.
 *
 * `login` is a device-code flow: the hub opens a short code, the owner approves
 * it on the hub's Devices page (signed in with the admin password), and the poll
 * here receives the token once. It lands in `~/.agentbox/control-plane/device.json`
 * (0600), which the CLI and the relay read wherever they used the shared keys.
 * A local single-PC hub needs none of this.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { Command } from 'commander';
import { log, note, spinner } from '@clack/prompts';
import { getMachineId, getMachineLabel, loadEffectiveConfig } from '@agentbox/config';
import {
  applyDeviceCredentialEnv,
  deviceCredentialPath,
  deviceTokenFor,
  normalizeHubUrl,
  readDeviceCredential,
  removeDeviceCredential,
  writeDeviceCredential,
} from '@agentbox/sandbox-core';
import { openInBrowser } from '../control-plane/ensure-repo-installed.js';
import { handleLifecycleError } from './_errors.js';
import { hubUnauthorizedHint } from '../control-plane/unauthorized-hint.js';

interface ApiError {
  error?: { code?: string; message?: string };
}

interface WireDevice {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

async function call<T>(
  url: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: T & ApiError }> {
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      accept: 'application/json',
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as T & ApiError;
  return { status: res.status, body };
}

async function configuredHubUrl(): Promise<string> {
  const cfg = await loadEffectiveConfig(process.cwd()).catch(() => null);
  return normalizeHubUrl(cfg?.effective.relay.controlPlaneUrl ?? '');
}

/**
 * Point this machine at `url` and make the running local hub (whose relay is
 * this PC's side of host-reach) pick up the new credential.
 */
async function adoptHub(url: string): Promise<void> {
  process.env.AGENTBOX_CONTROL_PLANE_URL = url;
  // The env this process hands a respawned local hub: drop whatever shared
  // secret it loaded for another hub, then present the device token.
  delete process.env.AGENTBOX_HUB_API_KEY;
  delete process.env.AGENTBOX_RELAY_ADMIN_TOKEN;
  applyDeviceCredentialEnv(process.env, url);
  const { applyControlPlaneUrl, reloadLocalHubForStore } = await import('./control-plane.js');
  if ((await configuredHubUrl()) === url) await reloadLocalHubForStore();
  else await applyControlPlaneUrl(url);
}

interface LoginOpts {
  browser?: boolean;
}

const loginSub = new Command('login')
  .description('Enroll this computer on a remote hub with its own revocable token')
  .argument('[url]', 'the hub URL (default: relay.controlPlaneUrl)')
  .option('--no-browser', 'only print the approval link (open it on any machine)')
  .action(async (urlArg: string | undefined, opts: LoginOpts) => {
    try {
      const url = normalizeHubUrl(urlArg ?? (await configuredHubUrl()));
      if (!url) {
        log.error('Pass the hub URL: agentbox hub login https://hub.example.com');
        process.exitCode = 64;
        return;
      }
      const deviceId = getMachineId();
      const label = getMachineLabel();
      const started = await call<{
        deviceCode: string;
        userCode: string;
        verificationPath: string;
        expiresIn: number;
        interval: number;
      }>(`${url}/api/v1/devices/code`, {
        method: 'POST',
        // A re-login presents the current token, so the owner sees the code really
        // comes from the enrolled computer rather than from someone claiming its id.
        body: { deviceId, label, currentToken: deviceTokenFor(url) || undefined },
      });
      if (started.status === 503) {
        log.error(
          `${url} does not enroll devices. A local hub needs no login; a deployed or exposed hub ` +
            'needs this CLI version or newer.',
        );
        process.exitCode = 1;
        return;
      }
      if (started.status !== 201) {
        log.error(
          `Could not start enrollment (${String(started.status)}): ${started.body.error?.message ?? 'unexpected answer'}`,
        );
        process.exitCode = 1;
        return;
      }
      const { deviceCode, userCode, verificationPath, expiresIn, interval } = started.body;
      const link = `${url}${verificationPath}`;
      note(
        `Approve this computer on the hub's Devices page (signed in as the owner):\n\n` +
          `  ${link}\n\n` +
          `Code: ${userCode}   (${label})\n\n` +
          'Check the code matches before approving. The link works from any machine.',
        'Device login',
      );
      if (opts.browser !== false) openInBrowser(link);

      const s = spinner();
      s.start('waiting for approval');
      const deadline = Date.now() + expiresIn * 1000;
      const waitMs = Math.max(1, interval) * 1000;
      while (Date.now() < deadline) {
        await delay(waitMs);
        const polled = await call<{ token: string; device: WireDevice }>(
          `${url}/api/v1/devices/token`,
          { method: 'POST', body: { deviceCode } },
        ).catch(() => null);
        if (!polled) continue; // a network blip; keep waiting until the code expires
        const code = polled.body.error?.code;
        if (polled.status === 200 && polled.body.token) {
          s.stop('approved');
          const path = writeDeviceCredential({
            hubUrl: url,
            deviceId: polled.body.device.id,
            label: polled.body.device.label,
            token: polled.body.token,
            enrolledAt: new Date().toISOString(),
          });
          await adoptHub(url);
          log.success(
            `This computer is enrolled on ${url} as ${polled.body.device.label}. Token saved to ${path}.`,
          );
          return;
        }
        if (code === 'authorization_pending') continue;
        // A proxy 502, a 429 or any answer without an enrollment verdict is not
        // the end of the code; keep polling until it expires.
        if (code !== 'access_denied' && code !== 'expired_token') continue;
        s.stop(code === 'access_denied' ? 'denied' : 'expired');
        log.error(
          code === 'access_denied'
            ? 'The owner denied this computer.'
            : 'The code expired or the hub restarted. Run `agentbox hub login` again.',
        );
        process.exitCode = 1;
        return;
      }
      s.stop('expired');
      log.error('Nobody approved the code in time. Run `agentbox hub login` again.');
      process.exitCode = 1;
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const logoutSub = new Command('logout')
  .description("Revoke this computer's device token on the hub and forget it here")
  .action(async () => {
    try {
      const cred = readDeviceCredential();
      if (!cred) {
        log.info('This computer is not enrolled on a hub (no device token).');
        return;
      }
      const res = await call(
        `${cred.hubUrl}/api/v1/devices/${encodeURIComponent(cred.deviceId)}/revoke`,
        { method: 'POST', token: cred.token },
      ).catch((err: unknown) => ({ status: 0, body: { error: { message: String(err) } } }));
      if (res.status === 200) log.success(`Revoked ${cred.label} on ${cred.hubUrl}.`);
      else if (res.status === 401) log.info('The hub had already revoked this token.');
      else {
        log.warn(
          `Could not reach ${cred.hubUrl} to revoke the token (${res.body.error?.message ?? String(res.status)}). ` +
            "Revoke it from the hub's Devices page.",
        );
      }
      removeDeviceCredential();
      delete process.env.AGENTBOX_HUB_API_KEY;
      delete process.env.AGENTBOX_RELAY_ADMIN_TOKEN;
      const { reloadLocalHubForStore } = await import('./control-plane.js');
      await reloadLocalHubForStore();
      log.info(`Removed ${deviceCredentialPath()}. relay.controlPlaneUrl is unchanged.`);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

/** The hub `/api/v1` target + Bearer the rest of the CLI uses. */
async function target(): Promise<{ url: string; token: string; mode: 'local' | 'remote' }> {
  const { resolveHubTarget } = await import('./hub.js');
  const t = await resolveHubTarget();
  lastTarget = { url: t.url, mode: t.mode };
  return { url: t.url, token: t.token, mode: t.mode };
}
let lastTarget: { url: string; mode: 'local' | 'remote' } | undefined;

function fail(status: number, body: ApiError): void {
  log.error(`${body.error?.message ?? 'request failed'} (${String(status)})`);
  if (status === 401) log.info(hubUnauthorizedHint(lastTarget?.url, lastTarget?.mode ?? 'remote'));
  process.exitCode = 1;
}

const devicesListSub = new Command('list')
  .description('List the devices enrolled on the hub')
  .option('--json', 'print JSON')
  .action(async (opts: { json?: boolean }) => {
    try {
      const t = await target();
      const res = await call<{ devices: WireDevice[]; current: string | null }>(
        `${t.url}/api/v1/devices`,
        { token: t.token },
      );
      if (res.status !== 200) return fail(res.status, res.body);
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(res.body, null, 2)}\n`);
        return;
      }
      if (res.body.devices.length === 0) {
        log.info('No device is enrolled. Run `agentbox hub login <url>` on a computer to add it.');
        return;
      }
      for (const d of res.body.devices) {
        const state = d.revokedAt
          ? `revoked ${d.revokedAt}`
          : d.lastSeenAt
            ? `seen ${d.lastSeenAt}`
            : 'never used';
        const me = d.id === res.body.current ? '  (this computer)' : '';
        process.stdout.write(`${d.id}  ${d.label}  ${state}${me}\n`);
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const devicesApproveSub = new Command('approve')
  .description('Approve an enrollment code (needs the owner API key, not a device token)')
  .argument('<code>', 'the XXXX-XXXX code `hub login` printed')
  .action(async (code: string) => {
    try {
      const t = await target();
      const res = await call<{ device: WireDevice }>(`${t.url}/api/v1/devices/approve`, {
        method: 'POST',
        token: t.token,
        body: { userCode: code },
      });
      if (res.status !== 200) return fail(res.status, res.body);
      log.success(`Approved ${res.body.device.label} (${res.body.device.id}).`);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const devicesRevokeSub = new Command('revoke')
  .description('Revoke a device: its next request to the hub is refused')
  .argument('<id>', 'the device id (`agentbox hub devices list`)')
  .action(async (id: string) => {
    try {
      const t = await target();
      const res = await call(`${t.url}/api/v1/devices/${encodeURIComponent(id)}/revoke`, {
        method: 'POST',
        token: t.token,
      });
      if (res.status !== 200) return fail(res.status, res.body);
      log.success(`Revoked ${id}.`);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const devicesRenameSub = new Command('rename')
  .description('Rename a device')
  .argument('<id>', 'the device id')
  .argument('<label>', 'the new name')
  .action(async (id: string, label: string) => {
    try {
      const t = await target();
      const res = await call(`${t.url}/api/v1/devices/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        token: t.token,
        body: { label },
      });
      if (res.status !== 200) return fail(res.status, res.body);
      log.success(`Renamed ${id} to ${label}.`);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const devicesCmd = new Command('devices')
  .description('The computers enrolled on the hub (`agentbox hub login`)')
  .addCommand(devicesListSub, { isDefault: true })
  .addCommand(devicesApproveSub)
  .addCommand(devicesRevokeSub)
  .addCommand(devicesRenameSub);

export const hubDeviceSubcommands = [loginSub, logoutSub, devicesCmd] as const;
