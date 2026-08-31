import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Source-level guard: outside an agent's own package, an exported symbol must
 * not be named after an agent.
 *
 * The rule the refactor is built on is that every abstraction is named for the
 * ROLE, never the tool: `AgentSyncModule.ensureVolume`, not
 * `ensureClaudeVolume` three times. A name like `stageCodexStaticForUpload` in
 * a shared package is the same coupling as a hardcoded switch — it just fails
 * later, when a fourth agent has no function to call.
 *
 * Comments are stripped first: prose ABOUT claude is fine and often necessary.
 * This is about the public symbol.
 *
 * ALLOWLIST, and why it is shaped this way. Every entry is a file the refactor
 * has not reached yet, annotated with the phase that owns it (see
 * `docs/agents-as-packages-plan.md`). A guard that ships with open-ended
 * exemptions trains people to add one more, so the list is checked BOTH ways:
 * an unlisted offender fails, and a listed file that no longer offends fails
 * too. It can only shrink, and when it is empty the rule holds repo-wide with
 * no exemptions — which is the phase's own proof, the same arrangement
 * `_agents-in-cli.ts` uses.
 */

const REPO = join(__dirname, '..', '..', '..');

/**
 * Roots that must obey the rule. `packages/agent-*` is absent on purpose: an
 * agent's own package is exactly where its name belongs.
 */
const ROOTS = [
  'packages/core/src',
  'packages/config/src',
  'packages/ctl/src',
  'packages/relay/src',
  'packages/sandbox-core/src',
  'packages/sandbox-cloud/src',
  'packages/sandbox-docker/src',
  'apps/hub/lib',
  'apps/hub/app',
  'apps/cli/src',
];

/**
 * Files that still export an agent-named symbol, each with the phase that
 * removes it. Paths are repo-relative.
 */
const ALLOWLIST: Record<string, string> = {
  // Phase 2 — the CLI layer. These move into `packages/agent-<id>/` once the
  // shared CLI kit is extracted (the per-agent folders import 26 distinct
  // shared CLI modules today, so it is an extraction, not a file move).
  // `apps/cli/src/agents/**` is excluded wholesale below for the same reason.
  'apps/cli/src/auth.ts': 'phase 2',
  'apps/cli/src/lib/claude-cred-health.ts': 'phase 2',
  'apps/cli/src/lib/claude-login-run.ts': 'phase 2',
  'apps/cli/src/commands/download-claude.ts': 'phase 2',
  'apps/cli/src/commands/download-codex.ts': 'phase 2',
  'apps/cli/src/commands/download-opencode.ts': 'phase 2',
  'apps/cli/src/commands/install-codex.ts': 'phase 2',
  'apps/cli/src/commands/_claude-login-worker.ts': 'phase 2',
  'apps/cli/src/session-teleport/cwd-encoding.ts': 'phase 2',
  'apps/cli/src/session-teleport/plan.ts': 'phase 2',

  // Phase 4 — the `sandbox-core` / `sandbox-cloud` moves. Gated: `host-stage.ts`
  // imports the first two, and ITS exports are published SDK surface, so the
  // move is an SDK_API_VERSION bump rather than a refactor.
  'packages/sandbox-core/src/sync/host-stage.ts': 'phase 4',
  'packages/sandbox-core/src/sync/codex-config.ts': 'phase 4',
  'packages/sandbox-core/src/sync/agent-pull.ts': 'phase 4',
  'packages/sandbox-core/src/sync/concerns/credentials.ts': 'phase 4',
  'packages/sandbox-core/src/sync/agents/claude/paths.ts': 'phase 4',
  'packages/sandbox-core/src/claude-app-config.ts': 'phase 4',
  'packages/sandbox-cloud/src/sync/claude-json-overlay.ts': 'phase 4',
  'packages/sandbox-docker/src/sync/claude-credentials.ts': 'phase 4',
  'packages/sandbox-docker/src/credential-refresh.ts': 'phase 4',
  'packages/sandbox-core/src/sync/agent-propagate.ts': 'phase 4',

  // Phase 5b — `claudeInstall`. 300 sites across 79 files, reaching the
  // published SDK, the hub's REST schema, on-disk prepared state and a
  // Dockerfile build arg.
  'packages/config/src/types.ts': 'phase 5b',
  'packages/sandbox-core/src/prepared-state.ts': 'phase 5b',

  // Phase 7 — the remaining renames.
  'packages/core/src/claude-tui.ts': 'phase 7',
  'packages/ctl/src/types.ts': 'phase 7',
  'packages/ctl/src/session-pointer.ts': 'phase 7',
  'packages/ctl/src/client.ts': 'phase 7',
  'packages/ctl/src/commands/claude-session.ts': 'phase 7',
};

