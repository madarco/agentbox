import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEVICE_ALLOWLIST_CAP,
  allowedSourcesOf,
  createTimeSelf,
  deviceEntryNeedsUpdate,
  firewallBlockedHint,
  isOpenCidr,
  normalizeDecoded,
  repairOutcome,
  withInboundPolicy,
  legacyEntryFor,
  localMachineKey,
  sanitizeDeviceKey,
  selfDeviceEntry,
  upsertDeviceEntry,
  type DeviceAllowEntry,
} from '../src/device-allowlist.js';
import { cidrKey, ipv6Prefix64, detectEgressIpv6 } from '../src/egress-ip.js';

const e = (key: string, seen: number, cidr = `10.0.0.${String(seen % 255)}/32`, hub = false) =>
  ({ key, cidrs: [cidr], seen, ...(hub ? { hub: true } : {}) }) as DeviceAllowEntry;

describe('upsertDeviceEntry', () => {
  it('replaces only the same key, keeping every other machine', () => {
    const out = upsertDeviceEntry([e('a', 1), e('b', 2)], e('b', 3, '9.9.9.9/32'));
    expect(out.map((x) => [x.key, x.cidrs[0]])).toEqual([
      ['a', '10.0.0.1/32'],
      ['b', '9.9.9.9/32'],
    ]);
  });

  it('caps the list by evicting the oldest non-hub entries, never self or hub', () => {
    const start = [e('hub', 0, '1.1.1.1/32', true), e('legacy', 0), e('old', 5), e('new', 9)];
    const out = upsertDeviceEntry(start, e('me', 10), 3);
    expect(out.map((x) => x.key).sort()).toEqual(['hub', 'me', 'new']);
  });

  it('defaults to the documented cap', () => {
    const many = Array.from({ length: 20 }, (_, i) => e(`k${String(i)}`, i + 1));
    expect(upsertDeviceEntry(many, e('me', 100))).toHaveLength(DEVICE_ALLOWLIST_CAP);
  });

  it('protects only the newest hub entry: an older one (same control box, old key) is evictable', () => {
    const hubs = [e('h1', 1, '1.1.1.1/32', true), e('h2', 2, '2.2.2.2/32', true)];
    expect(upsertDeviceEntry(hubs, e('me', 3), 2).map((x) => x.key)).toEqual(['h2', 'me']);
  });
});

describe('deviceEntryNeedsUpdate', () => {
  it('true when this machine has no entry or a different CIDR set', () => {
    expect(deviceEntryNeedsUpdate([e('a', 1)], [], 'me', ['5.5.5.5/32'])).toBe(true);
    expect(deviceEntryNeedsUpdate([e('me', 1, '4.4.4.4/32')], [], 'me', ['5.5.5.5/32'])).toBe(true);
  });

  it('false when the entry already matches (order-insensitive), or the firewall is open', () => {
    const mine: DeviceAllowEntry = { key: 'me', cidrs: ['5.5.5.5/32', '2001:db8::/64'], seen: 1 };
    expect(deviceEntryNeedsUpdate([mine], [], 'me', ['2001:db8::/64', '5.5.5.5/32'])).toBe(false);
    expect(deviceEntryNeedsUpdate([], ['0.0.0.0/0', '::/0'], 'me', ['5.5.5.5/32'])).toBe(false);
  });
});

describe('helpers', () => {
  it('allowedSourcesOf unions static + entries, deduped', () => {
    expect(
      allowedSourcesOf([e('a', 1, '1.1.1.1/32'), e('b', 2, '1.1.1.1/32')], ['10.0.0.0/8']),
    ).toEqual(['10.0.0.0/8', '1.1.1.1/32']);
  });

  it('legacyEntryFor attributes only unknown addresses', () => {
    expect(legacyEntryFor(['1.1.1.1/32', '10.0.0.0/8'], ['10.0.0.0/8'])).toEqual({
      key: 'legacy',
      cidrs: ['1.1.1.1/32'],
      seen: 0,
    });
    expect(legacyEntryFor(['10.0.0.0/8'], ['10.0.0.0/8'])).toBeNull();
  });

  it('sanitizeDeviceKey keeps keys DO-tag and description safe', () => {
    expect(sanitizeDeviceKey('Marcos-MacBook-Pro.local')).toBe('marcos-macbook-pro');
    expect(sanitizeDeviceKey('a b:c_d')).toBe('a-b-c-d');
    expect(sanitizeDeviceKey('x'.repeat(50))).toHaveLength(32);
  });

  it('selfDeviceEntry marks the control box process as hub', () => {
    expect(selfDeviceEntry(['1.1.1.1/32'], { key: 'k', nowSec: 5, hub: true, label: 'l' })).toEqual(
      {
        label: 'l',
        key: 'k',
        cidrs: ['1.1.1.1/32'],
        seen: 5,
        hub: true,
      },
    );
    expect(
      selfDeviceEntry(['1.1.1.1/32'], { key: 'k', nowSec: 5, hub: false }).hub,
    ).toBeUndefined();
  });
});

