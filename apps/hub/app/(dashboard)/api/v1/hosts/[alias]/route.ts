// DELETE /api/v1/hosts/:alias — forget a remote-docker host alias (drops it from
// the registry + baked-image record, clears the global default if it pointed
// here). Local record only — the remote machine/containers are untouched. Returns
// the box names created against the alias (now unreachable) so the caller can warn.
import { backendOrNull } from '../../lib/backend';
import { fail, ok } from '../../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ alias: string }> },
): Promise<Response> {
  const { alias } = await ctx.params;
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  // The backend remove is idempotent; answer a genuinely-unknown alias with 404.
  const hosts = await backend.listRemoteDockerHosts();
  if (!hosts.some((h) => h.alias === alias)) {
    return fail('not_found', `unknown host alias ${alias}`);
  }

  const res = await backend.removeRemoteDockerHost(alias);
  if (!res.ok) return fail('conflict', res.error);
  return ok({ ok: true, boxesAffected: res.boxesAffected });
}
