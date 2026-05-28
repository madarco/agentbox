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

interface InstallTarget {
  /** Path relative to the bundled `share/host-skills/` dir. */
  src: string;
  /** Absolute destination on the host. */
  dest: string;
  /** When set, install only if this directory exists — i.e. the tool is set up
   *  on this host. Absent dir = silently skip (don't write configs for a tool
   *  the user doesn't use). */
  gateDir?: string;
}

/** The files `agentbox install` writes. Claude skills always install; the Codex
 *  prompt and OpenCode command install only when that tool's config dir exists.
 *  All three surface the same `/agentbox` fork command in their respective
 *  agent UIs (Codex shows it under `/prompts:`). */
function installTargets(): InstallTarget[] {
  const home = homedir();
  const claudeSkills = join(home, '.claude', 'skills');
  return [
    { src: join('agentbox', 'SKILL.md'), dest: join(claudeSkills, 'agentbox', 'SKILL.md') },
    { src: join('agentbox-info', 'SKILL.md'), dest: join(claudeSkills, 'agentbox-info', 'SKILL.md') },
    {
      src: join('codex', 'agentbox.md'),
      dest: join(home, '.codex', 'prompts', 'agentbox.md'),
      gateDir: join(home, '.codex'),
    },
    {
      src: join('opencode', 'agentbox.md'),
      dest: join(home, '.config', 'opencode', 'commands', 'agentbox.md'),
      gateDir: join(home, '.config', 'opencode'),
    },
  ];
}

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
    "Install AgentBox's host-side /agentbox fork command into Claude (~/.claude/skills), and — when detected — into Codex (~/.codex/prompts) and OpenCode (~/.config/opencode/commands). Idempotent.",
  )
  .option('--force', 'overwrite existing files even if not AgentBox-managed')
  .option('--dry-run', 'print what would be written without changing anything')
  .action((opts: InstallOptions) => {
    intro('Installing AgentBox host commands...');
    const force = opts.force === true;
    const dryRun = opts.dryRun === true;

    let srcDir: string;
    try {
      srcDir = resolveHostSkillsDir();
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    const written: string[] = [];
    let skipped = 0;

    for (const t of installTargets()) {
      const src = join(srcDir, t.src);
      if (!existsSync(src)) {
        log.warn(`bundled file missing (skipped): ${src}`);
        skipped++;
        continue;
      }
      // Tool not set up on this host — skip silently (don't seed configs for a
      // tool the user doesn't use).
      if (t.gateDir && !existsSync(t.gateDir)) continue;
      const reason = writableReason(t.dest, force);
      if (reason === 'skip') {
        log.warn(`user-modified file at ${t.dest}, skipping; pass --force to overwrite`);
        skipped++;
        continue;
      }
      if (dryRun) {
        log.info(`would write ${t.dest} (${reason})`);
        written.push(t.dest);
        continue;
      }
      mkdirSync(dirname(t.dest), { recursive: true });
      writeFileSync(t.dest, readFileSync(src, 'utf8'));
      written.push(t.dest);
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
