/**
 * `agentbox hub adopt <box>` — materialize a local `BoxRecord` for a box that
 * lives in the control box's registry (created from the web UI or `--via-hub`).
 *
 * With a control box configured the PC is a thin client: the control box is the
 * source of truth for cloud boxes, and the local `state.json` record is a
 * materialized cache. Adoption is what writes that cache — without it a
 * hub-created box can't be resolved by name at all, because every direct PC↔box
 * command (`attach`, `cp`, `download`, `url`, `screen`, `destroy`) goes
 * `resolveBoxOrExit` → `readState` → provider.
 *
 * Everything needed to rebuild the record rides on the registration (the
 * adoption material added by the plane-register enrichment): provider, sandbox
 * id, public VM IP, image, web port, agent, branch, origin URL. The per-box SSH
 * key material comes from custody (`boxes/<sandboxId>/ssh/`) via the existing
 * `pullBoxSshKeys`.
 *
 * Kept free of command-layer concerns (logging, exit codes, config reads) so it
 * is unit-testable with fake clients + a temp HOME, mirroring `hub-pull.ts`.
 */
import { execa } from 'execa';
import type { BoxRecord } from '@agentbox/core';
import { readState } from '@agentbox/sandbox-core';
import { generateRelayToken, recordBox } from '@agentbox/sandbox-docker';
import { allocateProjectIndex } from '@agentbox/sandbox-core';
import { registrationToBoxRecord } from '@agentbox/relay';
import type { CustodyClient } from './custody-client.js';
import type { ControlPlaneAdminClient } from './admin-client.js';
import { downloadBoxSshKeys } from './hub-pull.js';
import { matchRegistration } from './match-ref.js';

export interface HubAdoptArgs {
  admin: ControlPlaneAdminClient;
  custody: CustodyClient;
  /** Box id, name, or sandbox id as shown by `control-plane boxes list`. */
  ref: string;
  /** The control-plane base URL, persisted on the record's cloud fields. */
  controlPlaneUrl: string;
  /** cwd for origin-URL project matching. Defaults to `process.cwd()`. */
  cwd?: string;
  log?: (line: string) => void;
}

export interface HubAdoptResult {
  record: BoxRecord;
  /** Basenames of SSH key files pulled from custody (empty for e2b/vercel). */
  sshFiles: string[];
  /** Local project the box's origin URL matched, when any. */
  projectRoot?: string;
  /** True when an existing local record was refreshed rather than created. */
  refreshed: boolean;
  /**
   * True when the box needs a per-box SSH key (the record has an `identityFile`)
   * but custody had none. The box is adopted and `url` works, but `attach`/`cp`
   * will fail until the key is there.
   */
  sshKeysMissing?: boolean;
}

/** Thrown when the ref matches no registration on the control box. */
export class HubBoxNotFoundError extends Error {
  constructor(ref: string) {
    super(`no box matching '${ref}' is registered on the control box`);
    this.name = 'HubBoxNotFoundError';
  }
}

/**
 * Normalize a git remote URL for comparison: drop the scheme, any user@, a
 * trailing `.git`, and case — so `git@github.com:o/r.git`,
 * `https://github.com/o/r`, and `ssh://git@github.com/o/r.git` all match.
 */
