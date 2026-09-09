import { describe, expect, it } from 'vitest';
import { modelAuthSourceId, PROMPT_MULTI_SEPARATOR } from '@agentbox/core';
import { AGENT_SPECS, findAgentSpec } from '../src/index.js';

/**
 * `modelAuth` is data three things read without importing one another: the
 * host seeds by the SOURCE's own path or env key, the box runs the row's own
 * ingest, and config generates the `<agent>.modelAuth` key. Each link below is
 * one that fails silently when it drifts.
 */
describe('AgentSyncSpec.modelAuth', () => {
  const declaring = AGENT_SPECS.filter((s) => s.modelAuth !== undefined);
  const agentSources = (spec: (typeof AGENT_SPECS)[number]) =>
    (spec.modelAuth?.sources ?? []).filter((s) => s.kind === 'agent');

  it('is declared by openclaw, borrowing codex', () => {
    expect(declaring.map((s) => s.id)).toContain('openclaw');
    expect(findAgentSpec('openclaw')?.modelAuth?.sources.map((s) => modelAuthSourceId(s))).toEqual([
      'codex',
    ]);
  });

  it('every agent source names an agent that has a host-side credential to lend', () => {
    for (const spec of declaring) {
      for (const b of agentSources(spec)) {
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

  it('gives every source a distinct id, and a label to show for it', () => {
    // The id is the whole addressing scheme — `--model-auth`, the config key and
    // BoxRecord all key on it, so a collision would silently grant the wrong one.
    for (const spec of declaring) {
      const ids = (spec.modelAuth?.sources ?? []).map((s) => modelAuthSourceId(s));
      expect(new Set(ids).size, `${spec.id} has duplicate source ids`).toBe(ids.length);
      for (const s of spec.modelAuth!.sources) expect(s.label.length).toBeGreaterThan(0);
    }
  });

  it('never offers a source id containing the multi-answer separator', () => {
    // A `multiple` prompt joins chosen values with it; a value carrying one
    // would decode into two ids that name nothing.
    for (const spec of declaring) {
      for (const s of spec.modelAuth!.sources) {
        expect(modelAuthSourceId(s)).not.toContain(PROMPT_MULTI_SEPARATOR);
      }
    }
  });

  it('keeps env sources out of forwardedEnvKeys, which is passthrough only', () => {
    // A key that authenticates is a GRANT; `forwardedEnvKeys` is for
    // preferences like ANTHROPIC_MODEL and is sprayed unconditionally.
    for (const spec of declaring) {
      for (const s of spec.modelAuth!.sources) {
        if (s.kind !== 'env') continue;
        expect(
          spec.forwardedEnvKeys,
          `${spec.id} both grants and sprays ${s.envKey}`,
        ).not.toContain(s.envKey);
      }
    }
  });

  it('an ingest either names one of the row`s own service tasks, or carries a command', () => {
    // A TUI agent has no service DAG to hang a task on, so it declares the
    // script itself and the host runs it at the launch seam.
    for (const spec of declaring) {
      const ingest = spec.modelAuth!.ingest;
      // Only an `agent` source needs importing; an env key IS the auth.
      if (agentSources(spec).length === 0) continue;
      expect(ingest, `${spec.id} borrows a login but declares no ingest`).toBeDefined();
      if (ingest!.kind === 'serviceTask') {
        const names = (spec.service?.tasks ?? []).map((t) => t.name);
        expect(names, spec.id).toContain(ingest!.task);
      } else {
        expect(ingest!.name.length, spec.id).toBeGreaterThan(0);
        expect(ingest!.command.length, spec.id).toBeGreaterThan(0);
      }
    }
  });

  it('the ingest script reads the lender at the lender`s own credential path', () => {
    // The host lands the file where a runtime install of the lender would; the
    // row must not restate that path by hand.
    for (const spec of declaring) {
      const ingest = spec.modelAuth!.ingest;
      if (!ingest) continue;
      const script =
        ingest.kind === 'serviceTask'
          ? String(spec.service!.tasks!.find((t) => t.name === ingest.task)!.command)
          : ingest.command;
      for (const b of agentSources(spec)) {
        expect(script).toContain(findAgentSpec(b.agent)!.credential!.boxAbsPath);
      }
    }
  });

  it('an ingest is best-effort: exits 0 on nothing-to-do and never sets -e', () => {
    // A box that cannot import its seed must still come up.
    for (const spec of declaring) {
      const ingest = spec.modelAuth!.ingest;
      if (ingest?.kind !== 'command') continue;
      expect(ingest.command, spec.id).toContain('set -u');
      expect(ingest.command, spec.id).not.toContain('set -e');
    }
  });

  it('declares a `modelAuth` enum-list setting covering none + every source', () => {
    // The config key is generated from the setting; the opt-in gate reads it.
    for (const spec of declaring) {
      const setting = (spec.settings ?? []).find((s) => s.key === 'modelAuth');
      expect(setting, `${spec.id} has no modelAuth setting`).toBeDefined();
      expect(setting!.type).toBe('enum-list');
      expect(setting!.default).toBe('none');
      expect(setting!.affectsBake).toBeUndefined();
      expect([...(setting!.enumValues ?? [])].sort()).toEqual(
        ['none', ...spec.modelAuth!.sources.map((s) => modelAuthSourceId(s))].sort(),
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
    expect(script.trimEnd().endsWith('exit 0')).toBe(true);
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

  it('gates on the seed file`s hash, never on openclaw`s status view', () => {
    // A bare seeded file makes `models status` show a bootstrapped profile
    // that a turn cannot use, so status cannot say "already imported". The
    // marker sits beside the overlay record and is excluded from the push.
    expect(script).not.toContain('models status');
    expect(script).toContain('sha256sum "$auth"');
    expect(script).toContain('.agentbox-model-auth.sha256');
    expect(script).toMatch(/already imported[\s\S]*exit 0/);
    expect(spec.staticPaths[0]!.exclude).toContain('.agentbox-model-auth.sha256');
  });

  it('never writes the store or the config file by hand', () => {
    expect(script).not.toContain('auth-profiles.json');
    expect(script).not.toContain('openclaw-agent.sqlite');
    expect(script).not.toContain('openclaw.json');
  });
});
