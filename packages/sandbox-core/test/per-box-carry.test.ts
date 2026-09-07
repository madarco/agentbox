import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clonePerBoxCarryRefusal,
  perBoxCarrySrc,
  resolvePerBoxCarry,
  withPerBoxCarry,
} from '../src/per-box-carry.js';

/** The openclaw shape: one per-box env file, optional, 0600. */
const spec = {
  clone: {
    perBoxCarry: [
      {
        src: '~/.agentbox/openclaw/{{AGENTBOX_BOX_NAME}}.env',
        dest: '~/.openclaw/.env',
        mode: 0o600,
        optional: true,
      },
    ],
  },
} as const;

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agentbox-perbox-'));
  await mkdir(join(home, '.agentbox', 'openclaw'), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('perBoxCarrySrc', () => {
  it('substitutes the box name and expands ~', () => {
    expect(
      perBoxCarrySrc('~/.agentbox/openclaw/{{AGENTBOX_BOX_NAME}}.env', { boxName: 'bea', home }),
    ).toBe(join(home, '.agentbox/openclaw/bea.env'));
  });

  it('is what makes two bots differ — the same spec resolves per box', () => {
    const a = perBoxCarrySrc(spec.clone.perBoxCarry[0].src, { boxName: 'ada', home });
    const b = perBoxCarrySrc(spec.clone.perBoxCarry[0].src, { boxName: 'bea', home });
    expect(a).not.toBe(b);
  });

  it('refuses a relative source rather than guessing a cwd', () => {
    expect(() => perBoxCarrySrc('secrets/.env', { boxName: 'bea', home })).toThrow(/absolute/);
  });
});

describe('resolvePerBoxCarry', () => {
  it('resolves an existing file into a carry entry, keeping the mode', async () => {
    await writeFile(join(home, '.agentbox/openclaw/bea.env'), 'TOKEN=x\n');
    const r = await resolvePerBoxCarry(spec, { boxName: 'bea', home });
    expect(r.missing).toEqual([]);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({
      absSrc: join(home, '.agentbox/openclaw/bea.env'),
      // Left `~/`-relative on purpose: the box user's uid (and so its home)
      // differs per provider, so the box expands it, not the host.
      absDest: '~/.openclaw/.env',
      kind: 'file',
      mode: 0o600,
    });
  });

  it('reports a missing file instead of throwing — the two callers disagree', async () => {
    const r = await resolvePerBoxCarry(spec, { boxName: 'bea', home });
    expect(r.entries).toEqual([]);
    expect(r.missing).toEqual([
      {
        path: join(home, '.agentbox/openclaw/bea.env'),
        rawSrc: '~/.agentbox/openclaw/{{AGENTBOX_BOX_NAME}}.env',
        optional: true,
      },
    ]);
  });

  it('refuses a directory where a file was declared', async () => {
    await mkdir(join(home, '.agentbox/openclaw/bea.env'));
    await expect(resolvePerBoxCarry(spec, { boxName: 'bea', home })).rejects.toThrow(
      /not a regular file/,
    );
  });

  it('is a no-op for an agent that declares nothing', async () => {
    const r = await resolvePerBoxCarry({ clone: {} }, { boxName: 'bea', home });
    expect(r).toEqual({ entries: [], missing: [] });
  });
});

describe('clonePerBoxCarryRefusal', () => {
  it('refuses even an OPTIONAL missing file — a clone is the collision case', () => {
    const msg = clonePerBoxCarryRefusal(
      [{ path: '/h/.agentbox/openclaw/bea.env', rawSrc: '~/x', optional: true }],
      'bea',
    );
    expect(msg).toContain('/h/.agentbox/openclaw/bea.env');
    expect(msg).toMatch(/bea/);
  });

  it('is null when nothing is missing', () => {
    expect(clonePerBoxCarryRefusal([], 'bea')).toBeNull();
  });
});

describe('withPerBoxCarry', () => {
  it('appends the agent entry after the user-approved ones', async () => {
    await writeFile(join(home, '.agentbox/openclaw/bea.env'), 'TOKEN=x\n');
    const approved = [
      {
        rawSrc: '~/a',
        rawDest: '~/a',
        absSrc: '/h/a',
        absDest: '~/a',
        kind: 'file' as const,
        optional: false,
      },
    ];
    const out = await withPerBoxCarry(approved, [spec], { boxName: 'bea', home });
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.absSrc)).toEqual(['/h/a', join(home, '.agentbox/openclaw/bea.env')]);
  });

  it('continues past an OPTIONAL miss on an ordinary create, and says which path', async () => {
    const lines: string[] = [];
    const out = await withPerBoxCarry(undefined, [spec], { boxName: 'solo', home }, (l) =>
      lines.push(l),
    );
    expect(out).toEqual([]);
    expect(lines.join('\n')).toContain(join(home, '.agentbox/openclaw/solo.env'));
  });

  it('throws on a NON-optional miss, naming the file to create', async () => {
    const required = {
      clone: {
        perBoxCarry: [
          { src: '~/.agentbox/openclaw/{{AGENTBOX_BOX_NAME}}.env', dest: '~/.openclaw/.env' },
        ],
      },
    };
    await expect(withPerBoxCarry(undefined, [required], { boxName: 'bea', home })).rejects.toThrow(
      join(home, '.agentbox/openclaw/bea.env'),
    );
  });

  it('passes the approved list straight through for an agent with no clone spec', async () => {
    const out = await withPerBoxCarry([], [undefined, { clone: {} }], { boxName: 'bea', home });
    expect(out).toEqual([]);
  });
});
