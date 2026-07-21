/**
 * `agentbox install` — interactive setup wizard:
 *
 *   1. Compact system compatibility check (one line).
 *   2. Provider picker (single-select; docker default).
 *   3. Provider login (skipped for docker; reuses each provider's existing
 *      `ensure*Credentials` flow, including Vercel's "install sandbox CLI
 *      then browser login" handling).
 *   4. Confirm-then-run base image / snapshot prepare (default-yes for docker).
 *   5. Install the host `/agentbox` skill files into Claude / Codex / OpenCode.
 *   6. Write the first-run marker.
 *   7. Tutorial outro.
 *
 * `--skills-only` runs just step 5 (the pre-wizard behavior of this command).
 *
 * `runInstallWizard` is also called from `index.ts` as a first-run auto-trigger
 * when `~/.agentbox/setup-complete.json` is absent.
 */

import { confirm, intro, log, note, outro, select, spinner } from '../lib/prompt.js';
import { Command } from 'commander';
import { execa } from 'execa';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatCompact,
  runProviderChecks,
  runSystemChecks,
  type CheckGroup,
  type CheckResult,
  type ProviderName,
} from '../lib/doctor-checks.js';
import { markSetupComplete } from '../lib/first-run.js';
import { maybePromptStar } from '../lib/star-prompt.js';
import { installCmuxCommand } from './install-cmux.js';
import { installHerdrCommand } from './install-herdr.js';
import { runPrepare } from './prepare.js';

/** Marker on the line after the frontmatter of every skill we ship. Its
 *  presence in an existing target means we wrote it and may overwrite freely. */
const MANAGED_SENTINEL = '<!-- agentbox-managed:v1 -->';

/** Compact half-block "agentbox" wordmark shown above the wizard's clack gutter.
 *  Brand blue (256-color 39) echoes the dashboard sidebar. */
const LOGO_L1 = '▄▀█ █▀▀ █▀▀ █▄░█ ▀█▀ █▄▄ █▀█ ▀▄▀';
const LOGO_L2 = '█▀█ █▄█ ██▄ █░▀█ ░█░ █▄█ █▄█ █░█';
const LOGO_WIDTH = LOGO_L1.length; // both lines are the same cell width

/** Static fallback banner (no animation): solid brand blue, dropped when NO_COLOR. */
const BANNER = (() => {
  const art = `${LOGO_L1}\n${LOGO_L2}`;
  const tinted = process.env.NO_COLOR ? art : `\x1b[38;5;39m${art}\x1b[0m`;
  return `\n${tinted}\n\n`;
})();

// Synchronized-output toggles (DECSET/DECRST 2026): terminals that support it
// commit each animation frame atomically, avoiding tearing/flicker.
const SYNC_BEGIN = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

/** Braille spinner frames for the "Checking system…" line shown under the logo. */
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 256-color code for a logo cell `dist` columns from the shine band's center. */
function shineColor(dist: number): number {
  const d = Math.abs(dist);
  if (d === 0) return 231; // white core
  if (d === 1) return 159; // light cyan
  if (d === 2) return 81; // cyan
  return 39; // base brand blue
}

/** Render one logo line with the shine band centered at column `center`. */
function paintLine(line: string, center: number): string {
  let out = '';
  let prev = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const c = shineColor(i - center);
    if (c !== prev) {
      out += `\x1b[38;5;${String(c)}m`;
      prev = c;
    }
    out += ch;
  }
  return out + '\x1b[0m';
}

/**
 * Draw the agentbox logo with a ~2s left-to-right "shine sweep", then settle to
 * the solid brand-blue wordmark. Falls back to the instant static banner when a
 * TTY isn't present or motion is suppressed (NO_COLOR / CI / AGENTBOX_NO_ANIM),
 * leaving identical output to `BANNER` so `intro(...)` always starts clean.
 */
