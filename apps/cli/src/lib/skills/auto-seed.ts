/**
 * The automatic first seed of the hub's skills library from this PC (owner
 * direction 2): runs at the end of hub setup/deploy and on create, does nothing
 * once the hub is seeded, and never fails or noisily interrupts what called it.
 */
import { homedir } from 'node:os';
import { loadEffectiveConfig } from '@agentbox/config';
import { withHubClientQuiet } from '../../control-plane/with-hub.js';
import { describeSeed, seedSkillsIfEmpty } from './sync.js';

export async function autoSeedSkills(opts: {
  /** The hub to seed; default the configured one. */
  url?: string;
  /** Where the one summary line goes when something was seeded or skipped. */
  announce: (line: string) => void;
  /** Where a failure goes (a log file, never the terminal). */
  debug?: (line: string) => void;
}): Promise<void> {
  const cfg = await loadEffectiveConfig(process.cwd()).catch(() => null);
  const maxBytes = cfg?.effective.skills.maxSkillBytes ?? 50 * 1024 * 1024;
  const res = await withHubClientQuiet({ ...(opts.url ? { url: opts.url } : {}) }, (client) =>
    seedSkillsIfEmpty(client, { home: homedir(), maxBytes }),
  );
  if (!res.ok) {
    opts.debug?.(`skills seed skipped: ${res.error}`);
    return;
  }
  const out = res.value;
  if (!out) return;
  if (out.uploaded.length + out.skipped.length + out.failed.length === 0) return;
  opts.announce(describeSeed(out));
}