/**
 * Never checked, and not exemptions — these are correctly agent-named.
 *
 *  - `apps/cli/src/agents/<id>/` is an agent's OWN folder. It is not a package
 *    yet (phase 2), but the names in it are already scoped to their agent.
 *  - ctl's scrapers are a ctl-internal table keyed by agent id. ctl is baked
 *    into the box image and must never import an agent package, so this is the
 *    one place the plan says stays.
 */
const NOT_APPLICABLE = [
  'apps/cli/src/agents/',
  'packages/ctl/src/claude-scraper.ts',
  'packages/ctl/src/codex-scraper.ts',
  // `codexAddUrl` here is the Codex.app `codex://` deep link — the DESKTOP APP,
  // sitting among herdr, cmux, vscode and finder. Renaming it would be wrong,
  // which is why this is an exclusion and not an exemption. The union guard in
  // `no-inline-agent-union.test.ts` carves this same file out for the same
  // reason.
  'apps/cli/src/commands/_open-in.ts',
];

// Both cases: `stageClaudeStatic` and `claudeLoginBinding` are the same
// mistake, and the lowercase form is the one that hid — `claudeLoginBinding`
// sat in the shared CLI until it was looked for by hand.
const EXPORTED_AGENT_NAME =
  /^export\s+(?:type\s+|interface\s+|const\s+|let\s+|function\s+|class\s+|abstract\s+class\s+|async\s+function\s+)?[A-Za-z_]*(?:claude|codex|opencode|Claude|Codex|Opencode|OpenCode|CLAUDE|CODEX|OPENCODE)/;

function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/** Strip comments so prose about an agent doesn't read as a declaration. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

function offendingFiles(): string[] {
  const found = new Set<string>();
  for (const root of ROOTS) {
    for (const file of walk(join(REPO, root))) {
      const rel = file.slice(REPO.length + 1);
      if (NOT_APPLICABLE.some((p) => rel.startsWith(p))) continue;
      const src = stripComments(readFileSync(file, 'utf8'));
      if (src.split('\n').some((l) => EXPORTED_AGENT_NAME.test(l))) found.add(rel);
    }
  }
  return [...found].sort();
}

describe('no agent-named exports outside an agent package', () => {
  it('has source to scan (the walk itself can silently find nothing)', () => {
    expect(ROOTS.flatMap((r) => walk(join(REPO, r))).length).toBeGreaterThan(200);
  });

  it('introduces no new one', () => {
    const unlisted = offendingFiles().filter((f) => !(f in ALLOWLIST));
    // If you are here: name the export for its ROLE, and put the agent-specific
    // part on the agent's spec row or in `packages/agent-<id>/`. Adding a line
    // to ALLOWLIST is for a file the refactor has not reached, not for new code.
    expect(unlisted).toEqual([]);
  });

  it('keeps no stale exemption — the list can only shrink', () => {
    const offenders = new Set(offendingFiles());
    const stale = Object.keys(ALLOWLIST).filter((f) => !offenders.has(f));
    // A file that no longer exports an agent-named symbol must leave the list,
    // or the exemption outlives the problem and the guard quietly weakens.
    expect(stale).toEqual([]);
  });

  it('names the owning phase for every exemption', () => {
    for (const [file, phase] of Object.entries(ALLOWLIST)) {
      expect(phase, file).toMatch(/^phase /);
    }
  });
});
