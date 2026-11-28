/**
 * This PC's logins and keys into a REMOTE hub's own account store
 * (docs/llm-accounts-plan.md, Phase 9: on a remote hub a subscription belongs
 * to the hub). The hub decides per item (dedupe by identity, a suffixed id on a
 * collision, newest-wins on the secret, `removed` for an account deleted on the
 * hub), so a PC holding a copy a hub box has since refreshed never puts it back.
 *
 * An older hub has no import route (404): callers fall back to the custody push.
 */
import { getMachineLabel, tryGetMachineId } from '@agentbox/config';
import { accountCustodyPath, isDefaultAccount } from '@agentbox/core';
import {
  AGENT_SYNC_SPECS,
  decodePastedSecret,
  isRealAgentCredential,
  readAccounts,
  readAccountSecret,
  readCredentialBackup,
  writeAccountSecret,
} from '@agentbox/sandbox-core';
import {
  HubApiClient,
  HubApiError,
  type HubApiAccountImportItem,
  type HubApiAccountImportResult,
  type HubApiAccountList,
} from './hub-api-client.js';

/**
 * Every login and key of this PC as import items: each agent's own (`default`)
 * login from its host backup, and every named account from the store. Only
 * real logins and well-formed pasted secrets. Null when this machine has no
 * id: the import route needs one, so the caller falls back to the custody
 * push, which still carries the default logins (#444 (f)).
 */
export async function collectAccountImportItems(
  opts: { only?: string; force?: boolean } = {},
): Promise<HubApiAccountImportItem[] | null> {
  const machine = tryGetMachineId();
  if (!machine) return null;
  const machineLabel = safeLabel();
  const base = {
    machine,
    ...(machineLabel ? { machineLabel } : {}),
    ...(opts.force ? { force: true } : {}),
  };
  const items: HubApiAccountImportItem[] = [];
  for (const spec of AGENT_SYNC_SPECS) {
    if (opts.only && spec.id !== opts.only) continue;
    if (!spec.credential) continue;
    const text = await readCredentialBackup(spec.id);
    if (text === null || !isRealAgentCredential(spec.id, text)) continue;
    items.push({ agent: spec.id, id: 'default', kind: 'login', secret: text, ...base });
  }
  for (const a of (await readAccounts()).accounts) {
    if (isDefaultAccount(a.id)) continue;
    if (opts.only && a.agent !== opts.only) continue;
    const spec = AGENT_SYNC_SPECS.find((s) => s.id === a.agent);
    if (!spec?.credential) continue;
    const text = await readAccountSecret(a.agent, a.id);
    if (text === null) continue;
    if (
      a.kind === 'login'
        ? !isRealAgentCredential(spec.id, text)
        : decodePastedSecret(text)?.kind !== a.kind
    ) {
      continue;
    }
    items.push({
      agent: a.agent,
      id: a.id,
      kind: a.kind,
      ...(a.identity ? { identity: a.identity } : {}),
      secret: text,
      ...base,
    });
  }
  return items;
}

function safeLabel(): string | undefined {
  try {
    return getMachineLabel() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Send `items` to the hub. Null when they could not be built (no machine id)
 * or the hub predates the route (404), so the caller pushes to custody the old
 * way. Other failures throw.
 */
export async function importAccountsToHub(
  target: { url: string; apiKey: string; fetchImpl?: typeof fetch },
  items: HubApiAccountImportItem[] | null,
): Promise<HubApiAccountImportResult[] | null> {
  if (items === null) return null;
  if (items.length === 0) return [];
  const client = new HubApiClient(target);
  const out: HubApiAccountImportResult[] = [];
  // The route takes at most 64 items per call.
  for (let i = 0; i < items.length; i += 64) {
    try {
      out.push(...(await client.importAccounts(items.slice(i, i + 64))));
    } catch (err) {
      if (err instanceof HubApiError && err.status === 404) return null;
      throw err;
    }
  }
  return out;
}

/** Whether an import result changed the hub. */
export function importChanged(r: HubApiAccountImportResult): boolean {
  return (
    r.action === 'created' ||
    r.action === 'merged' ||
    r.action === 'updated' ||
    r.action === 'renamed'
  );
}

/** One line per result worth telling the user about (`kept` is silent). Pure. */
export function describeImportResult(r: HubApiAccountImportResult): string | null {
  const name = `${r.agent}/${r.id}`;
  switch (r.action) {
    case 'created':
      return `${name}: added to the hub`;
    case 'renamed':
      return `${name}: added to the hub as ${r.agent}/${r.hubId ?? '?'} (${r.reason}); a create here naming '${r.id}' uses it`;
    case 'merged':
      return `${name}: same subscription as the hub's ${r.agent}/${r.hubId ?? '?'} (${r.reason})`;
    case 'updated':
      return `${name}: the hub's ${r.agent}/${r.hubId ?? r.id} now has this PC's newer login`;
    case 'removed':
      return `${name}: not pushed (${r.reason})`;
    case 'refused':
      return `${name}: refused by the hub (${r.reason})`;
    case 'kept':
      return null;
  }
}

/**
 * The hub's live copies of this PC's named LOGINS, back into the PC's own
 * store (`agentbox hub credentials pull`). A hub box's refresh revoked the
 * PC's copy; this is how the PC gets a working one. Each hub login mapped to
 * this machine is read from custody `agents/<a>/accounts/<hubMachine>/<hubId>/<file>`
 * and written under the PC's own name, newest-wins (an older custody copy never
 * replaces a newer local one). Returns the names pulled.
 */
export async function pullNamedLoginsFromHub(o: {
  list: HubApiAccountList;
  get: (path: string) => Promise<Buffer | null>;
  only?: string;
}): Promise<{ pulled: string[]; kept: string[] }> {
  const pulled: string[] = [];
  const kept: string[] = [];
  const machine = tryGetMachineId();
  const hubMachine = o.list.machine;
  if (!machine) return { pulled, kept };
  const local = await readAccounts();
  for (const a of o.list.accounts) {
    // `default` too: a PC's named login of the subscription the hub's own
    // login runs on was mapped onto it.
    if (a.kind !== 'login') continue;
    if (o.only && a.agent !== o.only) continue;
    const spec = AGENT_SYNC_SPECS.find((s) => s.id === a.agent);
    if (!spec?.credential) continue;
    if (!isDefaultAccount(a.id) && !hubMachine) continue;
    for (const from of a.importedFrom ?? []) {
      if (from.machine !== machine || isDefaultAccount(from.id)) continue;
      const row = local.accounts.find((r) => r.agent === a.agent && r.id === from.id);
      if (row?.kind !== 'login') continue;
      // A path the hub's custody refuses (an agent its registry lacks: 400)
      // skips that login, never the rest.
      const data = await o
        .get(
          isDefaultAccount(a.id)
            ? accountCustodyPath(spec.id, a.id, spec.credential.boxRelPath)
            : accountCustodyPath(spec.id, a.id, spec.credential.boxRelPath, hubMachine!),
        )
        .catch((err: unknown) => {
          if (err instanceof HubApiError && err.status === 400) return null;
          throw err;
        });
      if (!data) continue;
      const w = await writeAccountSecret(a.agent, from.id, data.toString('utf8'));
      (w.written ? pulled : kept).push(`${a.agent}/${from.id}`);
    }
  }
  return { pulled, kept };
}
