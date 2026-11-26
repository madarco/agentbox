/**
 * The automatic first seed of the hub's skills library from this PC (owner
 * direction 2): runs at the end of hub setup/deploy and on create, does nothing
 * once the hub is seeded, and never fails or noisily interrupts what called it.
 *
 * This PC remembers each hub it has already seen seeded, or seeded itself, in
 * `~/.agentbox/skills-seeded.json`. A hub's `.seeded` marker is never removed,
 * so the memo can't go stale, and every later create skips the check without a
 * network round trip. A PC whose skills were all flagged (or all skipped on the
 * hub) also counts as done, so it doesn't re-scan and re-report them on every
 * create; a PC with no skills at all does not, and costs no round trip, so the
 * first skill added to it still seeds the hub. Another PC can still seed that hub.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadEffectiveConfig, STATE_DIR } from '@agentbox/config';
import { withHubTargetQuiet } from '../../control-plane/with-hub.js';
import { discoverLocalSkills } from '@agentbox/sandbox-core';
import { describeSeed, seedSkillsIfEmpty } from './sync.js';

function memoPath(): string {
  return join(STATE_DIR, 'skills-seeded.json');
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

// Version 1 memos were written by a seed that never reached this machine's own
// hub, and by attempts with nothing to upload, so their loopback entries prove
// nothing; a remote control box listed there was seeded through an explicit URL,
// which did work, and is kept.
const MEMO_VERSION = 2;

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '[::1]' || host.startsWith('127.');
  } catch {
    return true;
  }
}

export async function seededHubs(): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(memoPath(), 'utf8')) as {
      version?: unknown;
      hubs?: unknown;
    };
    const hubs = Array.isArray(parsed.hubs)
      ? parsed.hubs.filter((h): h is string => typeof h === 'string')
      : [];
    return parsed.version === MEMO_VERSION ? hubs : hubs.filter((h) => !isLoopback(h));
  } catch {
    return [];
  }
}

export async function rememberSeeded(url: string): Promise<void> {
  const hubs = new Set(await seededHubs());
  hubs.add(normalizeUrl(url));
  await mkdir(dirname(memoPath()), { recursive: true });
  await writeFile(
    memoPath(),
    JSON.stringify({ version: MEMO_VERSION, hubs: [...hubs].sort() }, null, 2) + '\n',
  );
}

export async function autoSeedSkills(opts: {
  /** The hub to seed; default the configured one. */
  url?: string;
  /** Where the one summary line goes when something was seeded or skipped. */
  announce: (line: string) => void;
  /** Why nothing was seeded, and any upload failure (a log file on create, never the terminal). */
  debug?: (line: string) => void;
}): Promise<void> {
  try {
    // Lazy, like withHubClient: control-plane.ts sits in a module cycle with hub.ts.
    const { resolveHubApiTarget } = await import('../../commands/control-plane.js');
    const target = await resolveHubApiTarget(opts.url, { quiet: true });
    if (!target) {
      opts.debug?.(
        'skills seed skipped: no hub could be resolved (none configured, or no credential for it); the next create retries',
      );
      return;
    }
    if ((await seededHubs()).includes(normalizeUrl(target.url))) return;

    const cfg = await loadEffectiveConfig(process.cwd()).catch(() => null);
    const maxBytes = cfg?.effective.skills.maxSkillBytes ?? 50 * 1024 * 1024;
    // Scanned before any network call, so a PC with no skills costs a create no
    // round trip. Not remembered: the first skill added later must still seed.
    const local = await discoverLocalSkills({ home: homedir(), maxBytes });
    if (local.length === 0) {
      opts.debug?.(`skills seed skipped: no skills on this PC to seed ${target.url} with`);
      return;
    }
    // The resolved target itself, not its URL: re-resolving `target.url` as an
    // explicit URL finds no credential for this machine's own hub.
    const res = await withHubTargetQuiet(target, (client) =>
      seedSkillsIfEmpty(client, { home: homedir(), maxBytes }, local),
    );
    if (!res.ok) {
      opts.debug?.(
        `skills seed failed against ${target.url}: ${res.error}; the next create retries`,
      );
      return;
    }
    const out = res.value;
    // Done with this hub once it holds a skill (or this PC has nothing it may
    // send). Only a seed where every upload failed leaves it unseeded, and the
    // next create retries it; after a partial one the hub is seeded, so the
    // failed skills are left to an explicit `agentbox skills` upload.
    if (!out || out.uploaded.length > 0 || out.failed.length === 0) {
      await rememberSeeded(target.url);
    }
    if (!out) return;
    if (out.uploaded.length + out.skipped.length + out.failed.length === 0) {
      opts.debug?.(`skills seed: every skill on this PC is skipped on ${target.url}`);
      return;
    }
    opts.announce(describeSeed(out));
    const retry =
      out.uploaded.length === 0 ? 'the next create retries' : 'upload it with `agentbox skills`';
    for (const f of out.failed)
      opts.debug?.(`skills seed: ${f.name} failed (${retry}): ${f.reason}`);
  } catch (err) {
    opts.debug?.(`skills seed failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
