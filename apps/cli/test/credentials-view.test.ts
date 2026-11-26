import { describe, expect, it } from 'vitest';
import {
  defaultText,
  parseAccountRef,
  renderAccountsTable,
  renderDefaultsTable,
  sortAccounts,
  statusText,
} from '../src/lib/credentials-view.js';
import type { HubApiAccount } from '../src/control-plane/hub-api-client.js';
import { subscriptionSummary } from '../src/commands/list.js';

const NOW = Date.parse('2026-11-26T12:00:00Z');

function acct(over: Partial<HubApiAccount> = {}): HubApiAccount {
  return { agent: 'claude', id: 'work', kind: 'login', hasSecret: true, boxes: [], ...over };
}

describe('parseAccountRef', () => {
  it('splits <agent>/<account>', () => {
    expect(parseAccountRef('claude/work')).toEqual({ agent: 'claude', id: 'work' });
  });
  it.each(['claude', '/work', 'claude/', 'claude/a/b', ''])('refuses %j', (ref) => {
    expect(() => parseAccountRef(ref)).toThrow(/<agent>\/<account>/);
  });
});

describe('statusText', () => {
  it('revoked wins over everything, naming the box and how long ago', () => {
    const a = acct({
      hasSecret: false,
      limits: { windows: [], atLimit: true, updatedAt: '' },
      auth: { state: 'revoked', since: '2026-11-26T11:00:00Z', box: 'web' },
    });
    expect(statusText(a, NOW)).toBe('revoked in web 1h ago');
  });
  it('then no secret, at limit, expiring, ok', () => {
    expect(statusText(acct({ hasSecret: false }), NOW)).toBe('no secret');
    expect(
      statusText(acct({ limits: { windows: [], atLimit: true, updatedAt: '' } }), NOW),
    ).toBe('at limit');
    expect(
      statusText(acct({ auth: { state: 'expiring', since: '2026-12-10T00:00:00Z' } }), NOW),
    ).toBe('expiring 2026-12-10');
    expect(statusText(acct({ auth: { state: 'ok' } }), NOW)).toBe('ok');
    // An older hub sends no `auth`.
    expect(statusText(acct(), NOW)).toBe('ok');
  });
});

describe('the list', () => {
  it('groups by agent with the default login first', () => {
    const sorted = sortAccounts([
      acct({ agent: 'codex', id: 'a' }),
      acct({ id: 'zeta' }),
      acct({ id: 'default' }),
      acct({ id: 'alpha' }),
    ]).map((a) => `${a.agent}/${a.id}`);
    expect(sorted).toEqual(['claude/default', 'claude/alpha', 'claude/zeta', 'codex/a']);
  });
  it('marks defaults and shows meters', () => {
    expect(defaultText(acct({ default: { global: true, project: true } }))).toBe('project, global');
    const table = renderAccountsTable(
      [
        acct({
          id: 'default',
          identity: { email: 'me@example.com', plan: 'max' },
          boxes: ['web', 'api'],
          default: { global: true },
          limits: {
            windows: [
              { id: 'a', label: '5-hour', pct: 41.6 },
              { id: 'b', label: 'Weekly', pct: 80 },
            ],
            atLimit: false,
            updatedAt: '',
          },
        }),
      ],
      NOW,
    );
    expect(table.split('\n')[1]).toMatch(
      /^claude\/default +login +me@example\.com, max +ok +5-hour 42%, Weekly 80% +global +web, api$/,
    );
  });
});

describe('renderDefaultsTable', () => {
  it('says where each default comes from', () => {
    const out = renderDefaultsTable({
      codex: { account: 'default', source: 'default' },
      claude: { account: 'work', source: 'project', project: 'work', global: 'home' },
    });
    const [, claude, codex] = out.split('\n');
    expect(claude).toMatch(/^claude +claude\/work +project setting +claude\/home$/);
    expect(codex).toMatch(/^codex +codex\/default +the agent's default login$/);
  });
});

describe('ls SUBSCRIPTION column', () => {
  it('default for an agent on its own default login, else agent/account', () => {
    expect(subscriptionSummary({ subscriptions: { claude: 'claude/default' } })).toBe('default');
    expect(subscriptionSummary({ subscriptions: { claude: 'claude/work' } })).toBe('claude/work');
    // A borrower shows its lender's subscription.
    expect(
      subscriptionSummary({ subscriptions: { openclaw: 'codex/default', codex: 'codex/default' } }),
    ).toBe('codex/default, default');
  });
  it('falls back to accounts from an older hub, and - with no agent', () => {
    expect(subscriptionSummary({ agents: ['claude'], accounts: { claude: 'ci' } })).toBe(
      'claude/ci',
    );
    expect(subscriptionSummary({ lastAgent: 'codex' })).toBe('default');
    expect(subscriptionSummary({})).toBe('-');
  });
});
