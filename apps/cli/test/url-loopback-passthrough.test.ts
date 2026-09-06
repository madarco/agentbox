import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `agentbox url --loopback` must reach the cloud resolver.
 *
 * The bug: `resolveViaProvider` built its cloud call as
 * `p.resolveUrl(box, { kind: 'web', ttl })`, dropping `opts.loopback`. The
 * cloud resolver honours the flag — it is what skips a registered Portless
 * alias (`cloud-provider.ts`) — so the flag's one job silently did nothing for
 * every cloud box, which is how a `--loopback` probe came back with the proxied
 * URL during the OpenClaw investigation.
 *
 * Asserted against the source because the surrounding function does real
 * lifecycle work (probeState, resume, start) that a unit test cannot stand up,
 * and the defect is precisely a missing argument.
 */
const SRC = readFileSync(join(__dirname, '..', 'src', 'commands', 'url.ts'), 'utf8');

describe('agentbox url --loopback (cloud)', () => {
  it('forwards loopback to the provider', () => {
    const call = /return p\.resolveUrl\(box, \{[^}]*\}[^;]*\);/.exec(SRC)?.[0];
    expect(call).toBeDefined();
    expect(call).toMatch(/loopback/);
  });

  it('still passes the kind and the ttl', () => {
    const call = /return p\.resolveUrl\(box, \{[^}]*\}[^;]*\);/.exec(SRC)?.[0] ?? '';
    expect(call).toMatch(/kind: 'web'/);
    expect(call).toMatch(/ttl/);
  });
});
