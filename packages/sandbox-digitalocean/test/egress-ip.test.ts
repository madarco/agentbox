import { describe, expect, it } from 'vitest';
import type { EgressProbeGet } from '@agentbox/sandbox-core';
import {
  CREATE_EGRESS_HINT,
  INBOUND_EGRESS_HINT,
  REPAIR_EGRESS_HINT,
  SYNC_EGRESS_HINT,
  detectEgressCidr,
} from '../src/egress-ip.js';

function fakeGet(map: Record<string, string>): EgressProbeGet {
  return (url) => Promise.resolve({ status: 200, body: map[url] ?? '' });
}

const v6Only = { probes: ['https://v6'], get: fakeGet({ 'https://v6': '2001:db8::42' }) };

describe('digitalocean detectEgressCidr', () => {
  it('locks the firewall to the IPv4 egress on a dual-stack host', async () => {
    const cidr = await detectEgressCidr({
      probes: ['https://v6', 'https://v4'],
      get: fakeGet({ 'https://v6': '2001:db8::42', 'https://v4': '203.0.113.42' }),
    });
    expect(cidr).toBe('203.0.113.42/32');
  });

  it('refuses to produce <ipv6>/32 and ends with the caller-supplied hint', async () => {
    await expect(detectEgressCidr({ ...v6Only, overrideHint: CREATE_EGRESS_HINT })).rejects.toThrow(
      /IPv4 egress[\s\S]*AGENTBOX_DIGITALOCEAN_FIREWALL_SOURCE/,
    );
  });

  it('names no override when the caller has none (prepare, control-plane deploy)', async () => {
    const err = await detectEgressCidr(v6Only).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/IPv4 egress/);
    expect((err as Error).message).not.toMatch(/FIREWALL_SOURCE|--inbound|--source/);
  });
});

describe('digitalocean egress override hints', () => {
  it('only the create hint names the env override that create honours', () => {
    expect(CREATE_EGRESS_HINT).toMatch(/AGENTBOX_DIGITALOCEAN_FIREWALL_SOURCE/);
    expect(CREATE_EGRESS_HINT).toMatch(/--inbound open/);
    for (const hint of [SYNC_EGRESS_HINT, INBOUND_EGRESS_HINT, REPAIR_EGRESS_HINT]) {
      expect(hint).not.toMatch(/FIREWALL_SOURCE/);
    }
  });

  it('firewall sync points at its own --source flag', () => {
    expect(SYNC_EGRESS_HINT).toMatch(/--source </);
  });

  it('inbound and repair point at commands that exist for this provider', () => {
    expect(INBOUND_EGRESS_HINT).toMatch(/agentbox inbound <box> open/);
    expect(INBOUND_EGRESS_HINT).toMatch(/agentbox digitalocean firewall sync <box> --source/);
    expect(REPAIR_EGRESS_HINT).toMatch(/agentbox digitalocean firewall sync <box> --source/);
  });
});
