/**
 * Concern: credentials — the per-agent login secrets (`~/.claude/.credentials.json`
 * for claude, `auth.json` for codex/opencode) that ride separately from static
 * config because they change per login and must never be baked into a shared
 * snapshot.
 *
 * What lives here is the provider-neutral core of the concern:
 *  - the pure host-side guards (`isRealAgentCredential`, `hostClaudeBackupExpired`,
 *    `hostBackupHasCredentials`) — the "is this blob real / expired?" decisions,
 *    driven by the registry's `credential.realShape` so the per-agent switch has
 *    one home;
 *  - the box→host extract (`extractCredentials`) expressed against the
 *    `SyncTransport.readText` seam, so cloud's `extractCloudAgentCredentials`
 *    becomes a thin transport-injecting wrapper;
 *  - the seed-once marker name (`SEED_MARKER`) shared by the cloud volume seed.
 *
 * What deliberately does NOT live here (yet): the *seed* mechanisms. Docker
 * seeds claude via a throwaway root helper container that bidirectionally syncs
 * the shared config volume with the host backup (`syncClaudeCredentials`,
 * `SYNC_SCRIPT`) — it predates any running box, so it has no `SyncTransport`
 * (box-bound) analog and no polymorphic caller; codex/opencode ride the whole-
 * dir volume rsync. Cloud seeds via `seedCredentialsOne` (marker/force gate +
 * `uploadFile` + a volume-vs-ephemeral extract split). Those stay in their
 * providers; their transport-seam collapse folds into the Phase 7 driver, the
 * same call carry's apply mechanism and skills' box→host pull already made.
 */

import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SyncTransport } from '@agentbox/core';
import { AGENT_SYNC_SPECS, resolveAgentSpec } from '../registry.js';
import type { AgentId } from '../agents/types.js';

/** Agents whose credentials we extract from a box back to the host. Mirrors `AgentId`. */
export type CredentialAgentKind = AgentId;

/**
 * Marker filename written inside a cloud agent's credentials subpath recording
 * when we last seeded it (a single ISO-8601 timestamp on disk). Absent marker =
 * first time on this volume → seed. Volume/idempotency-only: ephemeral cloud
 * backends can't persist it and push every create; docker uses a content check
 * (real-vs-empty) instead of a marker.
 */
export const SEED_MARKER = '.agentbox-seeded-at';

/** Host backup of the claude OAuth blob — the registry is the single source of truth. */
const CLAUDE_HOST_BACKUP = resolveAgentSpec('claude').credential.hostBackup;

/**
 * True iff `text` looks like a real (usable) credential for `agent`, not an
 * empty/placeholder file. Used so the box→host extract never clobbers a good
 * host backup with an empty box file. The per-agent shape comes from the
 * registry (`credential.realShape`): claude requires a non-empty
 * `claudeAiOauth.refreshToken`; codex/opencode auth files just have to parse as
 * a non-empty JSON object. Unknown agents fall back to the JSON-object check
 * (never throws — matches the pre-registry `if (agent === 'claude')` switch).
 */
export function isRealAgentCredential(agent: CredentialAgentKind, text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;
  const spec = AGENT_SYNC_SPECS.find((s) => s.id === agent);
  if (spec?.credential.realShape === 'claude-oauth') {
    const rt = (parsed as { claudeAiOauth?: { refreshToken?: unknown } }).claudeAiOauth?.refreshToken;
    return typeof rt === 'string' && rt.length > 0;
  }
  return Object.keys(parsed as Record<string, unknown>).length > 0;
}

/**
 * True iff the claude host backup holds an OAuth blob whose access token is
 * already expired (`claudeAiOauth.expiresAt`, ms epoch, < now). A missing
 * `expiresAt` (or unreadable file) → false: we only report a *known* expiry, so
 * callers don't nag when the box could still refresh the token itself. `now` is
 * injectable for tests. Claude is the only agent with a token-expiry gate (codex
 * / opencode auth files carry no comparable field).
 */
