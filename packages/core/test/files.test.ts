import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDownloadKind, resolveHostPath } from '../src/sync/files.js';

describe('files pure decisions', () => {
  describe('parseDownloadKind', () => {
    it('defaults a bare method to workspace', () => {
      expect(parseDownloadKind('download')).toBe('workspace');
    });
    it('reads the suffix kind', () => {
      expect(parseDownloadKind('download.env')).toBe('env');
      expect(parseDownloadKind('download.config')).toBe('config');
      expect(parseDownloadKind('download.claude')).toBe('claude');
      expect(parseDownloadKind('download.workspace')).toBe('workspace');
    });
    it('falls back to workspace on a malformed method', () => {
      expect(parseDownloadKind('')).toBe('workspace');
    });
  });

  describe('resolveHostPath', () => {
    it('passes an absolute path through untouched', () => {
      expect(resolveHostPath('/box/ws', '/etc/hosts')).toBe('/etc/hosts');
    });
    it('expands a bare ~ to the host home', () => {
      expect(resolveHostPath('/box/ws', '~')).toBe(homedir());
    });
    it('expands ~/ against the host home (not the workspace)', () => {
      expect(resolveHostPath('/box/ws', '~/.claude')).toBe(join(homedir(), '.claude'));
    });
    it('resolves a relative path against the box workspace', () => {
      expect(resolveHostPath('/box/ws', 'sub/dir')).toBe(resolve('/box/ws', 'sub/dir'));
    });
    it('falls back to process CWD when workspace is unknown', () => {
      expect(resolveHostPath(undefined, 'sub/dir')).toBe(resolve('sub/dir'));
    });
  });
});
