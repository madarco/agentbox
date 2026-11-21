import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  cp,
  writeFile,
  symlink,
  readlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveContainerConfigVolume,
  withContainerConfigVolume,
} from '../src/sync/container-config.js';

const docker = vi.hoisted(() => ({ run: vi.fn(), pipe: vi.fn() }));
vi.mock('execa', () => ({ execa: (...args: unknown[]) => docker.run(...args) }));
vi.mock('../src/box-cp.js', () => ({
  streamTarPipe: (...args: unknown[]) => docker.pipe(...args),
}));

describe('resolveContainerConfigVolume', () => {
  it('uses the volume mounted at the agent config root', () => {
    const inspected = {
      Mounts: [
        { Type: 'volume', Name: 'claude-volume', Destination: '/home/vscode/.claude', RW: true },
        {
          Type: 'volume',
          Name: 'actual-codex-volume',
          Destination: '/home/vscode/.codex',
          RW: true,
        },
      ],
    };
    expect(resolveContainerConfigVolume(inspected, '/home/vscode/.codex')).toBe(
      'actual-codex-volume',
    );
  });

  it('does not invent Claude’s shared volume when it is unmounted', () => {
    const inspected = {
      Mounts: [
        { Type: 'volume', Name: 'codex-volume', Destination: '/home/vscode/.codex', RW: true },
      ],
    };
    expect(resolveContainerConfigVolume(inspected, '/home/vscode/.claude')).toBeUndefined();
  });

  it('uses copy-back for a bind-mounted config directory', () => {
    const inspected = {
      Mounts: [{ Type: 'bind', Destination: '/home/vscode/.codex', RW: true }],
    };
    expect(resolveContainerConfigVolume(inspected, '/home/vscode/.codex')).toBeUndefined();
  });

  it('refuses to sync through a read-only mount', () => {
    const inspected = {
      Mounts: [{ Type: 'volume', Name: 'readonly', Destination: '/home/vscode/.codex', RW: false }],
    };
    expect(() => resolveContainerConfigVolume(inspected, '/home/vscode/.codex')).toThrow(
      'read-only',
    );
  });

  it.each([null, {}, { Mounts: 'invalid' }])(
    'refuses missing or invalid inspection data instead of assuming no mount: %j',
    (inspected) => {
      expect(() => resolveContainerConfigVolume(inspected, '/home/vscode/.codex')).toThrow(
        'could not inspect container config mounts',
      );
    },
  );
});