export async function hostClaudeBackupExpired(
  path: string = CLAUDE_HOST_BACKUP,
  now: number = Date.now(),
): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as {
      claudeAiOauth?: { expiresAt?: unknown };
    };
    const exp = parsed?.claudeAiOauth?.expiresAt;
    return typeof exp === 'number' && Number.isFinite(exp) && exp < now;
  } catch {
    return false;
  }
}

/**
 * True iff the claude host backup file holds a real OAuth blob (a non-empty
 * `claudeAiOauth.refreshToken`). Used to decide whether to offer an interactive
 * sign-in before creating a box. Tolerant of a missing or garbage file — returns
 * false.
 */
export async function hostBackupHasCredentials(
  path: string = CLAUDE_HOST_BACKUP,
): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as {
      claudeAiOauth?: { refreshToken?: unknown };
    };
    const rt = parsed?.claudeAiOauth?.refreshToken;
    return typeof rt === 'string' && rt.length > 0;
  } catch {
    return false;
  }
}

export interface ExtractCredentialsOptions {
  onLog?: (line: string) => void;
  /** Override host backup paths per agent (tests). Defaults to the registry `hostBackup`. */
  backups?: Partial<Record<AgentId, string>>;
}

/**
 * Extract each agent's login credential from a running box back to the host
 * backups under `~/.agentbox/`, so the next box (seeded from those backups)
 * inherits the login. The provider-neutral core of docker's
 * `syncClaudeCredentials` extract direction and cloud's
 * `extractCloudAgentCredentials`, expressed against `transport.readText`.
 *
 * Reads the canonical in-box path (`credential.boxAbsPath`) via
 * `transport.readText`; only writes the host backup (mode 0600) when the content
 * passes `isRealAgentCredential`, so an empty / not-logged-in box never clobbers
 * a good backup. Best-effort per agent (never throws). Returns the agents whose
 * backup was updated.
 */
export async function extractCredentials(
  transport: SyncTransport,
  opts: ExtractCredentialsOptions = {},
): Promise<AgentId[]> {
  const log = opts.onLog ?? (() => {});
  const extracted: AgentId[] = [];
  for (const spec of AGENT_SYNC_SPECS) {
    const hostBackup = opts.backups?.[spec.id] ?? spec.credential.hostBackup;
    try {
      // `readText` is `cat <path> 2>/dev/null` with noRetry → null on a missing
      // file; tolerate that silently. `!text` also covers an empty stdout.
      const text = await transport.readText(spec.credential.boxAbsPath);
      if (!text || !isRealAgentCredential(spec.id, text)) continue;
      await mkdir(dirname(hostBackup), { recursive: true });
      await writeFile(hostBackup, text, { mode: 0o600 });
      await chmod(hostBackup, 0o600).catch(() => {});
      extracted.push(spec.id);
      log(`extracted ${spec.id} login from box to ${hostBackup}`);
    } catch (err) {
      log(
        `WARN: ${spec.id} credential extract failed (${err instanceof Error ? err.message : String(err)}) — skipping`,
      );
    }
  }
  return extracted;
}

// ---------------------------------------------------------------------------
// credential fan-out (box → host backup → other boxes)
// ---------------------------------------------------------------------------

/** Wire payload of the ctl watcher's `credentials-updated` relay event. */
export interface CredentialsUpdate {
  agent: CredentialAgentKind;
  /** The decoded credential file content. */
  content: string;
}

/** Refuse absurd payloads before parsing (a credential file is ~1-5 KB). */
const MAX_CREDENTIAL_BYTES = 256 * 1024;

/**
 * Parse + validate a `credentials-updated` event payload. Returns null for
 * anything malformed: unknown agent, oversized/undecodable content, or a blob
 * that fails the agent's `isRealAgentCredential` shape.
 */
