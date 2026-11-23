import { describe, expect, it } from 'vitest';
import {
  applyBindingChanges,
  emptyBindings,
  parseBindings,
  readBindings,
  resolveBindings,
  resolveSkillNames,
  scopeIdProblem,
  withoutSkill,
  SKILL_BINDINGS_PATH,
} from '../src/skill-bindings.js';

const WS = 'a1b2c3d4e5f60718';
const REPO = 'github.com/acme/app';
const names = ['alpha', 'beta', 'gamma'];

describe('skill bindings', () => {
  it('includes every skill when nothing is bound', () => {
    expect(resolveSkillNames(names, emptyBindings(), {}, undefined)).toEqual(names);
  });

  it('lets the most specific scope win: box > project > workspace > global', () => {
    let doc = applyBindingChanges(emptyBindings(), 'global', undefined, { alpha: 'exclude' });
    doc = applyBindingChanges(doc, 'workspace', WS, { alpha: 'include', beta: 'exclude' });
    doc = applyBindingChanges(doc, 'project', REPO, { beta: 'include', gamma: 'exclude' });
    doc = applyBindingChanges(doc, 'box', 'box1', { gamma: 'include' });

    // No context: only the global binding applies.
    expect(resolveSkillNames(names, doc, {}, undefined)).toEqual(['beta', 'gamma']);
    // In the workspace: alpha comes back, beta goes.
    expect(resolveSkillNames(names, doc, { workspaceId: WS }, undefined)).toEqual([
      'alpha',
      'gamma',
    ]);
    // The project overrides the workspace.
    expect(resolveSkillNames(names, doc, { workspaceId: WS, projectKey: REPO }, undefined)).toEqual(
      ['alpha', 'beta'],
    );
    // And the box overrides the project.
    const all = resolveBindings(names, doc, { workspaceId: WS, projectKey: REPO, boxId: 'box1' });
    expect(all).toEqual([
      { name: 'alpha', included: true, from: 'workspace' },
      { name: 'beta', included: true, from: 'project' },
      { name: 'gamma', included: true, from: 'box' },
    ]);
  });

  it('a workspace-scoped skill reaches only that workspace', () => {
    let doc = applyBindingChanges(emptyBindings(), 'global', undefined, { alpha: 'exclude' });
    doc = applyBindingChanges(doc, 'workspace', WS, { alpha: 'include' });
    expect(resolveSkillNames(names, doc, { workspaceId: WS }, undefined)).toContain('alpha');
    expect(
      resolveSkillNames(names, doc, { workspaceId: 'ffffffffffffffff' }, undefined),
    ).not.toContain('alpha');
  });

  it('applies create flags on top: none, an exact list, a subtraction', () => {
    const doc = applyBindingChanges(emptyBindings(), 'global', undefined, { alpha: 'exclude' });
    expect(resolveSkillNames(names, doc, {}, { none: true })).toEqual([]);
    // An explicit list wins over a binding.
    expect(resolveSkillNames(names, doc, {}, { include: ['alpha'] })).toEqual(['alpha']);
    expect(resolveSkillNames(names, doc, {}, { exclude: ['beta'] })).toEqual(['gamma']);
    // The Phase 2 semantics: a skip applies to an explicit list too.
    expect(
      resolveSkillNames(names, doc, {}, { include: ['alpha', 'beta'], exclude: ['beta'] }),
    ).toEqual(['alpha']);
    expect(resolveSkillNames(names, emptyBindings(), {}, { include: ['gamma', 'zeta'] })).toEqual([
      'gamma',
    ]);
  });

  it('clears a binding with null and drops an emptied scope', () => {
    let doc = applyBindingChanges(emptyBindings(), 'project', REPO, { alpha: 'exclude' });
    expect(doc.project[REPO]).toEqual({ alpha: 'exclude' });
    doc = applyBindingChanges(doc, 'project', REPO, { alpha: null });
    expect(doc.project).toEqual({});
  });

  it('forgets a discarded skill everywhere', () => {
    let doc = applyBindingChanges(emptyBindings(), 'global', undefined, { alpha: 'exclude' });
    doc = applyBindingChanges(doc, 'workspace', WS, { alpha: 'include', beta: 'exclude' });
    const next = withoutSkill(doc, 'alpha');
    expect(next.global).toEqual({});
    expect(next.workspace[WS]).toEqual({ beta: 'exclude' });
    expect(withoutSkill(next, 'zeta')).toBe(next);
  });

  it('parses defensively and validates scope ids', () => {
    const doc = parseBindings({
      global: { alpha: 'exclude', BAD: 'include', beta: 'maybe' },
      workspace: { nothex: { alpha: 'include' }, [WS]: { alpha: 'include' } },
      project: 'nope',
    });
    expect(doc.global).toEqual({ alpha: 'exclude' });
    expect(doc.workspace).toEqual({ [WS]: { alpha: 'include' } });
    expect(doc.project).toEqual({});
    expect(scopeIdProblem('global', undefined)).toBeNull();
    expect(scopeIdProblem('global', 'x')).toMatch(/no scopeId/);
    expect(scopeIdProblem('workspace', 'abc')).toMatch(/16-hex/);
    expect(scopeIdProblem('project', REPO)).toBeNull();
    expect(scopeIdProblem('project', 'a b')).toMatch(/repo key/);
    expect(scopeIdProblem('box', undefined)).toMatch(/needs a scopeId/);
  });

  it('reads an absent or corrupt file as empty', async () => {
    expect(await readBindings({ get: async () => null, put: async () => null })).toEqual(
      emptyBindings(),
    );
    const bad = { get: async () => ({ data: Buffer.from('{not json') }), put: async () => null };
    expect(await readBindings(bad)).toEqual(emptyBindings());
    // A writer must not build on a read that failed.
    await expect(readBindings(bad, { strict: true })).rejects.toThrow(/not valid JSON/);
    const failing = {
      get: async () => {
        throw new Error('EIO');
      },
      put: async () => null,
    };
    expect(await readBindings(failing)).toEqual(emptyBindings());
    await expect(readBindings(failing, { strict: true })).rejects.toThrow('EIO');
    expect(SKILL_BINDINGS_PATH).toBe('skills/.bindings.json');
  });

  it('treats prototype names as ordinary keys', () => {
    const odd = ['constructor', 'tostring', 'alpha'];
    // No bindings at all: every skill, `constructor` included.
    expect(resolveSkillNames(odd, emptyBindings(), {}, undefined)).toEqual(odd);
    expect(
      resolveSkillNames(
        odd,
        emptyBindings(),
        { projectKey: 'constructor', boxId: 'toString' },
        undefined,
      ),
    ).toEqual(odd);
    // A binding on `constructor` works like any other.
    const off = applyBindingChanges(emptyBindings(), 'global', undefined, {
      constructor: 'exclude' as const,
    });
    expect(resolveSkillNames(odd, off, {}, undefined)).toEqual(['tostring', 'alpha']);
    // `__proto__` is a stored scope id, not a prototype write.
    const proto = applyBindingChanges(emptyBindings(), 'project', '__proto__', {
      alpha: 'exclude',
    });
    expect(Object.keys(proto.project)).toEqual(['__proto__']);
    expect(resolveSkillNames(odd, proto, { projectKey: '__proto__' }, undefined)).toEqual([
      'constructor',
      'tostring',
    ]);
    // ...and it survives a JSON round trip through the stored file.
    const back = parseBindings(JSON.parse(JSON.stringify(proto)));
    expect(resolveSkillNames(odd, back, { projectKey: '__proto__' }, undefined)).toEqual([
      'constructor',
      'tostring',
    ]);
    expect(withoutSkill(off, 'constructor').global).toEqual({});
  });
});
