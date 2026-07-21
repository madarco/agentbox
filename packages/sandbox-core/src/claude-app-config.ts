/**
 * Writer for the Claude desktop app's own settings (`~/.claude/settings.json`)
 * — the app-local analogue of Codex's `codex://settings/connections/ssh/add`
 * deep link, which Claude.app doesn't have. The app reads SSH environments
 * from a `sshConfigs` array in its user settings (schema verified against
 * Claude.app v1.19367): `{ id, name, sshHost, sshPort?, sshIdentityFile?,
 * startDirectory? }`, where `sshHost` may be an alias from `~/.ssh/config` —
 * which is exactly what AgentBox maintains per box.
 *
 * This file is the user's REAL Claude Code settings: preserve every key we
 * don't own, and fail loud (never overwrite) when it exists but doesn't parse.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface ClaudeSshConfigEntry {
  /** Unique id; the app matches configs across settings sources by it. */
  id: string;
  /** Display name shown in the app's Environment dropdown. */
  name: string;
  /** "user@host", "host", or an alias from ~/.ssh/config. */
  sshHost: string;
  sshPort?: number;
  sshIdentityFile?: string;
  /** Default working directory on the remote (tilde-expanded by the app). */
  startDirectory?: string;
}

export function claudeSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json');
}

/** The sshConfigs entry for a box: the alias carries port + identity file. */
export function claudeSshEntryFor(alias: string, boxName: string): ClaudeSshConfigEntry {
  return {
    id: `agentbox-${alias}`,
    name: `AgentBox: ${boxName}`,
    sshHost: alias,
    startDirectory: '/workspace',
  };
}

interface ClaudeSettings {
  sshConfigs?: unknown[];
  [key: string]: unknown;
}

function readSettings(path: string): ClaudeSettings {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(
      `${path} exists but is not valid JSON (${err instanceof Error ? err.message : String(err)}) — ` +
        `not touching it. Fix the file and retry.`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object — not touching it. Fix the file and retry.`);
  }
  return parsed as ClaudeSettings;
}

function writeSettings(path: string, settings: ClaudeSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
}

function entryId(e: unknown): string | undefined {
  if (e !== null && typeof e === 'object' && typeof (e as { id?: unknown }).id === 'string') {
    return (e as { id: string }).id;
  }
  return undefined;
}

/**
 * Insert or replace (by `id`) one entry in `sshConfigs`, preserving every
 * other entry and every other settings key. Throws on an unparseable file.
 */
export function upsertClaudeSshConfig(entry: ClaudeSshConfigEntry): void {
  const path = claudeSettingsPath();
  const settings = readSettings(path);
  const configs = Array.isArray(settings.sshConfigs) ? settings.sshConfigs : [];
  const idx = configs.findIndex((e) => entryId(e) === entry.id);
  if (idx >= 0) {
    configs[idx] = entry;
  } else {
    configs.push(entry);
  }
  settings.sshConfigs = configs;
  writeSettings(path, settings);
}

/**
 * Drop every AgentBox-owned (`agentbox-`-prefixed) entry whose alias no longer
 * matches a live box. Called (best-effort) from `syncAgentboxSshConfig`, which
 * every lifecycle path runs — CLI destroy, hub/dashboard destroys via
 * `provider.destroy`+sync, and any later create/start — so an entry left by a
 * path that skipped the sync is swept on the next one. Foreign entries (no
 * `agentbox-` prefix) are never touched.
 */
export function pruneOrphanClaudeSshConfigs(liveAliases: ReadonlySet<string>): number {
  return removeClaudeSshConfigs(
    (id) => id.startsWith('agentbox-') && !liveAliases.has(id.slice('agentbox-'.length)),
  );
}

/**
 * Drop every `sshConfigs` entry whose id matches `predicate`. No-op when the
 * file is missing, has no `sshConfigs`, or nothing matches — the file is only
 * rewritten on a change. Throws on an unparseable file (callers treat this as
 * best-effort).
 */
export function removeClaudeSshConfigs(predicate: (id: string) => boolean): number {
  const path = claudeSettingsPath();
  if (!existsSync(path)) return 0;
  const settings = readSettings(path);
  if (!Array.isArray(settings.sshConfigs)) return 0;
  const kept = settings.sshConfigs.filter((e) => {
    const id = entryId(e);
    return id === undefined || !predicate(id);
  });
  const removed = settings.sshConfigs.length - kept.length;
  if (removed === 0) return 0;
  settings.sshConfigs = kept;
  writeSettings(path, settings);
  return removed;
}
