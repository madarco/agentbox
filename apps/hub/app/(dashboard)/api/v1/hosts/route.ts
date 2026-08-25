// GET /api/v1/hosts — the registered remote-docker host aliases (alias -> SSH
// connection, with baked/default state). POST /api/v1/hosts — register a new
// alias: validates + probes the host (ssh + docker) before saving. No image bake
// (that would block for minutes; the image builds on first create, or via
// POST /providers/remote-docker/prepare). Mutations need the in-process backend.
//
// A POST may carry `connection` (the sender's `ssh -G` expansion) and `identity`
// (a private key minted FOR this hub). That is how a PC shares one of its own
// engines with a control box, which has neither the sender's `~/.ssh/config` nor
// their agent. The probe then runs with that key, so a 201 means this machine can
// really reach the engine — not that the sender could.
import { backendOrNull } from '../lib/backend';
import { fail, ok } from '../lib/envelope';
import { parseHostUpsert } from '../lib/validate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');
  return ok({ hosts: await backend.listRemoteDockerHosts() });
}

export async function POST(req: Request): Promise<Response> {
  const backend = backendOrNull();
  if (!backend) return fail('backend_unavailable', 'hub backend unavailable (run the hub server)');

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail('invalid_request', 'body must be valid JSON');
  }
  const parsed = parseHostUpsert(body);
  if (!parsed.ok) return fail('invalid_request', parsed.message, parsed.details);

  const res = await backend.addRemoteDockerHost(parsed.value.alias, parsed.value.ssh, {
    default: parsed.value.default,
    ...(parsed.value.connection ? { connection: parsed.value.connection } : {}),
    ...(parsed.value.identity ? { identity: parsed.value.identity } : {}),
  });
  if (!res.ok) {
    // "already exists" is a conflict; an unreachable host / missing docker is a
    // client-input problem → 400.
    if (/already exists/i.test(res.error)) return fail('conflict', res.error);
    return fail('invalid_request', res.error);
  }
  return ok({ ok: true }, 201);
}
