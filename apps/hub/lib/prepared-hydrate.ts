import { FsCustodyStore } from '@agentbox/relay/control-plane';
import { readPreparedStateRaw, writePreparedStateRaw } from '@agentbox/sandbox-core';

/**
 * Adopt a shared bake record from custody into this machine's prepared-state,
 * so a create can boot from it — and so the settings/freshness UI reflects it.
 *
 * The providers' "is it baked?" gates (`ensureE2bBaseTemplate` and friends) are
 * synchronous and read only local prepared-state, so a control box whose custody
 * holds a perfectly good record still looks unbaked: every create failed with
 * "run `agentbox prepare` first", and `/settings` shows "needs baking".
 * `control-plane deploy` seeds those records precisely so a fresh control box
 * need not re-bake — hydrating here is what makes that seeding mean anything.
 *
 * Same fingerprint-match-wins policy as `pullPreparedFromCustody` (see
 * sandbox-cloud/prepared-sync.ts); this reads the store directly because the hub
 * IS the custody host. Best-effort and side-effect-only-on-match: a mismatching
 * record is left alone (the base stays "unprepared" rather than falsely "fresh").
 */
export async function hydratePreparedFromCustody(
  custody: FsCustodyStore,
  providerName: string,
  provider: { baseFingerprint?: (i?: 'native' | 'npm') => Promise<string | undefined> },
  claudeInstall: 'native' | 'npm',
  log: (l: string) => void,
): Promise<void> {
  if (providerName === 'docker') return; // local image, not a shareable snapshot
  try {
    const local = readPreparedStateRaw(providerName) as { base?: unknown } | null;
    if (local?.base) return;
    const found = await custody.get(`prepared/${providerName}.json`).catch(() => null);
    if (!found) return;
    const record = JSON.parse(found.data.toString('utf8')) as {
      base?: { contextSha256?: string };
    };
    const stored = record.base?.contextSha256;
    if (!stored) return;
    // `claudeInstall` is folded into the fingerprint by `prepare`, so omitting
    // it makes an npm-baked base read as stale and rejects a record that in fact
    // matches. Must be the mode this machine would bake with.
    const fingerprint = await provider.baseFingerprint?.(claudeInstall);
    if (!fingerprint) return;
    if (stored !== fingerprint) {
      log(`prepared: the shared ${providerName} bake is from a different build context — ignoring it`);
      return;
    }
    writePreparedStateRaw(providerName, record);
    log(`prepared: adopted the shared ${providerName} base from custody (no bake needed)`);
  } catch {
    // Best-effort: fall through to the provider's own "run prepare first" error.
  }
}
