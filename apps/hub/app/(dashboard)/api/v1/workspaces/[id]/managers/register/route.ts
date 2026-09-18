// POST /api/v1/workspaces/:id/managers/register — record a manager session
// another machine just opened in tmux. A manager runs where its folder is, so a
// hub with a control box configured starts the process locally and registers it
// HERE, where the workspace, its tasks and its timeline live.
//
// This and `POST /managers/{id}/heartbeat` are the only manager writes accepted
// from another host: everything else (start, resume, attach, stop, typing) needs
// the session's own machine and is refused with `wrong_host`.
import { backendOrNull } from '../../../../lib/backend';
import { timelineMeta } from '../../../../lib/actor';
import { fail, failFromManager, ok } from '../../../../lib/envelope';
import { MANAGER_AGENT_NAMES, parseManagerRegister, readJson } from '../../../../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  const body = await readJson(req);
  if (!body.ok) return fail('invalid_request', body.message);
  // The live registry when this hub has one (plugin agents included), minus the
  // service agents that have no session to attach to — the same accept-list the
  // start route applies. `installed` is NOT checked: the agent ran on the
  // caller's machine, and this one may not have it at all.
  const sys = globalThis.__AGENTBOX_HUB_SYSTEM;
  const allowedAgents = sys
    ? sys
        .agents()
        .filter((a) => a.surface !== 'service')
        .map((a) => a.id)
    : MANAGER_AGENT_NAMES;
  const parsed = parseManagerRegister(body.value, allowedAgents);
  if (!parsed.ok) return fail('invalid_request', parsed.message);
  const res = await backend.registerManager(
    id,
    parsed.value,
    await timelineMeta(req, backend, { wsId: id }),
  );
  if (!res.ok) return failFromManager(res);
  return ok(res.manager);
}
