import { describe, expect, it } from 'vitest';
import { isUnderWorkdir, mapState, parseTenkiSize, previewSlug, safeName } from '../src/backend.js';

describe('mapState', () => {
  it('maps running-ish states to running', () => {
    for (const s of ['RUNNING', 'CREATING', 'RESUMING'] as const) {
      expect(mapState(s)).toBe('running');
    }
  });

  it('maps pausing/paused/user-shutdown to paused', () => {
    for (const s of ['PAUSED', 'PAUSING', 'USER_SHUTDOWN'] as const) {
      expect(mapState(s)).toBe('paused');
    }
  });

  it('maps terminal / unknown / undefined to missing', () => {
    for (const s of ['TERMINATING', 'TERMINATED', 'UNSPECIFIED'] as const) {
      expect(mapState(s)).toBe('missing');
    }
    expect(mapState(undefined)).toBe('missing');
  });
});

describe('previewSlug', () => {
  it('is stable + DNS-safe per (session, port)', () => {
    const a = previewSlug('sess_AbC123XyZ789', 8080);
    expect(a).toBe(previewSlug('sess_AbC123XyZ789', 8080));
    expect(a).toMatch(/^ab-[a-z0-9]+-8080$/);
  });

  it('differs by port', () => {
    expect(previewSlug('sess_x', 80)).not.toBe(previewSlug('sess_x', 6080));
  });

  it('falls back to a non-empty slug for an id with no alnum chars', () => {
    expect(previewSlug('___', 80)).toBe('ab-box-80');
  });
});

describe('safeName', () => {
  it('keeps hyphens and alphanumerics (box names are not mangled)', () => {
    expect(safeName('my-box-123')).toBe('my-box-123');
  });

  it('strips control characters (newlines/tabs)', () => {
    expect(safeName('a\nb\tc')).toBe('abc');
  });

  it('caps length at 200', () => {
    expect(safeName('x'.repeat(500)).length).toBe(200);
  });
});

describe('isUnderWorkdir', () => {
  it('treats relative paths as under the workdir (RPC resolves them there)', () => {
    expect(isUnderWorkdir('seed.tar.gz', '/home/tenki')).toBe(true);
    expect(isUnderWorkdir('sub/dir/file', '/home/tenki')).toBe(true);
  });

  it('accepts the workdir itself and paths beneath it', () => {
    expect(isUnderWorkdir('/home/tenki', '/home/tenki')).toBe(true);
    expect(isUnderWorkdir('/home/tenki/', '/home/tenki')).toBe(true);
    expect(isUnderWorkdir('/home/tenki/a/b.txt', '/home/tenki')).toBe(true);
    expect(isUnderWorkdir('/workspace/a', '/workspace/')).toBe(true);
  });

  it('rejects absolute paths outside the workdir (the exec-bridge case)', () => {
    expect(isUnderWorkdir('/tmp/agentbox-workspace.tar.gz', '/home/tenki')).toBe(false);
    expect(isUnderWorkdir('/workspace/x', '/home/tenki')).toBe(false);
  });

  it('is not fooled by a shared name prefix', () => {
    expect(isUnderWorkdir('/home/tenki-evil/x', '/home/tenki')).toBe(false);
  });

  it('normalizes traversal before comparing', () => {
    expect(isUnderWorkdir('/home/tenki/../etc/passwd', '/home/tenki')).toBe(false);
  });
});

describe('parseTenkiSize', () => {
  it('parses cpu-memory (GB)', () => {
    expect(parseTenkiSize('4-8')).toEqual({ cpu: 4, memoryGb: 8, diskGb: undefined });
  });

  it('parses cpu-memory-disk (GB)', () => {
    expect(parseTenkiSize('4-8-20')).toEqual({ cpu: 4, memoryGb: 8, diskGb: 20 });
  });

  it('rejects malformed / non-positive / wrong-arity specs', () => {
    for (const s of ['', '4', '4-8-20-1', '0-8', '4-0', '-1-8', 'a-b', '4.5-8']) {
      expect(parseTenkiSize(s)).toBeUndefined();
    }
    expect(parseTenkiSize(undefined)).toBeUndefined();
  });
});
