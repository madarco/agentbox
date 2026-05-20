import { describe, expect, it } from 'vitest';
import {
  allocateProjectIndex,
  autoPickProjectBox,
  findBox,
  resolveBoxRef,
  type BoxRecord,
  type StateFile,
} from '../src/state.js';

const mk = (id: string, name: string, overrides: Partial<BoxRecord> = {}): BoxRecord => ({
  id,
  name,
  container: `agentbox-${name}`,
  image: 'agentbox/box:dev',
  workspacePath: '/tmp/ws',
  snapshotDir: null,
  createdAt: '2026-05-12T00:00:00.000Z',
  ...overrides,
});

const state = (boxes: BoxRecord[]): StateFile => ({ version: 1, boxes });

describe('findBox', () => {
  it('returns none on an empty state', () => {
    expect(findBox('anything', state([])).kind).toBe('none');
  });

  it('returns none when nothing matches', () => {
    expect(findBox('xxxx', state([mk('a1b2c3d4', 'alpha')])).kind).toBe('none');
  });

  it('matches exact id', () => {
    const boxes = [mk('a1b2c3d4', 'alpha'), mk('e5f6a7b8', 'beta')];
    const result = findBox('a1b2c3d4', state(boxes));
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.box.id).toBe('a1b2c3d4');
  });

  it('matches a unique id prefix', () => {
    const boxes = [mk('a1b2c3d4', 'alpha'), mk('e5f6a7b8', 'beta')];
    const result = findBox('a1b2', state(boxes));
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.box.id).toBe('a1b2c3d4');
  });

  it('reports ambiguous on a prefix that matches multiple ids', () => {
    const boxes = [mk('a1b2c3d4', 'alpha'), mk('a1b2c3d5', 'beta')];
    const result = findBox('a1b2', state(boxes));
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') expect(result.matches).toHaveLength(2);
  });

  it('falls back to exact name when no id matches', () => {
    const boxes = [mk('a1b2c3d4', 'alpha'), mk('e5f6a7b8', 'beta')];
    const result = findBox('alpha', state(boxes));
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.box.name).toBe('alpha');
  });

  it('falls back to exact container name as a last resort', () => {
    const boxes = [mk('a1b2c3d4', 'alpha'), mk('e5f6a7b8', 'beta')];
    const result = findBox('agentbox-beta', state(boxes));
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.box.id).toBe('e5f6a7b8');
  });

  it('prefers exact id over name when both could match', () => {
    // a record whose name equals another record's id should not steal the match
    const boxes = [
      mk('a1b2c3d4', 'alpha'),
      mk('e5f6a7b8', 'a1b2c3d4'), // pathological: name collides with sibling id
    ];
    const result = findBox('a1b2c3d4', state(boxes));
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.box.id).toBe('a1b2c3d4');
  });

  it('rejects empty/whitespace queries', () => {
    expect(findBox('', state([mk('a1b2c3d4', 'alpha')])).kind).toBe('none');
    expect(findBox('   ', state([mk('a1b2c3d4', 'alpha')])).kind).toBe('none');
  });
});

describe('allocateProjectIndex', () => {
  it('returns 1 when the project has no boxes', () => {
    expect(allocateProjectIndex(state([]), '/p/a')).toBe(1);
  });

  it('returns 1 + max(projectIndex) for the matching project', () => {
    const boxes = [
      mk('a1', 'alpha', { projectRoot: '/p/a', projectIndex: 1 }),
      mk('a2', 'beta', { projectRoot: '/p/a', projectIndex: 2 }),
      mk('a3', 'gamma', { projectRoot: '/p/b', projectIndex: 7 }), // other project
    ];
    expect(allocateProjectIndex(state(boxes), '/p/a')).toBe(3);
  });

  it('ignores boxes missing projectIndex (legacy)', () => {
    const boxes = [
      mk('a1', 'alpha', { projectRoot: '/p/a' }), // legacy, no index
      mk('a2', 'beta', { projectRoot: '/p/a', projectIndex: 5 }),
    ];
    expect(allocateProjectIndex(state(boxes), '/p/a')).toBe(6);
  });

  it('is monotonic across gaps (destroyed box does not free its slot)', () => {
    const boxes = [
      mk('a1', 'alpha', { projectRoot: '/p/a', projectIndex: 1 }),
      // index 2 was destroyed — record is gone
      mk('a3', 'gamma', { projectRoot: '/p/a', projectIndex: 3 }),
    ];
    expect(allocateProjectIndex(state(boxes), '/p/a')).toBe(4);
  });
});

