/**
 * `~/.agentbox/remote-docker-prepared.json`.
 *
 * Unlike every other cloud provider, this file is NOT load-bearing. The image
 * ref on a remote engine is its build-context fingerprint (`agentbox/box:<sha>`),
 * so "is this host prepared?" is answered by asking the engine, not by trusting
 * a local file — and it is answered per host, which a single file could never
 * do. What this records is the *history*: which hosts we have baked, with what,
 * and when, for `agentbox prepare --status` and `doctor` to report.
 */

import { readPreparedStateRaw, writePreparedStateRaw, readCliStamp } from '@agentbox/sandbox-core';

const SCHEMA = 1;
const PROVIDER = 'remote-docker';

export interface PreparedRemoteHost {
  imageRef: string;
  contextSha256: string;
  cliVersion?: string;
  cliCommit?: string;
  createdAt: string;
}

export interface PreparedRemoteDockerState {
  schema: number;
  /** Keyed by SSH destination, exactly as the user spelled it. */
  hosts: Record<string, PreparedRemoteHost>;
}

export function readPreparedState(): PreparedRemoteDockerState | null {
  const raw = readPreparedStateRaw(PROVIDER);
  if (raw === null || typeof raw !== 'object') return null;
  const parsed = raw as Partial<PreparedRemoteDockerState>;
  if (parsed.schema !== SCHEMA || typeof parsed.hosts !== 'object' || parsed.hosts === null) {
    return null;
  }
  return { schema: SCHEMA, hosts: parsed.hosts };
}

/** Drop one host from the prepared-image history. Returns whether it was present. */
export function removePreparedHost(host: string): boolean {
  const existing = readPreparedState();
  if (!existing || !(host in existing.hosts)) return false;
  const hosts = { ...existing.hosts };
  delete hosts[host];
  writePreparedStateRaw(PROVIDER, { schema: SCHEMA, hosts });
  return true;
}

export function recordPreparedHost(
  host: string,
  fields: { imageRef: string; contextSha256: string },
): void {
  const stamp = readCliStamp();
  const existing = readPreparedState();
  const next: PreparedRemoteDockerState = {
    schema: SCHEMA,
    hosts: {
      ...(existing?.hosts ?? {}),
      [host]: {
        imageRef: fields.imageRef,
        contextSha256: fields.contextSha256,
        ...(stamp.cliVersion ? { cliVersion: stamp.cliVersion } : {}),
        ...(stamp.cliCommit ? { cliCommit: stamp.cliCommit } : {}),
        createdAt: new Date().toISOString(),
      },
    },
  };
  writePreparedStateRaw(PROVIDER, next);
}
