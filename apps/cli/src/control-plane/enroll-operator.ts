/**
 * Enroll the machine that deployed a control box as a device on it, at the end
 * of `hub setup` / `hub deploy` / `hub update`.
 *
 * The operator PC talks to its hub with the shared keys in `control-plane.env`,
 * so it never ran `agentbox hub login` and the hub had no device for it. Anything
 * the hub asks a PC over host-reach (a skills comparison runs `pcskills.*` on an
 * enrolled, connected device) could not pick it. This runs the same device-code
 * flow as `hub login`, approving the code itself with the API key and admin token
 * it holds.
 *
 * No local hub restart: the relay already polling here presents this machine's
 * id (`X-Agentbox-Device`, honored for the shared admin token), so the hub binds
 * that poller to the new device at once; a relay started later presents the
 * device token instead (`applyHostReachEnvAtStartup`).
 */
import { getMachineId, getMachineLabel } from '@agentbox/config';
import {
  normalizeHubUrl,
  readDeviceCredential,
  writeDeviceCredential,
  type DeviceCredential,
} from '@agentbox/sandbox-core';
import type { OwnerCredentials } from './owner-credentials.js';

interface WireDevice {
  id: string;
  label: string;
  revokedAt: string | null;
}

export type OperatorEnrollDecision =
  | { action: 'skip'; reason: 'this-machine' | 'no-owner-credentials' | 'enrolled' }
  | { action: 'revoked'; label: string }
  | { action: 'enroll'; rotate: boolean };

/**
 * What to do, from what the hub and this machine know. Pure.
 *
 * - The control box is this machine (`hub expose`): nothing to enroll on.
 * - No API key + admin token here: this machine cannot approve itself.
 * - Revoked on the hub: someone revoked it on purpose; never undone silently.
 * - Listed and the local token still works: already enrolled, leave it.
 * - Otherwise enroll. `rotate` when the hub lists it but the local token is gone
 *   or no longer accepted (a new token replaces the lost one).
 */
export function decideOperatorEnrollment(input: {
  controlBoxIsThisMachine: boolean;
  hasOwnerCredentials: boolean;
  listed: WireDevice | undefined;
  localTokenValid: boolean;
}): OperatorEnrollDecision {
  if (input.controlBoxIsThisMachine) return { action: 'skip', reason: 'this-machine' };
  if (!input.hasOwnerCredentials) return { action: 'skip', reason: 'no-owner-credentials' };
  if (input.listed?.revokedAt) return { action: 'revoked', label: input.listed.label };
  if (input.listed && input.localTokenValid) return { action: 'skip', reason: 'enrolled' };
  return { action: 'enroll', rotate: input.listed !== undefined };
}

export interface EnrollOperatorResult {
  decision: OperatorEnrollDecision;
  /** Set when this run wrote a new device credential. */
  enrolled?: { deviceId: string; label: string; path: string };
}

export interface EnrollOperatorDeps {
  url: string;
  owner: OwnerCredentials | null;
  controlBoxIsThisMachine: boolean;
  fetch?: typeof fetch;
  home?: string;
  deviceId?: string;
  label?: string;
}
interface Answer<T> {
  status: number;
  body: T & { error?: { code?: string; message?: string } };
}

/**
 * Run the decision against the hub at `url` and, when it says enroll, enroll.
 * Throws on a network failure or an unexpected answer; the caller warns.
 */
export async function enrollOperatorDevice(
  deps: EnrollOperatorDeps,
): Promise<EnrollOperatorResult> {
  const url = normalizeHubUrl(deps.url);
  const doFetch = deps.fetch ?? fetch;
  const call = async <T>(
    path: string,
    init: { method?: string; bearer?: string; adminToken?: string; body?: unknown } = {},
  ): Promise<Answer<T>> => {
    const res = await doFetch(`${url}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
        ...(init.adminToken ? { 'x-agentbox-admin-token': init.adminToken } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as Answer<T>['body'];
    return { status: res.status, body };
  };
  const unexpected = (what: string, a: Answer<unknown>): Error =>
    new Error(
      `${what} answered ${String(a.status)}: ${a.body.error?.message ?? 'unexpected answer'}`,
    );

  const early = decideOperatorEnrollment({
    controlBoxIsThisMachine: deps.controlBoxIsThisMachine,
    hasOwnerCredentials: deps.owner !== null,
    listed: undefined,
    localTokenValid: false,
  });
  if (early.action === 'skip' || !deps.owner) return { decision: early };
  const owner = deps.owner;
  const deviceId = deps.deviceId ?? getMachineId();
  const label = deps.label ?? getMachineLabel();

  const listed = await call<{ devices: WireDevice[] }>('/api/v1/devices', { bearer: owner.apiKey });
  if (listed.status !== 200) throw unexpected('GET /api/v1/devices', listed);
  const mine = listed.body.devices.find((d) => d.id === deviceId);

  // The local token counts only if the hub still takes it as this device.
  const cred = readDeviceCredential(deps.home);
  let localTokenValid = false;
  if (mine && !mine.revokedAt && cred && cred.hubUrl === url && cred.deviceId === deviceId) {
    const probe = await call<{ current: string | null }>('/api/v1/devices', { bearer: cred.token });
    // Only a refusal proves the token dead. A restarting hub's 502/503 must not
    // rotate it: a rotation closes every stream this PC holds open.
    if (probe.status === 200) localTokenValid = probe.body.current === deviceId;
    else if (probe.status !== 401 && probe.status !== 403) {
      throw unexpected('GET /api/v1/devices (device token)', probe);
    }
  }

  const decision = decideOperatorEnrollment({
    controlBoxIsThisMachine: false,
    hasOwnerCredentials: true,
    listed: mine,
    localTokenValid,
  });
  if (decision.action !== 'enroll') return { decision };

  const started = await call<{ deviceCode: string; userCode: string }>('/api/v1/devices/code', {
    method: 'POST',
    body: { deviceId, label },
  });
  if (started.status !== 201) throw unexpected('POST /api/v1/devices/code', started);
  const approved = await call('/api/v1/devices/approve', {
    method: 'POST',
    bearer: owner.apiKey,
    adminToken: owner.adminToken,
    body: { userCode: started.body.userCode },
  });
  if (approved.status !== 200) {
    // Withdraw the code, or each failed setup leaves one more waiting code
    // labelled like this computer (and three of them rate-limit `hub login`).
    await call('/api/v1/devices/deny', {
      method: 'POST',
      bearer: owner.apiKey,
      adminToken: owner.adminToken,
      body: { userCode: started.body.userCode },
    }).catch(() => undefined);
    throw unexpected('POST /api/v1/devices/approve', approved);
  }
  const claimed = await call<{ token: string; device: WireDevice }>('/api/v1/devices/token', {
    method: 'POST',
    body: { deviceCode: started.body.deviceCode },
  });
  if (claimed.status !== 200 || !claimed.body.token) {
    throw unexpected('POST /api/v1/devices/token', claimed);
  }
  const record: DeviceCredential = {
    hubUrl: url,
    deviceId: claimed.body.device.id,
    label: claimed.body.device.label,
    token: claimed.body.token,
    enrolledAt: new Date().toISOString(),
  };
  const path = writeDeviceCredential(record, deps.home);
  return { decision, enrolled: { deviceId: record.deviceId, label: record.label, path } };
}