export function normalizeOriginUrl(url: string): string {
  return url
    .trim()
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(/:(?=\D)/, '/')
    .replace(/\.git\/?$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

/** A repo's `origin` remote URL, or undefined when it isn't a repo / has none. */
async function readOriginUrl(dir: string): Promise<string | undefined> {
  const r = await execa('git', ['-C', dir, 'remote', 'get-url', 'origin'], { reject: false });
  const url = (r.stdout ?? '').trim();
  return r.exitCode === 0 && url.length > 0 ? url : undefined;
}

/** Absolute path of the repo root containing `dir`, or undefined. */
async function readRepoRoot(dir: string): Promise<string | undefined> {
  const r = await execa('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { reject: false });
  const root = (r.stdout ?? '').trim();
  return r.exitCode === 0 && root.length > 0 ? root : undefined;
}

/**
 * Find the local checkout for a hub box's origin URL: the cwd's repo first,
 * then any other project already in state with the same origin. Returns the
 * project root, or undefined when this PC has no clone of the repo (the box is
 * still adoptable — it just shows under `ls -g` only).
 */
async function matchLocalProject(
  originUrl: string | undefined,
  cwd: string,
  state: { boxes: BoxRecord[] },
): Promise<string | undefined> {
  if (!originUrl) return undefined;
  const want = normalizeOriginUrl(originUrl);
  const cwdOrigin = await readOriginUrl(cwd).catch(() => undefined);
  if (cwdOrigin && normalizeOriginUrl(cwdOrigin) === want) {
    const root = await readRepoRoot(cwd).catch(() => undefined);
    if (root) return root;
  }
  // Fall back to the project roots of boxes already in state: a repo we've
  // created a box from before is a clone we know the path of.
  const seen = new Set<string>();
  for (const b of state.boxes) {
    const root = b.projectRoot;
    if (!root || seen.has(root)) continue;
    seen.add(root);
    const origin = await readOriginUrl(root).catch(() => undefined);
    if (origin && normalizeOriginUrl(origin) === want) return root;
  }
  return undefined;
}


/**
 * Rebuild a local `BoxRecord` from a control-box registration, download the
 * box's SSH key material from custody, and persist it to `state.json`.
 *
 * Idempotent: re-adopting an already-local box refreshes the cached record from
 * the registration while preserving the fields only the PC knows (its id, so
 * status paths stay stable, and any project linkage already resolved).
 */
export async function adoptHubBox(args: HubAdoptArgs): Promise<HubAdoptResult> {
  const log = args.log ?? (() => {});
  const cwd = args.cwd ?? process.cwd();

  const registrations = await args.admin.listBoxes();
  const reg = matchRegistration(registrations, args.ref);
  if (!reg) throw new HubBoxNotFoundError(args.ref);

  const sandboxId = reg.sandboxId ?? reg.boxId;

  const state = await readState();
  // Re-adopt keeps the existing local identity: the relay writes status.json
  // under a path keyed by the box id + project index, so minting a new id on
  // every refresh would orphan the box's status.
  // Identity only — sandbox id or box id. A NAME match is not identity: names
  // are not unique across providers, so adopting a hub box called `foo` would
  // have overwritten an unrelated local (e.g. docker) box called `foo` with
  // cloud fields, corrupting the record for a different box entirely.
  const existing = state.boxes.find(
    (b) => (b.cloud?.sandboxId !== undefined && b.cloud.sandboxId === sandboxId) || b.id === reg.boxId,
  );

  const projectRoot =
    existing?.projectRoot ?? (await matchLocalProject(reg.originUrl, cwd, state));
  const projectIndex =
    existing?.projectIndex ??
    (projectRoot ? allocateProjectIndex(state, projectRoot) : undefined);

  // One source of truth for registration → record reconstruction, shared with
  // the control box's own `hydrateRegisteredBox` (@agentbox/relay). The PC-only
  // concerns — which local project the box maps to, its per-project index, and
  // the SSH-key download below — stay here.
  const record: BoxRecord = registrationToBoxRecord(reg, {
    controlPlaneUrl: args.controlPlaneUrl,
    existing,
    projectRoot,
    projectIndex,
    freshToken: generateRelayToken,
  });

  // Key material: only providers that mint a keypair (hetzner/DO) have any.
  // Detected by what's actually in custody rather than by provider name, so a
  // new SSH provider needs no change here.
  //
  // Pass the provider + key we already resolved rather than the raw ref: letting
  // the download re-resolve it meant a sandbox-id ref landed the keys in a
  // different dir than the `identityFile` we just recorded.
  const sshFiles = await downloadBoxSshKeys({
    custody: args.custody,
    provider: reg.backend,
    key: sandboxId,
  }).catch(() => []);
  if (sshFiles.length > 0) {
    log(`pulled ${String(sshFiles.length)} SSH key file(s) for ${reg.name}`);
  }
  // A box we just gave an `identityFile` but no key for is adopted-but-unusable:
  // `attach`/`cp` would fail later on a missing-key ssh error rather than here,
  // where we know why. The record is still worth writing (`url` works, and the
  // key can be fetched later), so this is reported, not thrown.
  const sshKeysMissing = record.ssh?.identityFile !== undefined && sshFiles.length === 0;
  if (sshKeysMissing) {
    log(
      `WARN: no SSH key material in custody for ${reg.name} (boxes/${sandboxId}/ssh) — ` +
        `attach / cp will not work until it is there. Try \`agentbox hub pull ${reg.name}\`.`,
    );
  }

  await recordBox(record);
  return { record, sshFiles, projectRoot, refreshed: existing !== undefined, sshKeysMissing };
}
