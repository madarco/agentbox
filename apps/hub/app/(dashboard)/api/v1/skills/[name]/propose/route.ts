// POST /api/v1/skills/{name}/propose — propose a skill written in a box for the
// library (docs/hub-skills-plan.md, Phase 7). Body: the skill's gzip tarball.
// `X-AgentBox-Skill-Proposal` header: base64 JSON `{ box: {id, name}, agent?,
// source? }`. The hub reads the tarball itself (tree hash, frontmatter, secret
// scan) and parks one approval; the answer is `pending` (or `unchanged` when
// the library already has this version). Nothing is stored until a human
// approves it.
import { fail, ok } from '../../../lib/envelope';
import { failFromSkills } from '../../_service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PROPOSAL_HEADER = 'x-agentbox-skill-proposal';
/** Custody's streaming default, when the hub sets no cap of its own. */
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;

const shortStr = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined;

async function readCapped(body: ReadableStream<Uint8Array>, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ name: string }> },
): Promise<Response> {
  const proposals = globalThis.__AGENTBOX_HUB_SKILL_PROPOSALS;
  if (!proposals) return fail('backend_unavailable', 'skill proposals are not enabled on this hub');
  const { name } = await ctx.params;
  const raw = req.headers.get(PROPOSAL_HEADER);
  if (!raw) return fail('invalid_request', `missing ${PROPOSAL_HEADER} header`);
  let meta: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    meta = parsed as Record<string, unknown>;
  } catch {
    return fail('invalid_request', `${PROPOSAL_HEADER} must be base64-encoded JSON`);
  }
  const box = (meta.box ?? {}) as Record<string, unknown>;
  const boxId = shortStr(box.id, 200);
  const boxName = shortStr(box.name, 200);
  if (!boxId || !boxName) return fail('invalid_request', 'the proposal must name its box');
  const src = (meta.source ?? {}) as Record<string, unknown>;
  const source = {
    host: shortStr(src.host, 512) ?? `box ${boxName}`,
    ...(shortStr(src.machineId, 512) ? { machineId: shortStr(src.machineId, 512)! } : {}),
    ...(shortStr(src.path, 512) ? { path: shortStr(src.path, 512)! } : {}),
  };
  if (!req.body) return fail('invalid_request', 'expected a tarball request body');
  // The smaller of custody's blob cap and the proposal cap: a proposal's
  // tarball waits in memory until someone answers it.
  const max = Math.min(
    globalThis.__AGENTBOX_HUB_CUSTODY_MAX_BLOB_BYTES ?? DEFAULT_MAX_BYTES,
    proposals.maxBytes,
  );
  const tarball = await readCapped(req.body, max);
  if (!tarball) {
    return fail(
      'invalid_request',
      `the skill is too large to propose from a box (its files may total ${String(Math.round(proposals.contentMaxBytes / 1024 / 1024))} MiB at most). Add a skill that large from a PC with \`agentbox skills\` instead.`,
    );
  }
  try {
    const agent = shortStr(meta.agent, 64);
    return ok(
      await proposals.propose({
        name,
        tarball,
        box: { id: boxId, name: boxName },
        ...(agent ? { agent } : {}),
        source,
      }),
    );
  } catch (err) {
    return failFromSkills(err, 'skill proposal failed');
  }
}
