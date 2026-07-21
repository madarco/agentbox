// GET /api/v1/open-targets — which host apps this hub can launch a box in, and
// whether it can at all (`supported`). Backs the detail-page "Open in" menu.
// A remote hub / no in-process backend reports `supported: false`.
import { backendOrNull } from '../lib/backend';
import { ok } from '../lib/envelope';
import type { OpenTargets } from '@/lib/boxes/backend-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const backend = backendOrNull();
  const result: OpenTargets = backend
    ? await backend.openTargets()
    : { supported: false, targets: null };
  return ok(result);
}
