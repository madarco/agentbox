/**
 * How `agentbox credentials` shows accounts (docs/credentials-tui-plan.md):
 * the list table, the status cell and the `use` table. Pure, plain text, so
 * the TUI's `note` and a pipe render the same thing.
 */
import type { HubApiAccount, HubApiAccountDefault } from '../control-plane/hub-api-client.js';

export const KIND_TEXT: Record<HubApiAccount['kind'], string> = {
  login: 'login',
  'setup-token': 'setup token',
  'api-key': 'API key',
};

/** `<agent>/<id>` → its parts, or a message for the user. */
export function parseAccountRef(ref: string): { agent: string; id: string } {
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1 || ref.indexOf('/', slash + 1) !== -1) {
    throw new Error(`expected <agent>/<account>, e.g. claude/work (got '${ref}')`);
  }
  return { agent: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

/** `email, plan` off the login; empty when it has none. */
export function identityText(a: Pick<HubApiAccount, 'identity'>): string {
  const i = a.identity;
  return [i?.email, i?.org, i?.plan].filter((p): p is string => typeof p === 'string').join(', ');
}

/** `5-hour 40%, Weekly 82%`; empty without data. */
export function limitsText(a: Pick<HubApiAccount, 'limits'>): string {
  const l = a.limits;
  if (!l || l.windows.length === 0) return '';
  const text = l.windows.map((w) => `${w.label} ${String(Math.round(w.pct))}%`).join(', ');
  return l.stale ? `${text} (stale)` : text;
}

/**
 * The account's status, worst first: `revoked` (a box had it refused; renew it),
 * `no secret`, `at limit`, `expiring`, `ok`.
 */
export function statusText(
  a: Pick<HubApiAccount, 'auth' | 'hasSecret' | 'limits'>,
  now = Date.now(),
): string {
  if (a.auth?.state === 'revoked') {
    const where = a.auth.box ? ` in ${a.auth.box}` : '';
    return `revoked${where}${a.auth.since ? ` ${ago(a.auth.since, now)}` : ''}`;
  }
  if (!a.hasSecret) return 'no secret';
  if (a.limits?.atLimit) return 'at limit';
  if (a.auth?.state === 'expiring') {
    return `expiring${a.auth.since ? ` ${a.auth.since.slice(0, 10)}` : ''}`;
  }
  return 'ok';
}

function ago(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const min = Math.max(0, Math.round((now - t) / 60_000));
  if (min < 60) return `${String(min)}m ago`;
  if (min < 48 * 60) return `${String(Math.round(min / 60))}h ago`;
  return `${String(Math.round(min / 1440))}d ago`;
}

/** `project, global` / `global` / ''. */
export function defaultText(a: Pick<HubApiAccount, 'default'>): string {
  return [a.default?.project ? 'project' : '', a.default?.global ? 'global' : '']
    .filter(Boolean)
    .join(', ');
}

/** Accounts grouped by agent, the default login first, then by id. */
export function sortAccounts<T extends Pick<HubApiAccount, 'agent' | 'id'>>(
  accounts: readonly T[],
): T[] {
  return [...accounts].sort(
    (x, y) =>
      x.agent.localeCompare(y.agent) ||
      Number(y.id === 'default') - Number(x.id === 'default') ||
      x.id.localeCompare(y.id),
  );
}

export function formatTable(headers: readonly string[], rows: readonly string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: readonly string[]): string =>
    cells
      .map((c, i) => c.padEnd(widths[i]!))
      .join('  ')
      .trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}

/** The `credentials list` table. */
export function renderAccountsTable(accounts: readonly HubApiAccount[], now = Date.now()): string {
  return formatTable(
    ['ACCOUNT', 'KIND', 'LABEL', 'IDENTITY', 'STATUS', 'LIMITS', 'DEFAULT', 'BOXES'],
    sortAccounts(accounts).map((a) => [
      `${a.agent}/${a.id}`,
      KIND_TEXT[a.kind] ?? a.kind,
      a.label ?? '',
      identityText(a),
      statusText(a, now),
      limitsText(a),
      defaultText(a),
      a.boxes.join(', '),
    ]),
  );
}

const SOURCE_TEXT: Record<HubApiAccountDefault['source'], string> = {
  project: 'project setting',
  global: 'global setting',
  default: "the agent's default login",
};

/** The `credentials use` table: per agent, what a new box here gets and why. */
export function renderDefaultsTable(defaults: Record<string, HubApiAccountDefault>): string {
  return formatTable(
    ['AGENT', 'NEW BOXES USE', 'FROM', 'GLOBAL SETTING'],
    Object.entries(defaults)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([agent, d]) => [
        agent,
        `${agent}/${d.account}`,
        SOURCE_TEXT[d.source],
        d.source === 'project' && d.global ? `${agent}/${d.global}` : '',
      ]),
  );
}