describe('autoPickProjectBox', () => {
  it('returns none when the project has no boxes', () => {
    expect(autoPickProjectBox(state([]), '/p/a').kind).toBe('none');
  });

  it('returns the unique box for the project', () => {
    const only = mk('a1', 'alpha', { projectRoot: '/p/a', projectIndex: 1 });
    const r = autoPickProjectBox(state([only, mk('b1', 'b', { projectRoot: '/p/b' })]), '/p/a');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.box.id).toBe('a1');
  });

  it('returns ambiguous when 2+ boxes belong to the project', () => {
    const boxes = [
      mk('a1', 'alpha', { projectRoot: '/p/a', projectIndex: 1 }),
      mk('a2', 'beta', { projectRoot: '/p/a', projectIndex: 2 }),
    ];
    const r = autoPickProjectBox(state(boxes), '/p/a');
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect(r.matches.map((b) => b.id).sort()).toEqual(['a1', 'a2']);
  });
});

describe('resolveBoxRef', () => {
  const boxes = [
    mk('a1b2c3d4', 'alpha', { projectRoot: '/p/a', projectIndex: 1 }),
    mk('e5f6a7b8', 'beta', { projectRoot: '/p/a', projectIndex: 2 }),
    mk('33333333', 'three', { projectRoot: '/p/b', projectIndex: 1 }), // hex id starts with 3
  ];

  it('resolves undefined ref via auto-pick when project has exactly 1 box', () => {
    const r = resolveBoxRef(undefined, state(boxes), '/p/b');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.box.id).toBe('33333333');
  });

  it('returns ambiguous for undefined ref when project has 2+ boxes', () => {
    const r = resolveBoxRef(undefined, state(boxes), '/p/a');
    expect(r.kind).toBe('ambiguous');
  });

  it('returns none for undefined ref when projectRoot is unknown', () => {
    expect(resolveBoxRef(undefined, state(boxes), undefined).kind).toBe('none');
  });

  it('numeric ref resolves to project index in the current project', () => {
    const r = resolveBoxRef('2', state(boxes), '/p/a');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.box.id).toBe('e5f6a7b8');
  });

  it('numeric ref does NOT fall through to id-prefix when projectRoot is known', () => {
    // "3" would prefix-match the hex id "33333333" but only in /p/b. We ask
    // from /p/a where there's no box with projectIndex=3 → none.
    const r = resolveBoxRef('3', state(boxes), '/p/a');
    expect(r.kind).toBe('none');
  });

  it('numeric ref falls through to findBox when projectRoot is unknown', () => {
    // No project context → "3" is treated as id-prefix → matches "33333333".
    const r = resolveBoxRef('3', state(boxes), undefined);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.box.id).toBe('33333333');
  });

  it('non-numeric ref behaves exactly like findBox (id prefix)', () => {
    const r = resolveBoxRef('a1b2', state(boxes), '/p/a');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.box.id).toBe('a1b2c3d4');
  });

  it('non-numeric ref matches name regardless of projectRoot', () => {
    const r = resolveBoxRef('alpha', state(boxes), '/p/b');
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.box.name).toBe('alpha');
  });

  it('reserved-for-index: "0" is not a valid numeric ref (regex rejects it)', () => {
    // The regex is /^[1-9][0-9]*$/ so "0" doesn't match — falls through to
    // findBox, which won't match either.
    const r = resolveBoxRef('0', state(boxes), '/p/a');
    expect(r.kind).toBe('none');
  });
});
