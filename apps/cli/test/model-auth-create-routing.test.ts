import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lendableAgentIds, resolveBoxModelAuth } from '../src/lib/model-auth-gate.js';

/**
 * `--model-auth` has to survive every route a create can take.
 *
 * The failure it guards against is silent by construction: a box whose seeded
 * login was dropped somewhere on the wire builds, boots and looks healthy — it
 * is simply not authenticated. The four CLI sites below are the ones that had
 * no field at all, and the ordering assertion is the `-i` early return that
 * discarded the flag even with no control box in play.
 */
function src(...parts: string[]): string {
  return readFileSync(join(__dirname, '..', 'src', ...parts), 'utf8');
}

describe('--model-auth reaches every hub-routed create', () => {
  it('the -i branch resolves the gate before it returns', () => {
    const s = src('agents', 'command', 'create-action.ts');
    const gateAt = s.indexOf('const borrowCredentials = await modelAuth();');
    const enqueueAt = s.indexOf('enqueueAgentJobViaHub(');
    const queueAt = s.indexOf('submitQueueJob(');
    expect(gateAt, 'the -i branch must resolve the model-auth gate').toBeGreaterThan(-1);
    expect(enqueueAt).toBeGreaterThan(-1);
    expect(queueAt).toBeGreaterThan(-1);
    // Both `-i` endings — the control box and the local queue — are downstream
    // of the gate, so neither can be reached with the flag unread.
    expect(gateAt).toBeLessThan(enqueueAt);
    expect(gateAt).toBeLessThan(queueAt);
  });

  it('both -i endings carry the resolved sources', () => {
    const s = src('agents', 'command', 'create-action.ts');
    // The hub enqueue and the local queue job, in that order in the source.
    expect(s).toContain('...(borrowCredentials.length > 0 ? { borrowCredentials } : {})');
    expect(s.match(/borrowCredentials\.length > 0 \? \{ borrowCredentials \}/g)).toHaveLength(2);
  });

  it('the foreground hub-routed create carries them too', () => {
    const s = src('agents', 'command', 'create-action.ts');
    const hubCallAt = s.indexOf('createCloudBoxViaHubAndAdopt({');
    expect(hubCallAt).toBeGreaterThan(-1);
    const call = s.slice(hubCallAt, hubCallAt + 1200);
    expect(call).toContain('borrowCredentials: modelAuthSources');
  });

  it('both hub-create shapes send an opts bag built from the selection', () => {
    const s = src('commands', '_cloud-agent-via-hub.ts');
    // Foreground (cold create + adopt) and background `-i`. Asserted on the
    // CALL, not on the exact argument spelling: the bag has grown (size,
    // location) and will grow again, and pinning the literal only ever
    // reported the growth as a failure.
    expect(s.match(/\.\.\.hubCreateOpts\(\{/g)).toHaveLength(2);
    expect(s.match(/borrowCredentials \? \{ borrowCredentials \}/g)?.length ?? 0).toBeGreaterThan(
      0,
    );
    expect(s).toContain('borrowCredentials?: string[];');
  });

  it('POST /api/v1/boxes from `agentbox create` names the sources', () => {
    const s = src('commands', 'create.ts');
    // The remote (control-box) request and the local queue request.
    expect(s.match(/borrowCredentials\.length > 0 \? \{ borrowCredentials \}/g)).toHaveLength(2);
    expect(s).toContain('resolveBoxModelAuth(opts.modelAuth)');
  });
});

describe('resolveBoxModelAuth (agentless `agentbox create`)', () => {
  it('offers only logins some agent declares it can borrow', () => {
    const ids = lendableAgentIds();
    expect(ids).toContain('codex');
    // claude's live OAuth blob is deliberately not lendable: a consumer's
    // refresh rotates the token and logs the host out.
    expect(ids).not.toContain('claude');
  });

  it('no flag means no seed', () => {
    expect(resolveBoxModelAuth(undefined)).toEqual([]);
  });

  it('`none` is the explicit decline', () => {
    expect(resolveBoxModelAuth(['none'])).toEqual([]);
  });

  it('accepts a declared lender', () => {
    expect(resolveBoxModelAuth(['codex'])).toEqual(['codex']);
  });

  it('refuses a login no agent can borrow, naming what it accepts', () => {
    expect(() => resolveBoxModelAuth(['claude'])).toThrow(/not a host login a box can borrow/);
    expect(() => resolveBoxModelAuth(['claude'])).toThrow(/codex/);
  });

  it('refuses an env key rather than accepting a seed that never happens', () => {
    expect(() => resolveBoxModelAuth(['env:XAI_API_KEY'])).toThrow(/environment key/);
  });
});