describe('IPv6 egress', () => {
  it('ipv6Prefix64 reduces an address to its /64', () => {
    expect(ipv6Prefix64('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(ipv6Prefix64('2001:0db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipv6Prefix64('1.2.3.4')).toBeNull();
    expect(ipv6Prefix64('nonsense')).toBeNull();
  });

  it('detectEgressIpv6 is best-effort: null instead of throwing when no probe answers', async () => {
    const get = async () => {
      throw new Error('ENETUNREACH');
    };
    expect(await detectEgressIpv6({ get, probes: ['https://x'] })).toBeNull();
    const ok = async () => ({ status: 200, body: '2001:db8:1:2::5\n' });
    expect(await detectEgressIpv6({ get: ok, probes: ['https://x'] })).toBe('2001:db8:1:2::/64');
  });
});

describe('review fixes', () => {
  it('a missed IPv6 probe is not a change; a new IPv6 prefix or v4 is', () => {
    const mine: DeviceAllowEntry = {
      key: 'me',
      cidrs: ['5.5.5.5/32', '2001:db8:1:0::/64'],
      seen: 1,
    };
    expect(deviceEntryNeedsUpdate([mine], [], 'me', ['5.5.5.5/32'], false)).toBe(false);
    expect(
      deviceEntryNeedsUpdate([mine], [], 'me', ['5.5.5.5/32', '2001:db8:2:0::/64'], false),
    ).toBe(true);
    expect(deviceEntryNeedsUpdate([mine], [], 'me', ['6.6.6.6/32'], false)).toBe(true);
  });

  it('compares IPv6 CIDRs by value, not spelling', () => {
    const mine: DeviceAllowEntry = { key: 'me', cidrs: ['5.5.5.5/32', '2001:db8:1::/64'], seen: 1 };
    expect(cidrKey('2001:db8:1::/64')).toBe(cidrKey('2001:DB8:1:0::/64'));
    expect(
      deviceEntryNeedsUpdate([mine], [], 'me', ['5.5.5.5/32', '2001:db8:1:0::/64'], false),
    ).toBe(false);
  });

  it('upgrades an entry to hub when the control box writes it', () => {
    const mine: DeviceAllowEntry = { key: 'me', cidrs: ['5.5.5.5/32'], seen: 1 };
    expect(deviceEntryNeedsUpdate([mine], [], 'me', ['5.5.5.5/32'], true)).toBe(true);
  });

  it('localMachineKey is the machine id without hyphens, and fits a DO tag field', () => {
    const home = mkdtempSync(join(tmpdir(), 'mid-'));
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      const k = localMachineKey();
      expect(k).toMatch(/^[0-9a-f]{32}$/);
      expect(sanitizeDeviceKey(k)).toBe(k);
      expect(
        readFileSync(join(home, '.agentbox', 'machine-id'), 'utf8')
          .trim()
          .replace(/-/g, ''),
      ).toBe(k);
      expect(existsSync(join(home, '.agentbox', 'device-key'))).toBe(false);
    } finally {
      process.env.HOME = prev;
    }
  });
});