describe('withContainerConfigVolume', () => {
  let root: string;
  let config: string;
  let volumes: Map<string, string>;
  let fault: ((args: string[]) => void) | undefined;
  const opts = { container: 'test-box', image: 'test-image', configDir: '/home/vscode/.codex' };

  function boxPath(path: string): string {
    return join(root, 'box', path);
  }

  function tarDirectory(args: string[]): string {
    const path = args[args.indexOf('-C') + 1]!;
    if (args[0] === 'exec') return boxPath(path);
    expect(path).toBe('/dst');
    expect(args).toContain('--rm');
    const volume = args[args.indexOf('-v') + 1]!.split(':')[0]!;
    return volumes.get(volume)!;
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agentbox-config-test-'));
    config = join(root, 'box', opts.configDir);
    volumes = new Map();
    fault = undefined;
    await mkdir(config, { recursive: true });
    await writeFile(join(config, 'config.toml'), 'old config');
    docker.pipe.mockReset().mockImplementation(async (sourceCommand, source, destCommand, dest) => {
      expect(sourceCommand).toBe('docker');
      expect(destCommand).toBe('docker');
      expect(source).toContain('-cf');
      expect(dest).toContain('-xf');
      expect(dest).toContain('-i');
      fault?.(source);
      fault?.(dest);
      const src = tarDirectory(source),
        dst = tarDirectory(dest);
      for (const entry of await readdir(src)) {
        await cp(join(src, entry), join(dst, entry), { recursive: true, verbatimSymlinks: true });
      }
      return [{ exitCode: 0 }, { exitCode: 0 }];
    });
    docker.run.mockReset();
    docker.run.mockImplementation(async (command: string, args: string[]) => {
      expect(command).toBe('docker');
      fault?.(args);
      if (args[0] === 'volume' && args[1] === 'create') {
        const path = join(root, 'volumes', args[2]!);
        await mkdir(path, { recursive: true });
        volumes.set(args[2]!, path);
      } else if (args[0] === 'volume' && args[1] === 'rm') {
        await rm(volumes.get(args[2]!)!, { recursive: true });
        volumes.delete(args[2]!);
      } else if (args[0] === 'exec') {
        const argv = args.slice(args.indexOf('test-box') + 1);
        if (argv[0] === 'mkdir') {
          await mkdir(boxPath(argv[2]!), { recursive: true });
        } else if (argv[0] === 'mktemp') {
          const path = '/tmp/agentbox-config-Test1234';
          await mkdir(boxPath(path), { recursive: true });
          return { stdout: `${path}\n` };
        } else if (argv[0] === 'rm') {
          await rm(boxPath(argv.at(-1)!), { recursive: true, force: true });
        } else if (argv[0] === 'sh') {
          expect(argv[2]).toBe('rsync -a --delete -- "$1/" "$2/" && chown -R "$3:$3" "$2"');
          // Real filesystem merge/delete, confined to the test directory. The
          // Docker transport and UID normalization are the simulated boundary.
          execFileSync('rsync', [
            '-a',
            '--delete',
            '--',
            `${boxPath(argv[4]!)}/`,
            `${boxPath(argv[5]!)}/`,
          ]);
          expect(argv[6]).toBe('vscode');
        } else throw new Error(`unexpected exec: ${argv}`);
      } else throw new Error(`unexpected docker command: ${args}`);
      return { stdout: '', exitCode: 0 };
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('merges host configuration into the existing tree and preserves credential links', async () => {
    await mkdir(join(config, 'plugins', 'box-added'), { recursive: true });
    await writeFile(join(config, 'plugins', 'box-added', 'settings'), 'keep me');
    const credential = '/home/vscode/.agentbox-creds/codex/auth.json';
    await symlink(credential, join(config, 'auth.json'));
    const result = await withContainerConfigVolume(opts, async (volume) => {
      const prepared = volumes.get(volume)!;
      expect(await readFile(join(prepared, 'config.toml'), 'utf8')).toBe('old config');
      await writeFile(join(prepared, 'config.toml'), 'provider = "custom"');
      await writeFile(join(prepared, 'hooks.json'), 'declared seed');
      return 'synced';
    });
    expect(result).toBe('synced');
    expect(await readFile(join(config, 'config.toml'), 'utf8')).toBe('provider = "custom"');
    expect(await readFile(join(config, 'plugins', 'box-added', 'settings'), 'utf8')).toBe(
      'keep me',
    );
    expect(await readFile(join(config, 'hooks.json'), 'utf8')).toBe('declared seed');
    expect(await readlink(join(config, 'auth.json'))).toBe(credential);
    expect(volumes.size).toBe(0);
  });

  it('reflects agent-specific purges when copying the prepared tree back', async () => {
    await writeFile(join(config, 'obsolete-plugin'), 'remove me');
    await withContainerConfigVolume(opts, async (volume) => {
      await rm(join(volumes.get(volume)!, 'obsolete-plugin'));
    });
    expect(await readdir(config)).toEqual(['config.toml']);
  });

  it('initializes an absent config root', async () => {
    await rm(config, { recursive: true });
    await withContainerConfigVolume(opts, async (volume) => {
      await writeFile(join(volumes.get(volume)!, 'config.toml'), 'fresh');
    });
    expect(await readFile(join(config, 'config.toml'), 'utf8')).toBe('fresh');
  });

  it('does not replace the live config when synchronization fails', async () => {
    const failure = new Error('host sync failed');
    await expect(
      withContainerConfigVolume(opts, async (volume) => {
        await writeFile(join(volumes.get(volume)!, 'config.toml'), 'partial');
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await readFile(join(config, 'config.toml'), 'utf8')).toBe('old config');
    expect(volumes.size).toBe(0);
  });

  it.each([0, 1])(
    'does not sync when tar process %i fails and still removes its volume',
    async (failed) => {
      const outcomes = [
        { exitCode: 0, stderr: '' },
        { exitCode: 0, stderr: '' },
      ];
      outcomes[failed] = { exitCode: 2, stderr: 'tar failed' };
      docker.pipe.mockResolvedValueOnce(outcomes);
      const sync = vi.fn();
      await expect(withContainerConfigVolume(opts, sync)).rejects.toThrow('tar failed');
      expect(sync).not.toHaveBeenCalled();
      expect(await readFile(join(config, 'config.toml'), 'utf8')).toBe('old config');
      expect(volumes.size).toBe(0);
    },
  );

  it.each([0, 1])(
    'does not apply partially transferred config when copy-back process %i fails',
    async (failed) => {
      const copy = docker.pipe.getMockImplementation()!;
      docker.pipe.mockImplementation(async (...args) => {
        const results = await copy(...args);
        if (args[1][0] === 'run') results[failed] = { exitCode: 2, stderr: 'copy failed' };
        return results;
      });
      await expect(
        withContainerConfigVolume(opts, async (volume) => {
          await writeFile(join(volumes.get(volume)!, 'config.toml'), 'new config');
        }),
      ).rejects.toThrow('copy failed');
      expect(await readFile(join(config, 'config.toml'), 'utf8')).toBe('old config');
      expect(volumes.size).toBe(0);
      expect(await readdir(join(root, 'box', 'tmp'))).toEqual([]);
    },
  );

  it('reports the original error together with a cleanup error', async () => {
    const original = new Error('sync failed');
    const cleanup = new Error('volume removal failed');
    fault = (args) => {
      if (args[0] === 'volume' && args[1] === 'rm') throw cleanup;
    };
    const result = await withContainerConfigVolume(opts, async () => {
      throw original;
    }).catch((error: AggregateError) => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect(result.errors).toEqual([original, cleanup]);
  });
});
