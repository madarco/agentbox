/**
 * The automatic first seed of the hub's skills library from this PC (owner
 * direction 2): runs at the end of hub setup/deploy and on create, does nothing
 * once the hub is seeded, and never fails or noisily interrupts what called it.
 *
 * This PC remembers each hub it has already seen seeded, or seeded itself, in
 * `~/.agentbox/skills-seeded.json`. A hub's `.seeded` marker is never removed,
 * so the memo can't go stale, and every later create skips the check without a
 * network round trip. It also covers a PC with nothing uploadable (no skills,
 * or all flagged): its attempt counts, so it doesn't re-scan and re-report the
 * same skipped skills on every create. Another PC can still seed that hub.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadEffectiveConfig, STATE_DIR } from '@agentbox/config';
import { withHubClientQuiet } from '../../control-plane/with-hub.js';
import { describeSeed, seedSkillsIfEmpty } from './sync.js';

function memoPath(): string {
  return join(STATE_DIR, 'skills-seeded.json');
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export async function seededHubs(): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(memoPath(), 'utf8')) as { hubs?: unknown };
    return Array.isArray(parsed.hubs)
      ? parsed.hubs.filter((h): h is string => typeof h === 'string')
      : [];
  } catch {
    return [];
  }
}

export async function rememberSeeded(url: string): Promise<void> {
  const hubs = new Set(await seededHubs());
  hubs.add(normalizeUrl(url));
  await mkdir(dirname(memoPath()), { recursive: true });
  await writeFile(memoPath(), JSON.stringify({ hubs: [...hubs].sort() }, null, 2) + '\n');
}

export async function autoSeedSkills(opts: {
  /** The hub to seed; default the configured one. */
  url?: string;
  /** Where the one summary line goes when something was seeded or skipped. */
  announce: (line: string) => void;
  /** Where a failure goes (a log file, never the terminal). */
  debug?: (line: string) => void;
}): Promise<void> {
  try {
    // Lazy, like withHubClient: control-plane.ts sits in a module cycle with hub.ts.
    const { resolveHubApiTarget } = await import('../../commands/control-plane.js');
    const target = await resolveHubApiTarget(opts.url, { quiet: true });
    if (!target) {
      opts.debug?.('skills seed skipped: no hub is configured or running');
      return;
    }
    if ((await seededHubs()).includes(normalizeUrl(target.url))) return;

    const cfg = await loadEffectiveConfig(process.cwd()).catch(() => null);
    const maxBytes = cfg?.effective.skills.maxSkillBytes ?? 50 * 1024 * 1024;
    const res = await withHubClientQuiet({ url: target.url }, (client) =>
      seedSkillsIfEmpty(client, { home: homedir(), maxBytes }),
    );
    if (!res.ok) {
      opts.debug?.(`skills seed skipped: ${res.error}`);
      return;
    }
    const out = res.value;
    // Seeded before (null) or attempted now: this PC is done with it, unless an
    // upload failed on the wire, which the next create retries.
    if (!out || out.failed.length === 0) await rememberSeeded(target.url);
    if (!out || out.uploaded.length + out.skipped.length + out.failed.length === 0) return;
    opts.announce(describeSeed(out));
  } catch (err) {
    opts.debug?.(`skills seed failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
