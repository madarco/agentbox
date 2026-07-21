import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isContainedInWorkspace,
  isInside,
  looksLikeSecret,
} from '../src/sync/containment.js';

describe('containment guards', () => {
  describe('looksLikeSecret', () => {
    it('flags .env and its variants', () => {
      expect(looksLikeSecret('/ws/.env')).toBe(true);
      expect(looksLikeSecret('/ws/.env.local')).toBe(true);
      expect(looksLikeSecret('/ws/sub/.env.production')).toBe(true);
    });

    it('flags private keys and cert bundles', () => {
      expect(looksLikeSecret('/ws/id_rsa')).toBe(true);
      expect(looksLikeSecret('/ws/id_ed25519')).toBe(true);
      expect(looksLikeSecret('/ws/server.pem')).toBe(true);
      expect(looksLikeSecret('/ws/tls.key')).toBe(true);
      expect(looksLikeSecret('/ws/cert.p12')).toBe(true);
    });

    it('flags credential basenames and sensitive dirs', () => {
      expect(looksLikeSecret('/ws/credentials')).toBe(true);
      expect(looksLikeSecret('/ws/.npmrc')).toBe(true);
      expect(looksLikeSecret('/home/u/.ssh/known_hosts')).toBe(true);
      expect(looksLikeSecret('/home/u/.aws/config')).toBe(true);
      expect(looksLikeSecret('/home/u/.config/gh/hosts.yml')).toBe(true);
    });

    it('does not flag ordinary source files or public keys', () => {
      expect(looksLikeSecret('/ws/src/index.ts')).toBe(false);
      expect(looksLikeSecret('/ws/README.md')).toBe(false);
      expect(looksLikeSecret('/ws/id_rsa.pub')).toBe(false);
      expect(looksLikeSecret('/ws/.config/app/settings.json')).toBe(false);
    });
  });

  describe('isInside', () => {
    it('is true for the dir itself and descendants, false for siblings', () => {
      expect(isInside('/ws', '/ws')).toBe(true);
      expect(isInside('/ws/a/b', '/ws')).toBe(true);
      expect(isInside('/ws-other/a', '/ws')).toBe(false);
      expect(isInside('/etc/passwd', '/ws')).toBe(false);
    });
  });

  describe('isContainedInWorkspace', () => {
    let ws: string;
    let outside: string;

    beforeEach(async () => {
      ws = await mkdtemp(join(tmpdir(), 'agentbox-ws-'));
      outside = await mkdtemp(join(tmpdir(), 'agentbox-out-'));
      await mkdir(join(ws, 'sub'), { recursive: true });
      await writeFile(join(ws, 'sub', 'file.txt'), 'hi');
      await writeFile(join(outside, 'secret.txt'), 'nope');
    });

    afterEach(async () => {
      await rm(ws, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    });

    it('accepts an existing file inside the workspace', async () => {
      expect(await isContainedInWorkspace(join(ws, 'sub', 'file.txt'), ws)).toBe(true);
    });

    it('accepts a not-yet-existing destination whose parent is inside', async () => {
      expect(await isContainedInWorkspace(join(ws, 'sub', 'new', 'out.txt'), ws)).toBe(true);
    });

    it('rejects an absolute path outside the workspace', async () => {
      expect(await isContainedInWorkspace(join(outside, 'secret.txt'), ws)).toBe(false);
    });

    it('rejects a literal .. traversal', async () => {
      expect(await isContainedInWorkspace(join(ws, '..', 'escape.txt'), ws)).toBe(false);
    });

    it('rejects an in-workspace symlink pointing outside (realpath escapes)', async () => {
      const link = join(ws, 'link');
      await symlink(outside, link);
      expect(await isContainedInWorkspace(join(link, 'secret.txt'), ws)).toBe(false);
    });

    it('rejects relative paths and an unknown workspace', async () => {
      expect(await isContainedInWorkspace('sub/file.txt', ws)).toBe(false);
      expect(await isContainedInWorkspace(join(ws, 'sub', 'file.txt'), undefined)).toBe(false);
    });
  });
});
