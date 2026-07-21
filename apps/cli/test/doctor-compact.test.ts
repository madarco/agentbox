/**
 * Unit tests for `formatCompact` — the one-line summary the install wizard
 * prints. A warn in the system group must name the warning checks (with
 * optional deps labelled as such) instead of an opaque "system warn".
 */

import { describe, expect, it } from 'vitest';
import { formatCompact, type CheckGroup } from '../src/lib/doctor-checks.js';

const ok = (label: string): CheckGroup['results'][number] => ({
  label,
  status: 'ok',
  detail: 'fine',
});

describe('formatCompact — system group', () => {
  it('reports plain ok when nothing warns', () => {
    const group: CheckGroup = { title: 'system', results: [ok('node'), ok('git')] };
    expect(formatCompact([group])).toContain('system ok');
  });

  it('names warning checks, marking optional deps', () => {
    const group: CheckGroup = {
      title: 'system',
      results: [
        ok('node'),
        { label: 'git', status: 'warn', detail: 'not found', hint: 'install git' },
        {
          label: 'sshfs',
          status: 'warn',
          detail: 'not found',
          hint: 'optional: `brew install macfuse sshfs`',
        },
        {
          label: 'macfuse',
          status: 'warn',
          detail: 'not installed',
          hint: 'optional: `brew install macfuse`',
        },
      ],
    };
    expect(formatCompact([group])).toContain('system warn: git, optional sshfs, macfuse');
  });

  it('renders an all-optional warn set without a leading comma', () => {
    const group: CheckGroup = {
      title: 'system',
      results: [
        ok('node'),
        { label: 'sshfs', status: 'warn', detail: 'not found', hint: 'optional: sshfs' },
      ],
    };
    expect(formatCompact([group])).toContain('system warn: optional sshfs');
  });
});
