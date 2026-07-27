// GET /api/v1/system — "what is running here, and do I need to re-bake?". Reports
// the hub's version + build/channel/source, the deploy record (when this machine
// is an exposed/deployed control box), each provider's baked-base record with its
// fingerprint and freshness, and the box-image build-context manifest (what skills
// / agents / config are baked in). Read-only.
//
// Freshness comes from the in-process host backend (backend.providersWithFreshness).
// The prepared-state reads, deploy record, and build-context manifest come from
// `globalThis.__AGENTBOX_HUB_SYSTEM` — set by server.ts, which reads them from
// @agentbox/sandbox-core in its OWN scope. This route must NOT import
// @agentbox/sandbox-core directly: it depends on execa (serverExternalPackages),
// and a route-level runtime import ERR_MODULE_NOT_FOUNDs in the standalone build
// (turbopack emits a mangled execa external). The seam mirrors __AGENTBOX_HUB_CUSTODY.
import { hubProfile } from '@/lib/auth-config';
import type { ProviderOption } from '@/lib/boxes/types';
import { describeHubBuild, isBaked, type ProviderBake } from '@/lib/system-info';
import { backendOrNull } from '../lib/backend';
import { ok } from '../lib/envelope';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Providers that bake a single base snapshot. remote-docker is excluded — it bakes
// per host alias (no single base record), so it belongs on the settings page, not
// the "is the base fresh?" table.
const BASE_PROVIDERS = ['docker', 'daytona', 'hetzner', 'vercel', 'e2b', 'digitalocean'] as const;
const PROVIDER_LABELS: Record<string, string> = {
  docker: 'Docker',
  daytona: 'Daytona',
  hetzner: 'Hetzner',
  vercel: 'Vercel',
  e2b: 'E2B',
  digitalocean: 'DigitalOcean',
};

type DeployRecordView = NonNullable<
  ReturnType<NonNullable<typeof globalThis.__AGENTBOX_HUB_SYSTEM>['deployRecord']>
>;

export async function GET(): Promise<Response> {
  const version = process.env.AGENTBOX_CLI_VERSION ?? null;
  const commit = process.env.AGENTBOX_CLI_COMMIT ?? null;

  // The system seam (@agentbox/sandbox-core reads, in server.ts scope). Absent on
  // the plane / Postgres path — the route then degrades: no deploy record, nothing
  // baked, an empty image manifest, exactly like custody's not-enabled path.
  const sys = globalThis.__AGENTBOX_HUB_SYSTEM;
  const record = sys?.deployRecord() ?? null;
  const build = describeHubBuild({ version, source: record?.source ?? null });

  // Freshness (baseStatus/baseStaleReason) is only available on the in-process
  // host backend — same limitation as GET /providers?freshness=1. Absent → the
  // prepared record alone tells us baked-or-not, just not fresh-or-stale.
  const backend = backendOrNull();
  const freshness = new Map<string, Pick<ProviderOption, 'baseStatus' | 'baseStaleReason'>>();
  if (backend) {
    try {
      for (const p of await backend.providersWithFreshness()) {
        freshness.set(p.id, { baseStatus: p.baseStatus, baseStaleReason: p.baseStaleReason });
      }
    } catch {
      // Best-effort — leave freshness empty; the bake records still render.
    }
  }

  const providers: ProviderBake[] = BASE_PROVIDERS.map((id) => {
    const prepared = sys?.preparedBase(id) ?? null;
    const f = freshness.get(id);
    // Freshness (when the in-process backend computed it) is authoritative about
    // whether the base exists: only `unprepared` means no stored base. `unknown`
    // still has a stored fingerprint — baked, just not freshness-verifiable — so
    // it stays baked and keeps its metadata. Absent freshness (the plane read
    // path) → fall back to whether a bake record exists. See isBaked().
    const baked = isBaked(f?.baseStatus, prepared !== null);
    const rec = baked ? prepared : null;
    return {
      id,
      label: PROVIDER_LABELS[id] ?? id,
      baked,
      fingerprint: rec?.fingerprint,
      cliVersion: rec?.cliVersion,
      bakedAt: rec?.bakedAt,
      imageRef: rec?.imageRef,
      baseStatus: f?.baseStatus,
      baseStaleReason: f?.baseStaleReason,
    };
  });

  return ok({
    hub: { version, commit, profile: hubProfile(), apiVersion: 'v1' },
    build,
    deploy: deployView(record),
    providers,
    imageContextKeys: sys?.imageContextKeys() ?? [],
  });
}

// The page's deploy panel: the non-sensitive fields only (the seam already
// whitelisted them; here we just drop the build `source`, which feeds `build`).
function deployView(record: DeployRecordView | null): {
  provider?: string;
  url?: string;
  publicUrl?: string;
  tunnel?: string;
  autostart?: boolean;
  port?: number;
  bind?: string;
} | null {
  if (!record) return null;
  return {
    provider: record.provider,
    url: record.url,
    publicUrl: record.publicUrl,
    tunnel: record.tunnel,
    autostart: record.autostart,
    port: record.port,
    bind: record.bind,
  };
}