describe('an entry under an old key ages out (machine-id switch)', () => {
  const now = 1_000_000;
  const others = Array.from({ length: 8 }, (_, i) => e(`pc${String(i)}`, now - 100 + i));

  it('a non-hub entry under the old key is evicted once the cap is reached', () => {
    const old: DeviceAllowEntry = { key: 'd795d9d370ba', cidrs: ['5.5.5.5/32'], seen: now - 500 };
    const mine: DeviceAllowEntry = { key: 'f'.repeat(32), cidrs: ['5.5.5.5/32'], seen: now };
    let list = upsertDeviceEntry([old, ...others], mine);
    expect(list.map((x) => x.key)).toContain('d795d9d370ba'); // 10 entries: still under the cap
    list = upsertDeviceEntry(list, e('newcomer', now + 1));
    expect(list.map((x) => x.key)).not.toContain('d795d9d370ba');
  });

  it("the control box's old-key hub entry is no longer protected once its new hub entry exists", () => {
    const oldHub: DeviceAllowEntry = {
      key: 'oldhubkey',
      cidrs: ['9.9.9.9/32'],
      seen: now - 900,
      hub: true,
    };
    const newHub: DeviceAllowEntry = {
      key: 'a'.repeat(32),
      cidrs: ['9.9.9.9/32'],
      seen: now,
      hub: true,
    };
    let list = upsertDeviceEntry([oldHub, ...others], newHub);
    list = upsertDeviceEntry(list, e('newcomer', now + 1));
    const keys = list.map((x) => x.key);
    expect(keys).not.toContain('oldhubkey');
    expect(keys).toContain('a'.repeat(32));
  });

  it('the newest hub entry stays protected even when it is the oldest entry overall', () => {
    const hub: DeviceAllowEntry = { key: 'hub', cidrs: ['9.9.9.9/32'], seen: 1, hub: true };
    const crowd = Array.from({ length: 12 }, (_, i) => e(`c${String(i)}`, now + i));
    let list: DeviceAllowEntry[] = [hub];
    for (const c of crowd) list = upsertDeviceEntry(list, c);
    expect(list.map((x) => x.key)).toContain('hub');
    expect(list).toHaveLength(10);
  });
});

describe('second review fixes', () => {
  const legacyOpen: DeviceAllowEntry = {
    key: 'legacy',
    cidrs: ['1.1.1.1/32', '0.0.0.0/0'],
    seen: 0,
  };

  it('isOpenCidr recognizes both world-open forms', () => {
    expect(isOpenCidr('0.0.0.0/0')).toBe(true);
    expect(isOpenCidr('::/0')).toBe(true);
    expect(isOpenCidr('0:0:0:0:0:0:0:0/0')).toBe(true);
    expect(isOpenCidr('1.1.1.1/32')).toBe(false);
  });

  it('normalizeDecoded moves world-open CIDRs out of entries into the static part', () => {
    const fw = normalizeDecoded({ staticSources: [], entries: [legacyOpen] });
    expect(fw.staticSources).toEqual(['0.0.0.0/0']);
    expect(fw.entries).toEqual([{ key: 'legacy', cidrs: ['1.1.1.1/32'], seen: 0 }]);
    // and the old "skip repair on an open firewall" semantics hold
    expect(deviceEntryNeedsUpdate(fw.entries, fw.staticSources, 'me', ['5.5.5.5/32'], false)).toBe(
      false,
    );
  });

  it('withInboundPolicy(locked) drops open sources and legacy, keeps other machines', () => {
    const other: DeviceAllowEntry = { key: 'pc-b', cidrs: ['2.2.2.2/32'], seen: 5 };
    const fw = normalizeDecoded({ staticSources: [], entries: [legacyOpen, other] });
    const me: DeviceAllowEntry = { key: 'me', cidrs: ['5.5.5.5/32'], seen: 9 };
    const locked = withInboundPolicy(fw, [], me);
    expect(locked.staticSources).toEqual([]);
    expect(allowedSourcesOf(locked.entries, locked.staticSources).sort()).toEqual([
      '2.2.2.2/32',
      '5.5.5.5/32',
    ]);
  });

  it('a pinned entry is never rewritten by an automatic repair', () => {
    const pinned: DeviceAllowEntry = { key: 'me', cidrs: ['10.8.0.1/32'], seen: 1, pinned: true };
    expect(deviceEntryNeedsUpdate([pinned], [], 'me', ['5.5.5.5/32'], false)).toBe(false);
  });

  it('the hub flag is sticky: a non-hub writer neither counts it as a change nor clears it', () => {
    const hubEntry: DeviceAllowEntry = { key: 'me', cidrs: ['5.5.5.5/32'], seen: 1, hub: true };
    expect(deviceEntryNeedsUpdate([hubEntry], [], 'me', ['5.5.5.5/32'], false)).toBe(false);
    const out = upsertDeviceEntry([hubEntry], { key: 'me', cidrs: ['6.6.6.6/32'], seen: 2 });
    expect(out[0]?.hub).toBe(true);
    const cleared = upsertDeviceEntry(
      [hubEntry],
      { key: 'me', cidrs: ['6.6.6.6/32'], seen: 2 },
      10,
      {
        clearHub: true,
      },
    );
    expect(cleared[0]?.hub).toBeUndefined();
  });

  it('createTimeSelf: a hand-set source is pinned; a world-open one is static, not a machine', async () => {
    const detect = async () => ['9.9.9.9/32'];
    const pinned = await createTimeSelf('10.8.0.1', detect, { key: 'k' });
    expect(pinned.entries[0]).toMatchObject({ cidrs: ['10.8.0.1/32'], pinned: true });
    const open = await createTimeSelf('0.0.0.0/0', detect, { key: 'k' });
    expect(open).toEqual({ entries: [], extraStatic: ['0.0.0.0/0'] });
    const detected = await createTimeSelf(undefined, detect, { key: 'k' });
    expect(detected.entries[0]?.pinned).toBeUndefined();
  });
});

