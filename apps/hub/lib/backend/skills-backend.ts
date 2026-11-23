// The skills-library operations that need more than custody (docs/hub-skills-plan.md,
// Phase 5): hub-side git and marketplace fetches, version diffs, and the
// `skills.sync` fan-out to running boxes. They run in the custom server's scope
// as part of the host backend, because the routes can't import
// @agentbox/sandbox-core (execa) in the standalone build.
import {
  addFromGit,
  addFromMarketplace,
  parseGitSpec,
  refreshAllSkills,
  refreshSkill,
  type AddOpts,
  type AddResult,
  type MarketplaceSpec,
  type RefreshOutcome,
  type SourceDeps,
} from './skill-sources';
import { diffSkillVersions, type SkillDiff } from './skill-diff';
import { syncSkillBoxes, type SkillBoxesDeps, type SkillSyncOutcome } from './skill-boxes';
import {
  approveSkillUpdate,
  resolveSkillVersion,
  readMeta,
  SkillsError,
  type SkillsStore,
  type SkillSummary,
} from './skills';

export interface AddSkillsInput extends AddOpts {
  git?: { url: string; ref?: string; path?: string };
  marketplace?: MarketplaceSpec;
}

export interface SkillsBackend {
  /** Fetch a git repo or a marketplace plugin and import its skills. Throws `SkillsError`. */
  addSkills(input: AddSkillsInput, opts?: { allowFile?: boolean }): Promise<AddResult>;
  /** Re-fetch git/marketplace skills (all of them when `names` is absent). */
  refreshSkills(names?: string[], opts?: { allowFindings?: boolean }): Promise<RefreshOutcome[]>;
  /** Apply pending versions and sync the boxes that hold them. */
  approveSkills(
    names: string[],
  ): Promise<{ applied: { name: string; from: string; to: string; skill: SkillSummary }[] }>;
  skillDiff(name: string, opts?: { from?: string; to?: string }): Promise<SkillDiff>;
  syncSkillBoxes(opts?: { boxIds?: string[]; names?: string[] }): Promise<SkillSyncOutcome[]>;
  /**
   * `current` moved for these skills: sync every running box behind on them.
   * Fire-and-forget; the route has already answered.
   */
  skillsChanged(names: string[]): void;
}

export interface SkillsBackendDeps extends Omit<SkillBoxesDeps, 'store'> {
  store(): SkillsStore | null;
  maxTarballBytes?(): number | undefined;
}

function storeOrThrow(deps: SkillsBackendDeps): SkillsStore {
  const s = deps.store();
  if (!s) throw new SkillsError('invalid_request', 'custody is not enabled on this hub');
  return s;
}

export function createSkillsBackend(deps: SkillsBackendDeps): SkillsBackend {
  const sourceDeps = (extra: Partial<SourceDeps> = {}): SourceDeps => {
    const max = deps.maxTarballBytes?.();
    return {
      store: storeOrThrow(deps),
      ...(max !== undefined ? { maxTarballBytes: max } : {}),
      ...extra,
    };
  };
  const boxDeps = (): SkillBoxesDeps => ({ ...deps, store: storeOrThrow(deps) });
  const fanOut = (names: string[]): void => {
    if (names.length === 0) return;
    void syncSkillBoxes(boxDeps(), { names })
      .then((r) => {
        const synced = r.filter((o) => o.status === 'synced').length;
        if (r.length > 0) {
          deps.log(
            `skills: ${names.join(', ')} changed; synced ${String(synced)}/${String(r.length)} box(es)`,
          );
        }
      })
      .catch((err: unknown) =>
        deps.log(`skills: fan-out failed: ${err instanceof Error ? err.message : String(err)}`),
      );
  };
  return {
    async addSkills(input, opts = {}) {
      const d = sourceDeps({ allowFile: opts.allowFile === true });
      const addOpts: AddOpts = {
        ...(input.skills ? { skills: input.skills } : {}),
        ...(input.policy ? { policy: input.policy } : {}),
        ...(input.allowFindings ? { allowFindings: true } : {}),
        ...(input.dryRun ? { dryRun: true } : {}),
      };
      let res: AddResult;
      if (input.git) {
        const spec = parseGitSpec(
          input.git.url,
          {
            ...(input.git.ref ? { ref: input.git.ref } : {}),
            ...(input.git.path ? { path: input.git.path } : {}),
          },
          { allowFile: opts.allowFile === true },
        );
        res = await addFromGit(d, spec, addOpts);
      } else if (input.marketplace) {
        const m = input.marketplace;
        const spec = parseGitSpec(m.url, m.ref ? { ref: m.ref } : {}, {
          allowFile: opts.allowFile === true,
        });
        res = await addFromMarketplace(
          d,
          {
            marketplace: m.marketplace,
            plugin: m.plugin,
            url: spec.url,
            ...(spec.ref ? { ref: spec.ref } : {}),
          },
          addOpts,
        );
      } else {
        throw new SkillsError('invalid_request', 'body needs {git} or {marketplace}');
      }
      // Re-adding an existing skill can move its current version.
      fanOut(res.imported.filter((i) => i.currentChanged).map((i) => i.name));
      return res;
    },

    async refreshSkills(names, opts = {}) {
      const d = sourceDeps();
      const out = names
        ? await Promise.all(names.map((n) => refreshSkill(d, n, opts)))
        : await refreshAllSkills(d, opts);
      fanOut(out.filter((o) => o.status === 'applied').map((o) => o.name));
      return out;
    },

    async approveSkills(names) {
      const store = storeOrThrow(deps);
      const applied = [];
      for (const n of names) applied.push(await approveSkillUpdate(store, n));
      fanOut(applied.filter((a) => a.from !== a.to).map((a) => a.name));
      return { applied };
    },

    async skillDiff(name, opts = {}) {
      const store = storeOrThrow(deps);
      if (!(await readMeta(store, name))) {
        throw new SkillsError('not_found', `no skill '${name}' on this hub`);
      }
      const from = opts.from ? await resolveSkillVersion(store, name, opts.from) : undefined;
      const to = opts.to ? await resolveSkillVersion(store, name, opts.to) : undefined;
      return diffSkillVersions(store, name, { ...(from ? { from } : {}), ...(to ? { to } : {}) });
    },

    syncSkillBoxes: (opts = {}) => syncSkillBoxes(boxDeps(), opts),

    skillsChanged: fanOut,
  };
}
