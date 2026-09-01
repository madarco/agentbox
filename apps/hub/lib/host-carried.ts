/**
 * What this machine actually hands to a box.
 *
 * The System page used to list `DOCKER_CONTEXT_FILE_MAP` — the ten files
 * agentbox itself bakes into the image — which tells a user nothing about their
 * own setup. The question worth answering is "which of MY agent configs and
 * skills will a box get?", and the honest answer is only the paths that exist:
 * every consumer of these paths (`sync/agents/*`, `host-stage.ts`,
 * `buildIdentityMounts`) gates on existence, so a path that isn't here is a path
 * a box will not receive.
 *
 * Deliberately NOT a new hardcoded list: the source of truth is
 * `AGENT_SYNC_SPECS` in @agentbox/sandbox-core, the same registry the sync layer
 * walks. Three paths the create path checks outside the registry (`~/.agents`,
 * `~/.claude.json`, `~/.gitconfig`) are added explicitly.
 *
 * Runs in the custom server's scope (outside Next's bundle) and is handed to the
 * route as plain data — see the `__AGENTBOX_HUB_SYSTEM` seam.
 *
 * Note on a deployed control box: `homedir()` there is the VPS's home, not the
 * laptop's. That is why the UI calls this "carried from this machine" — the
 * answer is correct on both, and on a control box it is exactly what a
 * hub-created box would receive.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type CarriedKind = 'skills' | 'config' | 'identity';

export interface CarriedEntry {
  /** Agent this belongs to (`claude` / `codex` / `opencode`), or `host`. */
  agent: string;
  label: string;
  /** Absolute path on this machine. */
  hostPath: string;
  kind: CarriedKind;
  /** Skill directory names, for a skills entry. */
  skills?: string[];
}

/** A spec shaped like `AGENT_SYNC_SPECS[]` — structurally typed to stay decoupled. */
export interface AgentSpecLike {
  id: string;
  staticPaths: readonly { hostHomeRel: readonly string[] }[];
}

export interface CollectOptions {
  home?: string;
  /** Seam for tests; defaults to the real fs. */
  exists?: (p: string) => boolean;
  /** Immediate child directory names of `p`, or [] when unreadable. */
  childDirs?: (p: string) => string[];
}

/**
 * Drop dot-directories: they are machinery, not skills. Codex ships `.system`
 * and `.cursor` turns up under `~/.agents/skills`; counting them inflates the
 * "N skills" badge with things the user never wrote.
 */
export function filterSkillNames(names: string[]): string[] {
  return names.filter((n) => !n.startsWith('.')).sort();
}

function realChildDirs(p: string): string[] {
  try {
    return filterSkillNames(
      readdirSync(p).filter((name) => {
        try {
          // statSync (not lstat) so a symlinked skill dir — the shape
          // `~/.claude/skills/x -> ../../.agents/skills/x` produces — still counts.
          return statSync(join(p, name)).isDirectory();
        } catch {
          return false;
        }
      }),
    );
  } catch {
    return [];
  }
}

const AGENT_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
};

/** Human label for a `~`-relative path, e.g. `.local/share/opencode` → `~/.local/share/opencode`. */
function tildePath(rel: readonly string[]): string {
  return `~/${rel.join('/')}`;
}

/**
 * Present-only list of what a box would receive from this machine.
 *
 * `specs` is passed in rather than imported so this module stays free of
 * `@agentbox/*` (and therefore of execa) — the caller in `server.ts` supplies
 * `AGENT_SYNC_SPECS`.
 */
export function collectHostCarried(
  specs: readonly AgentSpecLike[],
  opts: CollectOptions = {},
): CarriedEntry[] {
  const home = opts.home ?? homedir();
  const exists = opts.exists ?? existsSync;
  const childDirs = opts.childDirs ?? realChildDirs;
  const out: CarriedEntry[] = [];

  // `~/.agents` is the shared skills volume — the one most users mean by "my
  // skills". Checked by create.ts before the volume is even mounted.
  const agentsDir = join(home, '.agents');
  if (exists(agentsDir)) {
    const skillsDir = join(agentsDir, 'skills');
    out.push({
      agent: 'agents',
      label: 'Shared agent skills',
      hostPath: '~/.agents',
      kind: 'skills',
      ...(exists(skillsDir) ? { skills: childDirs(skillsDir) } : {}),
    });
  }

  // OpenCode is enabled by its CONFIG or DATA dir only (create.ts's `wantOpencode`);
  // `~/.local/state/opencode` rides along but never enables the volume on its own.
  // Listing it from a host that has only the state dir would promise a box
  // something create never mounts.
  const opencodeEnabled =
    exists(join(home, '.config', 'opencode')) || exists(join(home, '.local', 'share', 'opencode'));

  for (const spec of specs) {
    if (spec.id === 'opencode' && !opencodeEnabled) continue;
    for (const sp of spec.staticPaths) {
      const abs = join(home, ...sp.hostHomeRel);
      if (!exists(abs)) continue;
      const skillsDir = join(abs, 'skills');
      const isSkillHost = exists(skillsDir);
      out.push({
        agent: spec.id,
        label: AGENT_LABELS[spec.id] ?? spec.id,
        hostPath: tildePath(sp.hostHomeRel),
        kind: isSkillHost ? 'skills' : 'config',
        ...(isSkillHost ? { skills: childDirs(skillsDir) } : {}),
      });
    }
  }

  // Outside the registry: read by claude.ts (`~/.claude.json`) and by
  // buildIdentityMounts (`~/.gitconfig`, the only identity file carried —
  // ~/.ssh and ~/.netrc deliberately never leave the host).
  for (const [rel, label, kind] of [
    ['.claude.json', 'Claude project config', 'config'],
    ['.gitconfig', 'Git identity', 'identity'],
  ] as const) {
    if (exists(join(home, rel))) {
      out.push({
        agent: rel === '.gitconfig' ? 'host' : 'claude',
        label,
        hostPath: `~/${rel}`,
        kind,
      });
    }
  }

  return out;
}