async function animateBanner(): Promise<void> {
  if (
    process.env.NO_COLOR ||
    process.env.CI ||
    process.env.AGENTBOX_NO_ANIM ||
    !process.stdout.isTTY
  ) {
    process.stdout.write(BANNER);
    return;
  }

  const restoreCursor = (): void => {
    process.stdout.write(SHOW_CURSOR);
  };
  process.once('exit', restoreCursor);
  // Adding a SIGINT listener suppresses Node's default terminate-on-Ctrl+C, so
  // restore the cursor and exit explicitly (130 = terminated by SIGINT). Keep a
  // named reference so the cleanup below can actually remove it — otherwise the
  // handler leaks past the animation and fires on the next Ctrl+C (e.g. during a
  // clack prompt), bypassing clack's cancellation flow.
  const onSigint = (): void => {
    restoreCursor();
    process.exit(130);
  };
  process.once('SIGINT', onSigint);

  const frameMs = 45;
  // Band starts just off the left edge and exits past the right edge.
  const start = -3;
  const end = LOGO_WIDTH + 2;

  // Layout reserved under the logo (so the sweep isn't pinned to the terminal's
  // bottom edge): L2, a blank row, the "Checking system…" status row, then a
  // trailing blank pad row. Reserve them up front (scrolling the view up if we
  // are near the bottom), then return to the logo's first row to animate.
  // Each frame redraws both logo lines + the status line, then moves the cursor
  // back up to the logo's first row so the next frame paints in place.
  const down = 4; // L2(+1) + blank(+2) + status(+3) + blank pad(+4)
  process.stdout.write(`\n${HIDE_CURSOR}`);
  process.stdout.write('\n'.repeat(down) + `\x1b[${String(down)}A`);

  const statusLine = (spin: string): string =>
    `  \x1b[38;5;51m${spin}\x1b[0m \x1b[38;5;245mChecking system…\x1b[0m`;

  for (let center = start; center <= end; center++) {
    const spin = SPIN[Math.floor((center - start) / 2) % SPIN.length] ?? SPIN[0]!;
    const frame =
      SYNC_BEGIN +
      paintLine(LOGO_L1, center) +
      '\n' +
      paintLine(LOGO_L2, center) +
      '\n\n\x1b[2K' + // down to the status row (col 0), clear it
      statusLine(spin) +
      '\x1b[3A\r' + // back up to the logo's first row
      SYNC_END;
    process.stdout.write(frame);
    await sleep(frameMs);
  }

  // Settle the wordmark to solid brand blue (status line stays), hold briefly.
  process.stdout.write(SYNC_BEGIN + `\x1b[38;5;39m${LOGO_L1}\n${LOGO_L2}\x1b[0m` + SYNC_END);
  await sleep(250);

  // Clear the status row and leave the cursor one blank line below the logo so
  // the real (instant) system check prints its result there via `intro(...)`.
  process.stdout.write(SYNC_BEGIN + '\n\x1b[2K\n\x1b[2K' + SHOW_CURSOR + SYNC_END);
  process.removeListener('exit', restoreCursor);
  process.removeListener('SIGINT', onSigint);
}

/** Substring unique to the pre-rename `agentbox` host skill. Lets `install`
 *  replace it in place during the agentbox → agentbox-info rename even though
 *  that old file predates the sentinel. */
const LEGACY_INFO_MARKER = 'Drive AgentBox from the host:';

interface InstallTarget {
  src: string;
  dest: string;
  /** Only install when this dir exists (i.e. the tool is set up on this host). */
  gateDir?: string;
}

