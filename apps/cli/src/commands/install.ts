import { intro, log, outro } from '@clack/prompts';
import { Command } from 'commander';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Marker on the line after the frontmatter of every skill we ship. Its
 *  presence in an existing target means we wrote it and may overwrite freely. */
const MANAGED_SENTINEL = '<!-- agentbox-managed:v1 -->';

/** Substring unique to the pre-rename `agentbox` host skill. Lets `install`
 *  replace it in place during the agentbox → agentbox-info rename even though
 *  that old file predates the sentinel. */
const LEGACY_INFO_MARKER = 'Drive AgentBox from the host:';

/** Host skills this command installs, keyed by the bundled source subdir. The
 *  same name is used for the target dir under ~/.claude/skills/. */
const SKILLS = ['agentbox', 'agentbox-info'] as const;

/**
 * Locate the bundled `share/host-skills/` directory. This module is bundled
 * into the CLI at `<root>/dist/index.js`; `share/` ships as a sibling of
 * `dist/` in both the dev tree and the published package. The src-tree
 * candidate covers running unbundled (e.g. tsx).
 */
function resolveHostSkillsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', 'share', 'host-skills'), // bundled: dist/ -> ../share
    resolve(here, '..', '..', 'share', 'host-skills'), // src: src/commands/ -> ../../share
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `could not locate bundled host skills; tried:\n  ${candidates.join('\n  ')}`,
  );
}

interface InstallOptions {
  force?: boolean;
  dryRun?: boolean;
}

/** Decide whether we may write `target`. Missing or AgentBox-managed/legacy
 *  files are writable; a user-authored file is left alone unless --force. */
function writableReason(target: string, force: boolean): 'new' | 'managed' | 'forced' | 'skip' {
  if (!existsSync(target)) return 'new';
  const existing = readFileSync(target, 'utf8');
  if (existing.includes(MANAGED_SENTINEL) || existing.includes(LEGACY_INFO_MARKER)) {
    return 'managed';
  }
  return force ? 'forced' : 'skip';
}

export const installCommand = new Command('install')
  .description(
    "Install AgentBox's host-side Claude Code skills into ~/.claude/skills (the /agentbox fork command + the agentbox-info reference). Idempotent.",
  )
  .option('--force', 'overwrite existing skill files even if not AgentBox-managed')
  .option('--dry-run', 'print what would be written without changing anything')
  .action((opts: InstallOptions) => {
    intro('Installing AgentBox host skills...');
    const force = opts.force === true;
    const dryRun = opts.dryRun === true;

    let srcDir: string;
    try {
      srcDir = resolveHostSkillsDir();
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    const skillsRoot = join(homedir(), '.claude', 'skills');
    const written: string[] = [];
    let skipped = 0;

    for (const name of SKILLS) {
      const src = join(srcDir, name, 'SKILL.md');
      const targetDir = join(skillsRoot, name);
      const target = join(targetDir, 'SKILL.md');
      if (!existsSync(src)) {
        log.warn(`bundled skill missing (skipped): ${src}`);
        skipped++;
        continue;
      }
      const reason = writableReason(target, force);
      if (reason === 'skip') {
        log.warn(`user-modified file at ${target}, skipping; pass --force to overwrite`);
        skipped++;
        continue;
      }
      if (dryRun) {
        log.info(`would write ${target} (${reason})`);
        written.push(target);
        continue;
      }
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(target, readFileSync(src, 'utf8'));
      written.push(target);
    }

    if (dryRun) {
      outro(`dry-run: ${String(written.length)} file(s) would be written, ${String(skipped)} skipped`);
      return;
    }
    if (written.length === 0) {
      outro(`nothing installed (${String(skipped)} skipped)`);
      return;
    }
    outro(`installed: ${written.join(', ')}`);
  });
