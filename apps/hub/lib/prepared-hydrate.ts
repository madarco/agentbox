import { FsCustodyStore } from '@agentbox/relay/control-plane';
import {
  matchAgentInstallFingerprint,
  readPreparedStateRaw,
  writePreparedStateRaw,
} from '@agentbox/sandbox-core';

/**
 * Adopt a shared bake record from custody into this machine's prepared-state,
 * so a create can boot from it — and so the settings/freshness UI reflects it.
 *
 * The providers' "is it baked?" gates (`ensureE2bBaseTemplate` and friends) are
 * synchronous and read only local prepared-state, so a control box whose custody
 * holds a perfectly good record still looks unbaked: every create failed with
 * "run `agentbox prepare` first", and `/settings` shows "needs baking".
 * `hub deploy` seeds those records precisely so a fresh control box
 * need not re-bake — hydrating here is what makes that seeding mean anything.
 *
 * Same fingerprint-match-wins policy as `pullPreparedFromCustody` (see
 * sandbox-cloud/prepared-sync.ts); this reads the store directly because the hub
 * IS the custody host. Best-effort and side-effect-only-on-match: a record
 * matching neither install mode is left alone (the base stays "unprepared"
 * rather than falsely "fresh").
 *
 * `agentInstall` is the mode this machine would BAKE with; it no longer gates
 * which records are accepted (see the match below).
 */
export async function hydratePreparedFromCustody(
  custody: FsCustodyStore,
  providerName: string,
  provider: { baseFingerprint?: (i?: 'native' | 'npm') => Promise<string | undefined> },
  agentInstall: 'native' | 'npm',
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
    // `agentInstall` is folded into the fingerprint by `prepare`, and the record
    // does NOT carry the mode it was baked with — so match against BOTH modes
    // rather than only the one this machine happens to be configured for.
    //
    // That configured mode is the crux: `box.agentInstall` lives in the PC's
    // config.yaml and does not travel to a control box, which therefore defaults
    // to `native`. Comparing against the local mode alone rejected every
    // npm-baked record and failed every create with "run `agentbox prepare`
    // first" — on an identical build context. See `matchAgentInstallFingerprint`.
    const nativeFingerprint = await provider.baseFingerprint?.('native');
    if (!nativeFingerprint) return;
    const bakedWith = matchAgentInstallFingerprint(stored, nativeFingerprint);
    if (!bakedWith) {
      log(`prepared: the shared ${providerName} bake is from a different build context — ignoring it`);
      return;
    }
    writePreparedStateRaw(providerName, record);
    const note = bakedWith === agentInstall ? '' : ` (baked with agentInstall=${bakedWith})`;
    log(`prepared: adopted the shared ${providerName} base from custody (no bake needed)${note}`);
  } catch {
    // Best-effort: fall through to the provider's own "run prepare first" error.
  }
}