// The user-invokable `/agentbox` fork skill is installed separately via the open
// `skills` CLI (see installForkSkill) rather than in this manual copy/symlink loop,
// so the install is registered on the skills.sh directory. Everything else here uses
// per-agent formats/paths that don't map onto the skills CLI's layout.
function installTargets(): InstallTarget[] {
  const home = homedir();
  const claudeSkills = join(home, '.claude', 'skills');
  return [
    {
      src: join('agentbox-info', 'SKILL.md'),
      dest: join(claudeSkills, 'agentbox-info', 'SKILL.md'),
    },
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
    resolve(here, '..', 'share', 'host-skills'),
    resolve(here, '..', '..', 'share', 'host-skills'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`could not locate bundled host skills; tried:\n  ${candidates.join('\n  ')}`);
}

function isSymlink(target: string): boolean {
  try {
    return lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * True when the bundled skills resolve inside a source checkout rather than an
 * installed package. Every distribution path — `npm i -g`, pnpm global, the
 * npx cache — lives under a `node_modules` segment; a dev clone
 * (`<repo>/apps/cli/share/host-skills`) does not. We key on the source
 * *location*, not `detectExecutionMethod`, because a global install invoked
 * directly carries no `npm_config_user_agent` and would misreport as `direct`.
 * In a checkout we symlink skills so source edits are picked up live (mirroring
 * the `pnpm register` bin symlink); a published install must copy, since its
 * source dir is transient and a symlink would dangle on upgrade.
 */
function isSourceCheckout(srcDir: string): boolean {
  return !srcDir.split(sep).includes('node_modules');
}

function writableReason(target: string, force: boolean): 'new' | 'managed' | 'forced' | 'skip' {
  if (!existsSync(target)) {
    // A dangling symlink (e.g. left by an earlier source-checkout run whose
    // source moved) has no resolvable target but still occupies the path; treat
    // it as ours to replace rather than as a user-authored file.
    if (isSymlink(target)) return 'managed';
    return 'new';
  }
  const existing = readFileSync(target, 'utf8');
  if (existing.includes(MANAGED_SENTINEL) || existing.includes(LEGACY_INFO_MARKER)) {
    return 'managed';
  }
  return force ? 'forced' : 'skip';
}

export interface InstallHostSkillsOptions {
  force?: boolean;
  dryRun?: boolean;
  /** When true, suppress per-file log lines (the wizard wants one-line outcome). */
  quiet?: boolean;
}

export interface InstallHostSkillsResult {
  written: string[];
  skipped: number;
  /** Files that exist but were untouched because they're user-authored. */
  blocked: string[];
}

/** Idempotently install the bundled host skill files. Used by both
 *  `agentbox install --skills-only` and the wizard. In a source checkout the
 *  targets are symlinked to the bundled source (live edits); an installed
 *  package copies the contents. See {@link isSourceCheckout}. */
export function installHostSkills(opts: InstallHostSkillsOptions = {}): InstallHostSkillsResult {
  const force = opts.force === true;
  const dryRun = opts.dryRun === true;
  const quiet = opts.quiet === true;
  const srcDir = resolveHostSkillsDir();
  // Source checkout → symlink (live edits); installed package → copy.
  const link = isSourceCheckout(srcDir);

  const written: string[] = [];
  const blocked: string[] = [];
  let skipped = 0;

  for (const t of installTargets()) {
    const src = join(srcDir, t.src);
    if (!existsSync(src)) {
      if (!quiet) log.warn(`bundled file missing (skipped): ${src}`);
      skipped++;
      continue;
    }
    if (t.gateDir && !existsSync(t.gateDir)) continue;
    const reason = writableReason(t.dest, force);
    if (reason === 'skip') {
      if (!quiet) log.warn(`user-modified file at ${t.dest}, skipping; pass --force to overwrite`);
      blocked.push(t.dest);
      skipped++;
      continue;
    }
    if (dryRun) {
      if (!quiet) log.info(`would ${link ? 'link' : 'write'} ${t.dest} (${reason})`);
      written.push(t.dest);
      continue;
    }
    mkdirSync(dirname(t.dest), { recursive: true });
    if (link) {
      // Unlink first so symlinkSync doesn't throw EEXIST and so a stale/broken
      // link from a prior run is cleared — the unlink-then-link `ln -sf` does.
      rmSync(t.dest, { force: true });
      symlinkSync(resolve(srcDir, t.src), t.dest);
    } else {
      // Drop an existing symlink (e.g. left by an earlier source-checkout run)
      // before writing — else writeFileSync follows it and clobbers the source.
      if (isSymlink(t.dest)) rmSync(t.dest, { force: true });
      writeFileSync(t.dest, readFileSync(src, 'utf8'));
    }
    written.push(t.dest);
  }

  return { written, skipped, blocked };
}

/** Public repo the open `skills` CLI fetches the `/agentbox` fork skill from on
 *  the default branch. `--skill agentbox` resolves against the skill whose
 *  frontmatter name is `agentbox`; the repo's top-level `skills/agentbox`
 *  symlink is its canonical publishing surface (and what skills.sh indexes). */
const FORK_SKILL_REPO = 'https://github.com/madarco/agentbox';

export interface InstallForkSkillResult extends InstallHostSkillsResult {
  method: 'npx' | 'symlink' | 'copy' | 'skip' | 'dry-run';
}

/**
 * Install the user-invokable `/agentbox` fork skill into Claude Code.
 *
 * In a **source checkout** we symlink the bundled source (live edits picked up,
 * no network, no skills.sh telemetry from dev installs) — mirroring
 * {@link installHostSkills}. In an **installed package** we delegate to the open
 * `skills` CLI (`npx skills add … --skill agentbox`) so the install is registered
 * on the skills.sh directory. If that fails (offline, npm missing, validation
 * error) we fall back to copying the bundled file so the install never breaks.
 */
export async function installForkSkill(
  opts: InstallHostSkillsOptions = {},
): Promise<InstallForkSkillResult> {
  const force = opts.force === true;
  const dryRun = opts.dryRun === true;
  const quiet = opts.quiet === true;
  const srcDir = resolveHostSkillsDir();
  const src = join(srcDir, 'agentbox', 'SKILL.md');
  const dest = join(homedir(), '.claude', 'skills', 'agentbox', 'SKILL.md');

  if (!existsSync(src)) {
    if (!quiet) log.warn(`bundled file missing (skipped): ${src}`);
    return { written: [], skipped: 1, blocked: [], method: 'skip' };
  }
  const reason = writableReason(dest, force);
  if (reason === 'skip') {
    if (!quiet) log.warn(`user-modified file at ${dest}, skipping; pass --force to overwrite`);
    return { written: [], skipped: 1, blocked: [dest], method: 'skip' };
  }
  if (dryRun) {
    const via = isSourceCheckout(srcDir) ? 'link' : 'npx skills add';
    if (!quiet) log.info(`would install ${dest} via ${via} (${reason})`);
    return { written: [dest], skipped: 0, blocked: [], method: 'dry-run' };
  }

  // Source checkout → symlink to local source (live edits; no network).
  if (isSourceCheckout(srcDir)) {
    mkdirSync(dirname(dest), { recursive: true });
    rmSync(dest, { force: true });
    symlinkSync(src, dest);
    return { written: [dest], skipped: 0, blocked: [], method: 'symlink' };
  }

  // Installed package → register via the open `skills` CLI; copy on any failure.
  try {
    await execa(
      'npx',
      [
        '-y',
        'skills',
        'add',
        FORK_SKILL_REPO,
        '--skill',
        'agentbox',
        '-a',
        'claude-code',
        '-g',
        '-y',
        '--copy',
      ],
      { timeout: 120_000 },
    );
    if (existsSync(dest)) return { written: [dest], skipped: 0, blocked: [], method: 'npx' };
    // Exited 0 but nothing landed — fall through to the copy fallback.
    throw new Error('`skills add` reported success but wrote no skill file');
  } catch (err) {
    if (!quiet) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`\`npx skills add\` failed (${msg}); copying the bundled fork skill instead`);
    }
    mkdirSync(dirname(dest), { recursive: true });
    if (isSymlink(dest)) rmSync(dest, { force: true });
    writeFileSync(dest, readFileSync(src, 'utf8'));
    return { written: [dest], skipped: 0, blocked: [], method: 'copy' };
  }
}

const PROVIDER_HINTS: Record<ProviderName, string> = {
  docker: 'builds a ~1GB local image; no login needed',
  hetzner: 'paste an API token from the Hetzner Console',
  daytona: 'approve a browser sign-in link',
  vercel: 'installs the Vercel sandbox CLI, then a browser sign-in',
  e2b: 'paste an API key from the E2B dashboard',
  tenki: 'paste an auth token from the Tenki dashboard',
};

const PROVIDER_LABEL: Record<ProviderName, string> = {
  docker: 'Docker (local)',
  hetzner: 'Hetzner (cloud VPS)',
  daytona: 'Daytona (cloud sandbox)',
  vercel: 'Vercel (cloud microVM)',
  e2b: 'E2B (cloud microVM)',
  tenki: 'Tenki (cloud microVM)',
};

function ensureTty(): boolean {
  if (process.stdin.isTTY && process.stdout.isTTY) return true;
  process.stderr.write(
    'agentbox install: an interactive terminal is required. ' +
      'Run `agentbox <provider> login` and `agentbox prepare --provider <name>` instead.\n',
  );
  return false;
}

interface RunInstallWizardOptions {
  /** Pre-pick the provider (skips the picker). */
  provider?: string;
  /** Auto-confirm the prepare step. */
  yes?: boolean;
  /** Forwarded to the embedded skill-copy step. */
  force?: boolean;
  dryRun?: boolean;
  /** Set when the wizard was triggered automatically before another command. */
  fromAutoTrigger?: boolean;
}

async function runProviderLogin(name: ProviderName): Promise<boolean> {
  if (name === 'docker') return true;
  if (name === 'daytona') {
    const mod = await import('@agentbox/sandbox-daytona');
    const status = await mod.getDaytonaStatus();
    if (status.configured) {
      log.info('daytona: already configured');
      const rotate = await confirm({ message: 'Re-authenticate Daytona?', initialValue: false });
      if (rotate) await mod.ensureDaytonaCredentials({ force: true });
      return true;
    }
    await mod.ensureDaytonaCredentials();
    return true;
  }
  if (name === 'hetzner') {
    const mod = await import('@agentbox/sandbox-hetzner');
    const status = mod.readHetznerCredStatus();
    if (status.source !== 'none') {
      log.info('hetzner: already configured');
      const rotate = await confirm({ message: 'Re-authenticate Hetzner?', initialValue: false });
      if (rotate) await mod.ensureHetznerCredentials({ force: true });
      return true;
    }
    await mod.ensureHetznerCredentials();
    return true;
  }
  if (name === 'vercel') {
    const mod = await import('@agentbox/sandbox-vercel');
    const status = mod.readVercelCredStatus();
    if (status.auth !== 'none') {
      log.info(`vercel: already configured (${status.auth})`);
      const rotate = await confirm({ message: 'Re-authenticate Vercel?', initialValue: false });
      if (rotate) await mod.ensureVercelCredentials({ force: true });
      return true;
    }
    await mod.ensureVercelCredentials();
    return true;
  }
  if (name === 'tenki') {
    const mod = await import('@agentbox/sandbox-tenki');
    const status = mod.readTenkiCredStatus();
    if (status.auth !== 'none') {
      log.info(`tenki: already configured (${status.auth})`);
      const rotate = await confirm({ message: 'Re-authenticate Tenki?', initialValue: false });
      if (rotate) await mod.ensureTenkiCredentials({ force: true });
      return true;
    }
    await mod.ensureTenkiCredentials();
    return true;
  }
  // e2b
  const mod = await import('@agentbox/sandbox-e2b');
  const status = mod.readE2bCredStatus();
  if (status.auth !== 'none') {
    log.info(`e2b: already configured (${status.auth})`);
    const rotate = await confirm({ message: 'Re-authenticate E2B?', initialValue: false });
    if (rotate) await mod.ensureE2bCredentials({ force: true });
    return true;
  }
  await mod.ensureE2bCredentials();
  return true;
}

function tutorialBody(provider: ProviderName): string {
  // Docker is the default provider, so the prefix is implicit; the cloud
  // providers need the explicit `agentbox <provider> claude` shorthand.
  const startCmd = provider === 'docker' ? 'agentbox claude    ' : `agentbox ${provider} claude`;
  return (
    `Get started:\n` +
    `  ${startCmd}                       # for claude, codex, opencode\n` +
    `   -> Setup wizard? -> Yes          # install dependencies and setup agentbox.yaml\n` +
    `   -> Ctrl+a d                      # to detach from the box and leave claude running\n` +
    `  agentbox claude attach 1          # resume it later\n` +
    `  agentbox install                  # to set up another provider`
  );
}

const KNOWN_PROVIDERS: ProviderName[] = ['docker', 'hetzner', 'daytona', 'vercel', 'e2b', 'tenki'];

function isProviderName(s: string): s is ProviderName {
  return (KNOWN_PROVIDERS as readonly string[]).includes(s);
}

/**
 * Drive the setup wizard. Returns true on a clean run, false if the user
 * cancelled at any prompt. The first-run marker is written only on the
 * success path (after the skill-install step), so a cancel from either
 * caller leaves the system in the same "still pending" state — the
 * auto-trigger will offer the wizard again on the next non-exempt command.
 */
export async function runInstallWizard(opts: RunInstallWizardOptions = {}): Promise<boolean> {
  if (!ensureTty()) return false;

  await animateBanner();
  intro('Check system compatibility');

  // 1) Compact system check (full detail lives in `agentbox doctor`).
  const sysResults = await runSystemChecks();
  const sysGroup: CheckGroup = { title: 'system', results: sysResults };
  process.stdout.write('  ' + formatCompact([sysGroup]) + '\n');
  const hardFail = sysResults.find((r: CheckResult) => r.status === 'fail');
  if (hardFail) {
    log.error(`system check failed: ${hardFail.label} — ${hardFail.detail}`);
    log.info('run `agentbox doctor` for full detail');
    const cont = await confirm({ message: 'Continue anyway?', initialValue: false });
    if (!cont) {
      outro('aborted');
      return false;
    }
  }

  // 2) Provider picker.
  let providerName: ProviderName;
  if (opts.provider) {
    const candidate = opts.provider.trim();
    if (!isProviderName(candidate)) {
      log.error(`unknown --provider: ${candidate}`);
      return false;
    }
    providerName = candidate;
  } else {
    const picked = await select<ProviderName>({
      message: 'Which provider do you want to set up?',
      initialValue: 'docker',
      options: KNOWN_PROVIDERS.map((p) => ({
        value: p,
        label: PROVIDER_LABEL[p],
        hint: PROVIDER_HINTS[p],
      })),
    });
    providerName = picked;
  }

  // 3) Login (skip docker).
  if (providerName !== 'docker') {
    const loggedIn = await runProviderLogin(providerName);
    if (!loggedIn) {
      outro('cancelled');
      return false;
    }
  }

  // 4) Optional remote/build prepare.
  const prepareMsg =
    providerName === 'docker'
      ? 'Build the box image now? (~1GB, a few minutes)'
      : `Bake the ${providerName} base snapshot now? (a few minutes, uses cloud time)`;
  const wantPrepare = opts.yes ? true : await confirm({ message: prepareMsg, initialValue: true });
  if (wantPrepare) {
    try {
      await runPrepare(providerName, {
        cwd: process.cwd(),
        yes: true,
        suppressStatus: true,
      });
    } catch (err) {
      log.warn(
        `prepare failed: ${err instanceof Error ? err.message : String(err)} — you can rerun \`agentbox prepare --provider ${providerName}\` later`,
      );
    }
  } else {
    log.info(
      `skipped — the ${providerName} base will build lazily on first \`agentbox ${providerName === 'docker' ? '' : providerName + ' '}create\``,
    );
  }

  // 5) Host /agentbox skill (idempotent).
  const sp = spinner();
  sp.start('installing host /agentbox skill…');
  try {
    const skillRes = installHostSkills({ force: opts.force, dryRun: opts.dryRun, quiet: true });
    const forkRes = await installForkSkill({ force: opts.force, dryRun: opts.dryRun, quiet: true });
    const written = skillRes.written.length + forkRes.written.length;
    const skipped = skillRes.skipped + forkRes.skipped;
    if (written > 0) {
      sp.stop(`Agentbox Skills: Installed in ${String(written)} locations`);
    } else {
      sp.stop(`Agentbox Skills: nothing to write (${String(skipped)} skipped)`);
    }
    const blocked = [...skillRes.blocked, ...forkRes.blocked];
    if (blocked.length > 0) {
      log.warn(
        `user-modified host skill file(s) left in place: ${blocked.join(', ')}\n` +
          'pass `agentbox install --skills-only --force` to overwrite',
      );
    }
  } catch (err) {
    sp.stop('Agentbox Skills: failed');
    log.warn(err instanceof Error ? err.message : String(err));
  }

  // 6) First-run marker (so the auto-trigger doesn't fire again).
  markSetupComplete(providerName);

  // Brief check post-setup so the user sees what's now ready.
  const providerGroup = await runProviderChecks(providerName);
  process.stdout.write('  ' + formatCompact([sysGroup, providerGroup]) + '\n');

  // 7) Tutorial outro.
  note(tutorialBody(providerName), 'Next steps');

  outro(
    opts.fromAutoTrigger
      ? '✨ Setup complete — continuing with your command…'
      : '✨ Setup complete',
  );

  await maybePromptStar({ trigger: 'install' });
  return true;
}

interface InstallOptions {
  skillsOnly?: boolean;
  force?: boolean;
  dryRun?: boolean;
  provider?: string;
  yes?: boolean;
}

export const installCommand = new Command('install')
  .description(
    'Interactive setup wizard: system check, pick a provider, log in, prepare its base image/snapshot, and install the host /agentbox skill. `--skills-only` runs just the skill install.',
  )
  .option(
    '--skills-only',
    'only install the host /agentbox skill files (no wizard, no login, no prepare)',
  )
  .option('--force', 'overwrite existing skill files even if not AgentBox-managed')
  .option('--dry-run', 'print what would be written without changing anything')
  .option(
    '-p, --provider <name>',
    'pre-select the provider to set up (docker | daytona | hetzner | vercel)',
  )
  .option('-y, --yes', 'auto-confirm the prepare step')
  .action(async (opts: InstallOptions) => {
    if (opts.skillsOnly) {
      intro('Installing AgentBox host commands...');
      let res: InstallHostSkillsResult;
      let forkRes: InstallForkSkillResult;
      try {
        res = installHostSkills({ force: opts.force, dryRun: opts.dryRun });
        forkRes = await installForkSkill({ force: opts.force, dryRun: opts.dryRun });
      } catch (err) {
        log.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      const written = [...res.written, ...forkRes.written];
      const skipped = res.skipped + forkRes.skipped;
      if (opts.dryRun) {
        outro(
          `dry-run: ${String(written.length)} file(s) would be written, ${String(skipped)} skipped`,
        );
        return;
      }
      if (written.length === 0) {
        outro(`nothing installed (${String(skipped)} skipped)`);
        return;
      }
      outro(`installed: ${written.join(', ')}`);
      return;
    }

    const ok = await runInstallWizard({
      provider: opts.provider,
      yes: opts.yes,
      force: opts.force,
      dryRun: opts.dryRun,
    });
    if (!ok) process.exit(1);
  });

// `agentbox install cmux` — write the AgentBox panel into the cmux sidebar dock.
// Positional options are required so flags shared with the parent (`--dry-run`,
// `--force`) bind to the subcommand once `cmux` is seen, instead of being
// consumed by `install`'s own same-named options.
installCommand.enablePositionalOptions();
installCommand.addCommand(installCmuxCommand);
installCommand.addCommand(installHerdrCommand);
