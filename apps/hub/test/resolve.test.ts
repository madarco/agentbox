import { describe, expect, it } from 'vitest';
import type { Box } from '../lib/boxes/types';
import { resolveBoxRefView } from '../lib/boxes/resolve';

/** A minimal Box view row; only the fields the resolver reads are set. */
function box(p: Partial<Box> & { id: string }): Box {
  return {
    projectId: 'proj',
    repo: 'repo',
    branch: 'agentbox/x',
    task: p.name ?? p.id,
    agent: 'claude',
    status: 'running',
    createdAt: 0,
    lastActivity: 0,
    host: 'docker',
    provider: p.provider ?? 'docker',
    commits: null,
    filesTouched: null,
    ...p,
  };
}

describe('resolveBoxRefView', () => {
  const boxes: Box[] = [
    box({ id: 'a1b2c3d4', name: 'brave-otter', sandboxId: 'sb-42', provider: 'hetzner' }),
    box({ id: 'e5f6a7b8', name: 'calm-fox', sandboxId: 'e2b-9', provider: 'e2b' }),
    box({ id: 'z9z9z9z9', name: 'renamed', displayName: 'my-label' }),
    box({ id: 'idx1', name: 'first', projectRoot: '/home/u/proj', projectIndex: 1 }),
    box({ id: 'idx2', name: 'second', projectRoot: '/home/u/proj', projectIndex: 2 }),
  ];

  it('resolves an exact id', () => {
    expect(resolveBoxRefView(boxes, 'a1b2c3d4').map((b) => b.name)).toEqual(['brave-otter']);
  });

  it('resolves a unique id prefix', () => {
    expect(resolveBoxRefView(boxes, 'a1b2').map((b) => b.name)).toEqual(['brave-otter']);
  });

  it('returns all matches for an ambiguous id prefix (no arbitrary pick)', () => {
    const all: Box[] = [box({ id: 'a1b000', name: 'one' }), box({ id: 'a1b999', name: 'two' })];
    expect(
      resolveBoxRefView(all, 'a1b')
        .map((b) => b.name)
        .sort(),
    ).toEqual(['one', 'two']);
  });

  it('resolves by name when no id matches', () => {
    expect(resolveBoxRefView(boxes, 'calm-fox').map((b) => b.id)).toEqual(['e5f6a7b8']);
  });

  it('resolves by cosmetic displayName', () => {
    expect(resolveBoxRefView(boxes, 'my-label').map((b) => b.id)).toEqual(['z9z9z9z9']);
  });

  it('resolves by sandbox id and its cloud:<id> container spelling', () => {
    expect(resolveBoxRefView(boxes, 'sb-42').map((b) => b.name)).toEqual(['brave-otter']);
    expect(resolveBoxRefView(boxes, 'cloud:e2b-9').map((b) => b.name)).toEqual(['calm-fox']);
  });

  it('resolves a numeric project index when a project is given', () => {
    expect(resolveBoxRefView(boxes, '2', '/home/u/proj').map((b) => b.name)).toEqual(['second']);
  });

  it('a numeric ref never falls through to id matching (index is reserved)', () => {
    // `2` with a project that has no index 2 → none, not a stray id/name hit.
    expect(resolveBoxRefView(boxes, '2', '/home/u/other')).toEqual([]);
  });

  it('ignores index when no project is supplied (a bare numeric ref matches nothing here)', () => {
    expect(resolveBoxRefView(boxes, '2')).toEqual([]);
  });

  it('returns [] for an unknown ref and for an empty ref', () => {
    expect(resolveBoxRefView(boxes, 'ghost')).toEqual([]);
    expect(resolveBoxRefView(boxes, '   ')).toEqual([]);
  });
});
