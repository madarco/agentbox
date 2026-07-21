// GET /api/v1/approvals — pending host-action approvals (the relay prompt mailbox).
import { readState } from '../lib/backend';
import { ok } from '../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const { approvals } = await readState();
  return ok({ approvals });
}