export function parseCredentialsUpdate(payload: unknown): CredentialsUpdate | null {
  if (payload === null || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  const agent = obj['agent'];
  if (typeof agent !== 'string' || !AGENT_SYNC_SPECS.some((s) => s.id === agent)) return null;
  const b64 = obj['contentBase64'];
  if (typeof b64 !== 'string' || b64.length === 0 || b64.length > MAX_CREDENTIAL_BYTES) return null;
  let content: string;
  try {
    content = Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return null;
  }
  if (!isRealAgentCredential(agent as CredentialAgentKind, content)) return null;
  return { agent: agent as CredentialAgentKind, content };
}

/** `claudeAiOauth.expiresAt` (ms epoch) of a claude blob, or null. */
export function claudeExpiresAt(text: string): number | null {
  try {
    const parsed = JSON.parse(text) as { claudeAiOauth?: { expiresAt?: unknown } };
    const exp = parsed?.claudeAiOauth?.expiresAt;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : null;
  } catch {
    return null;
  }
}

/**
 * Newest-wins acceptance gate for an incoming credential vs the current host
 * backup. Claude blobs carry `expiresAt`, which strictly increases on every
 * OAuth refresh (verified live) — accept only a strictly newer one. Codex /
 * opencode auth files carry no ordering field: accept whenever the content
 * differs (last-writer-wins). Identical content is always a no-op.
 */
export function shouldAcceptCredentialUpdate(
  agent: CredentialAgentKind,
  incoming: string,
  existing: string | null,
): { accept: boolean; reason: string } {
  if (existing === null) return { accept: true, reason: 'no existing backup' };
  if (existing === incoming) return { accept: false, reason: 'unchanged' };
  if (resolveAgentSpec(agent).credential.realShape === 'claude-oauth') {
    const incomingExp = claudeExpiresAt(incoming);
    const existingExp = claudeExpiresAt(existing);
    if (incomingExp === null) return { accept: false, reason: 'incoming blob has no expiresAt' };
    if (existingExp !== null && incomingExp <= existingExp) {
      return { accept: false, reason: 'not newer than backup' };
    }
    return { accept: true, reason: 'newer expiresAt' };
  }
  return { accept: true, reason: 'content changed' };
}

/** Atomically write an agent's host credential backup (0600, tmp + rename). */
export async function writeCredentialBackup(
  agent: CredentialAgentKind,
  content: string,
  opts: { backupPath?: string } = {},
): Promise<void> {
  const path = opts.backupPath ?? resolveAgentSpec(agent).credential.hostBackup;
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${String(process.pid)}`;
  await writeFile(tmp, content, { mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => {});
}

/** Read an agent's host credential backup, or null when absent. */
export async function readCredentialBackup(
  agent: CredentialAgentKind,
  opts: { backupPath?: string } = {},
): Promise<string | null> {
  const path = opts.backupPath ?? resolveAgentSpec(agent).credential.hostBackup;
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Push a credential blob into a live box at the agent's canonical path over a
 * `SyncTransport`, normalizing owner to the box user and mode to 0600. The
 * chown/chmod runs as the transport's default exec user first and falls back
 * to sudo (upload primitives on some backends write as root; the box user has
 * passwordless sudo). Never hardcode uid 1000 — the vscode uid varies per
 * provider.
 */
export async function pushCredentialToBox(
  transport: SyncTransport,
  agent: CredentialAgentKind,
  content: string,
): Promise<void> {
  const abs = resolveAgentSpec(agent).credential.boxAbsPath;
  const dir = abs.slice(0, abs.lastIndexOf('/'));
  const stage = await mkdtemp(join(tmpdir(), 'agentbox-cred-push-'));
  try {
    const tmp = join(stage, 'credential');
    await writeFile(tmp, content, { mode: 0o600 });
    const mk = await transport.exec(['sh', '-c', `mkdir -p '${dir}'`]);
    if (mk.exitCode !== 0) {
      throw new Error(`mkdir ${dir} in box failed: ${mk.stderr.trim()}`);
    }
    await transport.pushFile(tmp, abs);
    const normalize = `chown "$(id -un):" '${abs}' && chmod 600 '${abs}'`;
    const norm = await transport.exec([
      'sh',
      '-c',
      `{ ${normalize}; } 2>/dev/null || sudo sh -c "${normalize.replaceAll('"', '\\"')}"`,
    ]);
    if (norm.exitCode !== 0) {
      throw new Error(`chown/chmod of ${abs} in box failed: ${norm.stderr.trim()}`);
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
