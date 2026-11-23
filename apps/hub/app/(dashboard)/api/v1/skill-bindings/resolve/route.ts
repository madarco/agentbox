// GET /api/v1/skill-bindings/resolve?repo|projectKey&workspaceId&boxId — the
// library skills a box would get from the bindings alone (before create flags),
// each with `included` and `from` (box | project | workspace | global |
// default). `repo` is a git remote URL keyed on the hub; `projectKey` is a repo
// key computed by the caller (the CLI expands ~/.ssh/config aliases first).
// `library: false` means the library was never seeded.
import { previewSkillSet } from '@/lib/backend/skill-bindings';
import { scopeIdProblem } from '@agentbox/core';
import { fail, ok } from '../../lib/envelope';
import { failFromSkills, skillsStoreOrFail } from '../../skills/_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const store = skillsStoreOrFail();
  if (store instanceof Response) return store;
  const q = new URL(req.url).searchParams;
  const pick = (k: string): string | undefined => q.get(k) || undefined;
  const input = {
    repo: pick('repo'),
    projectKey: pick('projectKey'),
    workspaceId: pick('workspaceId'),
    boxId: pick('boxId'),
  };
  const bad =
    (input.projectKey && scopeIdProblem('project', input.projectKey)) ||
    (input.workspaceId && scopeIdProblem('workspace', input.workspaceId)) ||
    (input.boxId && scopeIdProblem('box', input.boxId)) ||
    (input.repo && input.repo.length > 1024 ? 'repo is too long' : null);
  if (bad) return fail('invalid_request', bad);
  try {
    return ok(
      await previewSkillSet(store, {
        ...(input.repo ? { repo: input.repo } : {}),
        ...(input.projectKey ? { projectKey: input.projectKey } : {}),
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        ...(input.boxId ? { boxId: input.boxId } : {}),
      }),
    );
  } catch (err) {
    return failFromSkills(err, 'skill set preview failed');
  }
}
