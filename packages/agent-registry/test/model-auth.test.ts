import { describe, expect, it } from 'vitest';
import { AGENT_SPECS, findAgentSpec } from '../src/index.js';

/**
 * `modelAuth` is data three things read without importing one another: the
 * host seeds by the LENDER's credential path, the box runs the row's own
 * ingest task, and config generates the `<agent>.modelAuth` key. Each link
 * below is one that fails silently when it drifts.
 */
describe('AgentSyncSpec.modelAuth', () => {
  const declaring = AGENT_SPECS.filter((s) => s.modelAuth !== undefined);

  it('is declared by openclaw, borrowing codex', () => {
    expect(declaring.map((s) => s.id)).toContain('openclaw');
    expect(findAgentSpec('openclaw')?.modelAuth?.borrows.map((b) => b.agent)).toEqual(['codex']);
  });

  it('every borrow names an agent that has a host-side credential to lend', () => {
    for (const spec of declaring) {
      for (const b of spec.modelAuth!.borrows) {
        const lender = findAgentSpec(b.agent);
        expect(lender, `${spec.id} borrows unknown agent ${b.agent}`).toBeDefined();
        expect(
          lender!.credential,
          `${spec.id} borrows ${b.agent}, which lends nothing`,
        ).toBeDefined();
        expect(b.label.length).toBeGreaterThan(0);
      }
    }
  });

  it('ingestTask names one of the row`s own service tasks', () => {
    for (const spec of declaring) {
      const names = (spec.service?.tasks ?? []).map((t) => t.name);
      expect(names, spec.id).toContain(spec.modelAuth!.ingestTask);
    }
  });

  it('the ingest script reads the lender at the lender`s own credential path', () => {
    // The host lands the file where a runtime install of the lender would; the
    // row must not restate that path by hand.
    for (const spec of declaring) {
      const task = spec.service!.tasks!.find((t) => t.name === spec.modelAuth!.ingestTask)!;
      const script = String(task.command);
      for (const b of spec.modelAuth!.borrows) {
        expect(script).toContain(findAgentSpec(b.agent)!.credential!.boxAbsPath);
      }
    }
  });

  it('declares a `modelAuth` enum setting covering none + every borrow, defaulting to none', () => {
    // The config key is generated from the setting; the opt-in gate reads it.
    for (const spec of declaring) {
      const setting = (spec.settings ?? []).find((s) => s.key === 'modelAuth');
      expect(setting, `${spec.id} has no modelAuth setting`).toBeDefined();
      expect(setting!.type).toBe('enum');
      expect(setting!.default).toBe('none');
      expect(setting!.affectsBake).toBeUndefined();
      expect([...(setting!.enumValues ?? [])].sort()).toEqual(
        ['none', ...spec.modelAuth!.borrows.map((b) => b.agent)].sort(),
      );
    }
  });

  it('stays JSON-serializable, like the rest of the row', () => {
    for (const spec of declaring) {
      expect(JSON.parse(JSON.stringify(spec.modelAuth))).toEqual(spec.modelAuth);
    }
  });
});

describe('openclaw-model-auth', () => {
  const spec = findAgentSpec('openclaw')!;
  const task = spec.service!.tasks!.find((t) => t.name === 'openclaw-model-auth')!;
  const script = String(task.command);

  it('is best-effort: exits 0 on every "nothing to do" and never sets -e', () => {
    expect(script).toContain('set -u');
    expect(script).not.toContain('set -e');
    expect(script).toMatch(/no borrowed Codex login[^\n]*exit 0/);
    expect(script).toMatch(/not a Codex ChatGPT login[^\n]*exit 0/);
    expect(script).toMatch(/already in place[\s\S]*exit 0/);
  });

  it('imports through openclaw`s own migrate command, scoped to the auth item', () => {
    // Measured on 2026.9.3: the auth store is SQLite and the retired JSON
    // files are never read, so `migrate apply codex` is the seam — and only
    // the auth item, never the source's skills/plugins/config.
    expect(script).toContain('openclaw migrate apply codex');
    expect(script).toContain('--item auth:openai');
    expect(script).toContain('--include-secrets');
    expect(script).toContain('--yes');
    expect(script).not.toContain('--overwrite');
  });

  it('installs the official codex plugin only when absent', () => {
    expect(script).toContain('plugins install clawhub:@openclaw/codex');
    expect(script).toMatch(/if \[ ! -d '[^']*\/\.openclaw\/extensions\/codex' \]/);
  });

  it('skips the import while openclaw reports a usable OpenAI OAuth profile', () => {
    expect(script).toContain('openclaw models status --json');
    // The program rides inside a single-quoted shell word, so its own quotes
    // are escaped; match the check loosely rather than its quoting.
    expect(script).toMatch(/p\.provider === .{0,6}openai.{0,6} && p\.type === .{0,6}oauth/);
    expect(script).toContain('unusableProfiles');
  });

  it('never writes the store or the config file by hand', () => {
    expect(script).not.toContain('auth-profiles.json');
    expect(script).not.toContain('openclaw-agent.sqlite');
    expect(script).not.toContain('openclaw.json');
  });
});
