import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import config from '../next.config.mjs';

const DASHBOARD = join(import.meta.dirname, '..', 'app', '(dashboard)');
const hasPage = (route: string) => existsSync(join(DASHBOARD, route, 'page.tsx'));

describe('settings routes', () => {
  it('redirects the shipped old paths permanently, to pages that exist', async () => {
    const redirects = (await config.redirects?.()) ?? [];
    expect(redirects.map((r) => [r.source, r.destination, r.permanent])).toEqual([
      ['/skills', '/settings/skills', true],
      ['/devices', '/settings/devices', true],
      ['/system', '/settings/system', true],
    ]);
    for (const r of redirects) expect(hasPage(r.destination), r.destination).toBe(true);
  });

  it('serves every settings page under /settings and none at the old top level', () => {
    for (const sub of ['', 'subscriptions', 'skills', 'files', 'devices', 'system']) {
      expect(hasPage(join('settings', sub)), `/settings/${sub}`).toBe(true);
    }
    for (const old of ['accounts', 'custody', 'skills', 'devices', 'system']) {
      expect(hasPage(old), `/${old}`).toBe(false);
    }
  });
});
