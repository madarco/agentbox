// Presentation helpers for the System / Build page — pure so they can be
// unit-tested without a running hub. The route assembles the raw facts (env
// version, deploy record, prepared-state bake records, freshness); these shape
// them for display and answer "do I need to re-bake?".

// The deploy record's `source` (mirrors HubDeploySource in @agentbox/sandbox-core;
// structural so this file pulls in no package). `package` = an npm install on the
// box; `source` = the monorepo cloned + built on the box.
export type HubDeploySourceLike =
  | { kind: 'package'; spec: string }
  | { kind: 'source'; repoUrl: string; repoRef: string };

export interface HubBuild {
  /** The running version (from AGENTBOX_CLI_VERSION), or null when unknown. */
  version: string | null;
  /** `nightly` / `stable`, or `source (<ref>)` for a build-from-source box. */
  channel: string | null;
  /** Human build line, e.g. `@madarco/agentbox@0.28.0 (npm)`. */
  build: string | null;
}

// The prerelease marker that classifies a build as nightly (mirrors
// channelOfVersion in apps/cli/src/lib/channel.ts). Inlined — a one-substring
// check isn't worth importing the CLI.
const NIGHTLY_MARKER = '-nightly.';

/**
 * Reconcile the running version with what the deploy record says was deployed.
 * The live version (env) is authoritative for `version`/`channel`; the record's
 * `source` supplies the human build line and, for a source build, the channel is
 * the ref the user actually tracks (`nightly`, `main`, a feature branch). Pure so
 * the precedence is testable — a small, hub-side echo of `describeRemoteHubBuild`.
 */
export function describeHubBuild(input: {
  version: string | null;
  source?: HubDeploySourceLike | null;
}): HubBuild {
  const source = input.source ?? null;
  const build = source
    ? source.kind === 'package'
      ? `@madarco/agentbox@${source.spec} (npm)`
      : `${source.repoUrl}@${source.repoRef} (built from source)`
    : null;
  const channel =
    source?.kind === 'source'
      ? `source (${source.repoRef})`
      : input.version
        ? input.version.includes(NIGHTLY_MARKER)
          ? 'nightly'
          : 'stable'
        : null;
  return { version: input.version, channel, build };
}

// ── box-image contents (what is baked in) ──────────────────────────────────
// The box image build context is the honest manifest of "skills / agents / config
// baked into the image": the setup skill, the custom system prompt, the agent
// hook/settings files, the runtime scripts, and the base (Dockerfile + ctl). Each
// context file feeds the invalidation fingerprint, so listing them explains what a
// re-bake would pick up.

export interface ImageContentGroup {
  category: string;
  files: { path: string; label: string }[];
}

// Human labels for the well-known context-file keys (DOCKER_CONTEXT_FILE_MAP).
const FILE_LABELS: Record<string, string> = {
  'Dockerfile.box': 'Box image Dockerfile',
  'ctl/bin.cjs': 'In-box supervisor (agentbox-ctl)',
  'share/agentbox-setup/SKILL.md': 'agentbox-setup skill',
  'scripts/custom-system-CLAUDE.md': 'Custom system prompt (Claude)',
  'scripts/claude-managed-settings.json': 'Claude managed settings',
  'scripts/agentbox-codex-hooks.json': 'Codex hooks',
  'scripts/agentbox-vnc-start': 'VNC start script',
  'scripts/agentbox-dockerd-start': 'dockerd start script',
  'scripts/agentbox-checkpoint-cleanup': 'Checkpoint cleanup script',
  'scripts/agentbox-open': 'agentbox-open helper',
};

const AGENT_CONFIG_KEYS = new Set([
  'share/agentbox-setup/SKILL.md',
  'scripts/custom-system-CLAUDE.md',
  'scripts/claude-managed-settings.json',
  'scripts/agentbox-codex-hooks.json',
]);
const BASE_KEYS = new Set(['Dockerfile.box', 'ctl/bin.cjs']);

function labelFor(key: string): string {
  return FILE_LABELS[key] ?? (key.split('/').pop() ?? key);
}

/**
 * Bucket the context-file keys into display categories, preserving a fixed
 * category order and dropping empty categories. A key that matches neither the
 * agent-config nor base set is a runtime script.
 */
export function groupImageContents(keys: string[]): ImageContentGroup[] {
  const agent: ImageContentGroup['files'] = [];
  const scripts: ImageContentGroup['files'] = [];
  const base: ImageContentGroup['files'] = [];
  for (const key of [...keys].sort()) {
    const file = { path: key, label: labelFor(key) };
    if (AGENT_CONFIG_KEYS.has(key)) agent.push(file);
    else if (BASE_KEYS.has(key)) base.push(file);
    else scripts.push(file);
  }
  return (
    [
      { category: 'Agent config & skills', files: agent },
      { category: 'Runtime scripts', files: scripts },
      { category: 'Base image', files: base },
    ] satisfies ImageContentGroup[]
  ).filter((g) => g.files.length > 0);
}

// ── provider bake status ────────────────────────────────────────────────────
// One provider's baked-base record, merged from prepared-state (fingerprint,
// which CLI baked it, when) and freshness (does it still match the current build
// context, and if not why). This is the "do I need to re-bake?" row.

export interface ProviderBake {
  id: string;
  label: string;
  /** A base bake record exists on disk. */
  baked: boolean;
  /** Short (12-char) fingerprint of the build context the base was baked from. */
  fingerprint?: string;
  /** CLI version that produced the bake. */
  cliVersion?: string;
  /** ISO timestamp of the bake. */
  bakedAt?: string;
  /** Provider-opaque image identifier (docker tag / snapshot id / image id). */
  imageRef?: string;
  /** Freshness vs the current build context (when the host backend computed it). */
  baseStatus?: 'fresh' | 'stale' | 'unprepared' | 'unknown';
  /** Why it is stale — the actionable part. */
  baseStaleReason?: string;
}

/** A short, plain-English verdict for a provider's bake state. */
export function bakeVerdict(p: ProviderBake): { tone: 'ok' | 'warn' | 'muted'; text: string } {
  if (p.baseStatus === 'stale') {
    return { tone: 'warn', text: 'Re-bake needed — build context changed since this base was baked.' };
  }
  if (!p.baked || p.baseStatus === 'unprepared') {
    return { tone: 'muted', text: 'Not baked yet — the next create (or a manual bake) will build it.' };
  }
  if (p.baseStatus === 'fresh') return { tone: 'ok', text: 'Baked and up to date with the current build context.' };
  return { tone: 'ok', text: 'Baked.' };
}
