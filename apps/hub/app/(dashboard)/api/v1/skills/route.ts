// GET /api/v1/skills — the hub's skills library: one row per stored skill
// (description, current version, size, file count, source PC, updated) plus
// `seeded`, which stays true after the last skill is discarded so the automatic
// first seed never refills a library the user emptied. Metadata only. Rows carry
// `origin`, `policy` and `pending` (a version waiting for approval).
//
// POST /api/v1/skills — add skills from a source the HUB fetches:
//   {git: {url, ref?, path?}} or {marketplace: {marketplace, url, ref?, plugin}},
//   plus skills? (names to import; default every one found), policy?
//   ('auto'|'manual'), allowFindings?, dryRun? (list what the source holds).
import { listSkills, parsePolicy } from '@/lib/backend/skills';
import { backendOrNull } from '../lib/backend';
import { fail, ok } from '../lib/envelope';
import {
  failFromSkills,
  fileGitAllowed,
  readJson,
  skillsStoreOrFail,
  stringList,
} from './_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const store = skillsStoreOrFail();
  if (store instanceof Response) return store;
  try {
    return ok(await listSkills(store));
  } catch (err) {
    return failFromSkills(err, 'skills list failed');
  }
}

export async function POST(req: Request): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const body = await readJson(req);
  if (!body) return fail('invalid_request', 'expected a JSON object body');
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 && v.length <= 2048 ? v : undefined;
  try {
    const git = body.git as Record<string, unknown> | undefined;
    const market = body.marketplace as Record<string, unknown> | undefined;
    const skills = stringList(body.skills);
    const input = {
      ...(skills ? { skills } : {}),
      ...(body.policy !== undefined ? { policy: parsePolicy(body.policy) } : {}),
      ...(body.allowFindings === true ? { allowFindings: true } : {}),
      ...(body.dryRun === true ? { dryRun: true } : {}),
    };
    if (git && typeof git === 'object' && str(git.url)) {
      return ok(
        await backend.addSkills(
          {
            ...input,
            git: {
              url: str(git.url)!,
              ...(str(git.ref) ? { ref: str(git.ref)! } : {}),
              ...(str(git.path) ? { path: str(git.path)! } : {}),
            },
          },
          { allowFile: fileGitAllowed(req) },
        ),
      );
    }
    if (market && typeof market === 'object' && str(market.url) && str(market.plugin)) {
      return ok(
        await backend.addSkills(
          {
            ...input,
            marketplace: {
              marketplace: str(market.marketplace) ?? str(market.url)!,
              url: str(market.url)!,
              plugin: str(market.plugin)!,
              ...(str(market.ref) ? { ref: str(market.ref)! } : {}),
            },
          },
          { allowFile: fileGitAllowed(req) },
        ),
      );
    }
    return fail('invalid_request', 'body needs {git: {url}} or {marketplace: {url, plugin}}');
  } catch (err) {
    return failFromSkills(err, 'skill add failed');
  }
}
