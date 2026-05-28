import { log } from '@clack/prompts';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Print a one-time tip pointing at `agentbox install` when the host `/agentbox`
 * fork skill isn't installed yet. Gated by a marker file so it shows at most
 * once per host. Best-effort — never throws into the caller's happy path.
 */
export function maybeShowInstallHint(): void {
  try {
    const skill = join(homedir(), '.claude', 'skills', 'agentbox', 'SKILL.md');
    if (existsSync(skill)) return;
    const marker = join(homedir(), '.agentbox', 'install-hint-shown');
    if (existsSync(marker)) return;
    mkdirSync(join(homedir(), '.agentbox'), { recursive: true });
    writeFileSync(marker, '');
    log.info("tip: run 'agentbox install' to enable the /agentbox fork command in host Claude");
  } catch {
    // Non-fatal: a missing HOME or unwritable dir must not break create.
  }
}