describe('two-PC check follow-ups: blocked message + repair outcome', () => {
  const base = {
    provider: 'hetzner',
    boxRef: 'fw2pc',
    staticSources: [] as string[],
    key: 'me',
    currentEgress: '5.5.5.5/32',
  };
  const pcA: DeviceAllowEntry = { key: 'pc-a', cidrs: ['1.1.1.1/32'], seen: 1 };

  it('a second PC not on the firewall yet is told so, not "your IP changed"', () => {
    const msg = firewallBlockedHint({ ...base, entries: [pcA] }) ?? '';
    expect(msg).toContain('this machine is not allowed on it yet');
    expect(msg).not.toContain('Your IP changed');
    expect(msg).toContain('agentbox hetzner firewall sync fw2pc');
    expect(msg).toContain('agentbox recover fw2pc');
  });

  it('a pinned entry is told to unpin with firewall sync, and recover is not suggested', () => {
    const pinned: DeviceAllowEntry = { key: 'me', cidrs: ['10.8.0.1/32'], seen: 1, pinned: true };
    const msg = firewallBlockedHint({ ...base, entries: [pcA, pinned] }) ?? '';
    expect(msg).toContain('pinned to 10.8.0.1/32');
    expect(msg).toContain('agentbox hetzner firewall sync fw2pc');
    expect(msg).not.toContain('recover');
  });

  it('a changed IP keeps the "your IP changed" wording', () => {
    const mine: DeviceAllowEntry = { key: 'me', cidrs: ['4.4.4.4/32'], seen: 1 };
    expect(firewallBlockedHint({ ...base, entries: [mine] })).toContain('Your IP changed');
  });

  it('no hint when this machine is allowed or the firewall is open (the failure is something else)', () => {
    const mine: DeviceAllowEntry = { key: 'me', cidrs: ['5.5.5.5/32'], seen: 1 };
    expect(firewallBlockedHint({ ...base, entries: [mine] })).toBeNull();
    expect(
      firewallBlockedHint({ ...base, entries: [pcA], staticSources: ['0.0.0.0/0'] }),
    ).toBeNull();
  });

  it('repairOutcome always carries a detail, also when nothing changed', () => {
    const mine: DeviceAllowEntry = { key: 'me', cidrs: ['5.5.5.5/32'], seen: 1, label: 'mac' };
    const args = { staticSources: [] as string[], key: 'me', cidrs: ['5.5.5.5/32'] };
    expect(repairOutcome({ ...args, entries: [mine], wrote: true })).toMatchObject({
      changed: true,
      detail: expect.stringContaining('firewall updated'),
    });
    expect(repairOutcome({ ...args, entries: [mine], wrote: false }).detail).toContain(
      'already allowed',
    );
    expect(
      repairOutcome({ ...args, entries: [{ ...mine, pinned: true }], wrote: false }).detail,
    ).toContain('pinned');
    expect(
      repairOutcome({ ...args, entries: [], staticSources: ['0.0.0.0/0'], wrote: false }).detail,
    ).toContain('open to the world');
  });
});
