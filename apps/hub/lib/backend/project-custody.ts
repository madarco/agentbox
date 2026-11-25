// The custody slugs each project's files may sit under (`projects/<slug>/`),
// put on the Project payload so a client joins custody to projects without
// re-deriving repo keys. A PC writes the slug from its alias-expanded repo key
// (`repoKeyAtEdge`), so a project folder on THIS machine gets the same
// expansion; a registration carries the key its PC computed.
import { repoKeyAtEdge } from '@agentbox/sandbox-core';
import { seedSlugsFor } from '../boxes/seed-slug';

export interface ProjectCustodyDeps {
  /** Alias-expanded repo key of an origin on this machine. Default: `repoKeyAtEdge`. */
  repoKeyOf?: (originUrl: string) => Promise<string | undefined>;
}

export interface ProjectCustodySlugs {
  /** Slugs for a project folder on this machine (its origin is expanded here). */
  local(p: { originUrl?: string | null; projectSlug?: string | null }): Promise<string[]>;
  /** Slugs for a project known only from a box registration. */
  registered(reg: {
    originUrl?: string | null;
    projectSlug?: string | null;
    repoKey?: string | null;
  }): string[];
}

export function createProjectCustodySlugs(deps: ProjectCustodyDeps = {}): ProjectCustodySlugs {
  const repoKeyOf = deps.repoKeyOf ?? ((o: string) => repoKeyAtEdge(o));
  // `ssh -G` per origin is a process spawn; origins don't change under a
  // running hub often enough to matter, and getData() is the hot path.
  const cache = new Map<string, Promise<string | undefined>>();
  return {
    async local(p) {
      let repoKey: string | undefined;
      if (p.originUrl) {
        let hit = cache.get(p.originUrl);
        if (!hit) {
          hit = repoKeyOf(p.originUrl).catch(() => undefined);
          cache.set(p.originUrl, hit);
        }
        repoKey = await hit;
      }
      return seedSlugsFor({ ...p, repoKey });
    },
    registered: (reg) => seedSlugsFor(reg),
  };
}
