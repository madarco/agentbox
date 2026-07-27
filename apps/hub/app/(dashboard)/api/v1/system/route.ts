// GET /api/v1/system — "what is running here, and do I need to re-bake?". Reports
// the hub's version + build/channel/source, the deploy record (when this machine
// is an exposed/deployed control box), each provider's baked-base record with its
// fingerprint and freshness, and the box-image build-context manifest (what skills
// / agents / config are baked in). Read-only.
//
// Reuses the same freshness the settings page reads (backend.providersWithFreshness)
// rather than recomputing it, and reads prepared-state + the deploy record directly
// — the hub IS the host that holds them. @agentbox/sandbox-core is externalized
// (next.config serverExternalPackages), so importing it in a nodejs route is safe.
import { readFile } from 'node:fs/promises';
import {
  DOCKER_CONTEXT_FILE_MAP,
  controlPlaneDeployPath,
  readPreparedStateRaw,
  shortFingerprint,
  type ControlPlaneDeployRecord,
  type PreparedBaseSnapshot,
} from '@agentbox/sandbox-core';
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

interface PreparedBaseFields {
  fingerprint?: string;
  cliVersion?: string;
  bakedAt?: string;
  imageRef?: string;
}

function preparedBaseOf(provider: string): PreparedBaseFields | null {
  const raw = readPreparedStateRaw(provider) as PreparedBaseSnapshot | null;
  const base = raw?.base;
  if (!base) return null;
  return {
    fingerprint: base.contextSha256 ? shortFingerprint(base.contextSha256) : undefined,
    cliVersion: base.cliVersion,
    bakedAt: base.createdAt,
    imageRef: base.imageRef != null ? String(base.imageRef) : undefined,
  };
}

async function readDeployRecord(): Promise<ControlPlaneDeployRecord | null> {
  try {
    return JSON.parse(await readFile(controlPlaneDeployPath(), 'utf8')) as ControlPlaneDeployRecord;
  } catch {
    return null; // no deploy record on this machine (a plain hub / a VPS the record lives off)
  }
}

export async function GET(): Promise<Response> {
  const version = process.env.AGENTBOX_CLI_VERSION ?? null;
  const commit = process.env.AGENTBOX_CLI_COMMIT ?? null;

  const record = await readDeployRecord();
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
    const prepared = preparedBaseOf(id);
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
    imageContextKeys: Object.keys(DOCKER_CONTEXT_FILE_MAP),
  });
}

// Whitelist the non-sensitive deploy fields for the page. Excludes the SSH key
// dir, server/firewall ids, and the admin CIDR — operational detail the CLI owns,
// not something the build page needs.
function deployView(record: ControlPlaneDeployRecord | null): {
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
