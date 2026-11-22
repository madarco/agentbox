import { Command } from 'commander';
import { fetchAgentDescriptorsOrThrow } from '../agent-registry.js';
import { describeSkillsSync, syncBoxSkills } from '../skills-sync.js';

/**
 * `agentbox-ctl skills sync` — pull this box's share of the hub's skills library
 * now, instead of waiting for the next daemon start. The daemon runs the same
 * pass at boot; the host can run this over `Provider.exec` after a library change.
 */
export const skillsCommand = new Command('skills').description(
  "The hub's skills library in this box",
);

skillsCommand
  .command('sync')
  .description("Install, update and remove this box's library skills to match the hub")
  .action(async () => {
    let linkDirs: readonly string[];
    try {
      linkDirs = (await fetchAgentDescriptorsOrThrow()).skillDirs;
    } catch (err) {
      process.stderr.write(
        `skills: could not read the agent registry: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
    const r = await syncBoxSkills({
      linkDirs,
      log: (m) => void process.stderr.write(`${m}\n`),
    });
    process.stdout.write(`${describeSkillsSync(r)}\n`);
    process.exit(r.failed.length > 0 ? 1 : 0);
  });
