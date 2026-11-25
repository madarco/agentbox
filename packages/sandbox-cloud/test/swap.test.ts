import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { totalmem, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { SWAP_SCRIPT_PATH, parseSwapSpec, swapCloudInit, swapScript } from '../src/swap.js';

describe('parseSwapSpec', () => {
  it.each([
    [undefined, 'auto'],
    ['', 'auto'],
    ['auto', 'auto'],
    [' AUTO ', 'auto'],
    ['off', 'off'],
    ['0', 'off'],
    ['4G', { mib: 4096 }],
    ['4g', { mib: 4096 }],
    ['4GiB', { mib: 4096 }],
    ['2048M', { mib: 2048 }],
    ['6', { mib: 6144 }],
  ])('%j -> %j', (raw, want) => {
    expect(parseSwapSpec(raw)).toEqual(want);
  });

  it.each(['lots', '4T', '-1G', '100M', '65G', '4.5G'])('rejects %j', (raw) => {
    expect(() => parseSwapSpec(raw)).toThrow(/invalid box\.swap/);
  });
});

describe('swapCloudInit', () => {
  const wrap = (spec: Parameters<typeof swapCloudInit>[0]): Record<string, unknown> => {
    const frag = swapCloudInit(spec);
    return parse(
      ['#cloud-config', 'write_files:', ...frag.writeFile, 'runcmd:', ...frag.runcmd].join('\n'),
    ) as Record<string, unknown>;
  };

  it('writes the script verbatim and runs it with the spec', () => {
    const doc = wrap({ mib: 4096 });
    const files = doc.write_files as Array<{ path: string; permissions: string; content: string }>;
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe(SWAP_SCRIPT_PATH);
    expect(files[0]!.permissions).toBe('0755');
    expect(files[0]!.content).toBe(swapScript());
    expect(doc.runcmd).toEqual([['sh', '-c', `${SWAP_SCRIPT_PATH} 4096 || true`]]);
  });

  it('passes auto and off through', () => {
    expect(wrap('auto').runcmd).toEqual([['sh', '-c', `${SWAP_SCRIPT_PATH} auto || true`]]);
    expect(wrap('off').runcmd).toEqual([['sh', '-c', `${SWAP_SCRIPT_PATH} off || true`]]);
  });

  it('stays ASCII (DigitalOcean truncates user-data at the first non-ASCII byte)', () => {
    const frag = swapCloudInit('auto');
    expect([...frag.writeFile, ...frag.runcmd].join('\n')).toMatch(/^[\x00-\x7f]*$/);
  });

  it('is valid POSIX sh', () => {
    const r = spawnSync('sh', ['-n'], { input: swapScript() });
    expect(r.status, r.stderr.toString()).toBe(0);
  });
});

/**
 * Runs the real script against PATH shims for swapon/swapoff/mkswap/sysctl/
 * fallocate/df, with the file, fstab and sysctl paths pointed into a temp dir.
 * The shims keep the "active swaps" list in a file, so the idempotency, resize
 * and off paths are exercised without touching the machine's swap or disk.
 */
describe.runIf(process.platform === 'linux')('swap script (shimmed)', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;
  const memMib = Math.floor(totalmem() / 1024 / 1024);
  const autoMib = Math.min(Math.max(memMib, 2048), 8192);

  const shim = (name: string, body: string): void => {
    const p = join(dir, 'bin', name);
    writeFileSync(p, `#!/bin/sh\nS=${dir}/state\n${body}\n`);
    chmodSync(p, 0o755);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentbox-swap-'));
    execFileSync('mkdir', ['-p', join(dir, 'bin'), join(dir, 'state')]);
    writeFileSync(join(dir, 'state', 'active'), '');
    writeFileSync(join(dir, 'state', 'avail'), '100000');
    writeFileSync(join(dir, 'fstab'), 'UUID=x / ext4 defaults 0 1\n');
    shim(
      'swapon',
      [
        'if [ "$1" = "--show=NAME" ]; then cat $S/active; exit 0; fi',
        '[ -f $S/swapon_fail ] && exit 1',
        'echo "$1" >> $S/active',
      ].join('\n'),
    );
    shim('swapoff', 'grep -vx "$1" $S/active > $S/a.tmp; mv $S/a.tmp $S/active');
    shim('mkswap', 'echo "$1" >> $S/mkswap');
    shim('sysctl', 'exit 0');
    // Sparse file: the script only reads its size.
    shim('fallocate', 'truncate -s "$2" "$3"');
    shim(
      'df',
      'echo "Filesystem 1M-blocks Used Available Use% Mounted"; echo "/dev/x 100000 0 $(cat $S/avail) 0% /"',
    );
    env = {
      ...process.env,
      PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`,
      AGENTBOX_SWAP_FILE: join(dir, 'swapfile'),
      AGENTBOX_SWAP_FSTAB: join(dir, 'fstab'),
      AGENTBOX_SWAP_SYSCTL_CONF: join(dir, 'sysctl.conf'),
    };
    writeFileSync(join(dir, 'agentbox-swap'), swapScript());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const run = (arg: string): { status: number | null; out: string } => {
    const r = spawnSync('sh', [join(dir, 'agentbox-swap'), arg], { env });
    return { status: r.status, out: r.stdout.toString() + r.stderr.toString() };
  };
  const active = (): string[] =>
    readFileSync(join(dir, 'state', 'active'), 'utf8')
      .split('\n')
      .filter(Boolean);
  const fstabLines = (): string[] =>
    readFileSync(join(dir, 'fstab'), 'utf8')
      .split('\n')
      .filter((l) => l.startsWith(join(dir, 'swapfile') + ' '));
  const sizeMib = (): number => statSync(join(dir, 'swapfile')).size / 1024 / 1024;

  it('auto creates a RAM-sized swapfile, fstab line and swappiness, once', () => {
    expect(run('auto').status).toBe(0);
    expect(sizeMib()).toBe(autoMib);
    expect(active()).toEqual([join(dir, 'swapfile')]);
    expect(fstabLines()).toHaveLength(1);
    expect(readFileSync(join(dir, 'sysctl.conf'), 'utf8')).toBe('vm.swappiness=10\n');

    // Second run (a re-run cloud-init, a resumed box): no duplicate swap or fstab line.
    expect(run('auto').status).toBe(0);
    expect(active()).toHaveLength(1);
    expect(fstabLines()).toHaveLength(1);
    expect(
      readFileSync(join(dir, 'state', 'mkswap'), 'utf8')
        .split('\n')
        .filter(Boolean),
    ).toHaveLength(1);
  });

  it('re-activates an existing inactive swapfile (checkpoint restore) without recreating it', () => {
    execFileSync('truncate', ['-s', '1G', join(dir, 'swapfile')]);
    expect(run('auto').status).toBe(0);
    expect(sizeMib()).toBe(1024);
    expect(active()).toEqual([join(dir, 'swapfile')]);
    expect(fstabLines()).toHaveLength(1);
  });

  it('caps auto at a quarter of the free disk', () => {
    writeFileSync(join(dir, 'state', 'avail'), '4000');
    expect(run('auto').status).toBe(0);
    expect(sizeMib()).toBe(Math.min(autoMib, 1000));
  });

  it('skips when the disk has no room for even a small swapfile', () => {
    writeFileSync(join(dir, 'state', 'avail'), '800');
    const r = run('auto');
    expect(r.status).toBe(0);
    expect(r.out).toContain('not enough free disk');
    expect(active()).toEqual([]);
  });

  it('resizes to an explicit size, and leaves the old swap when the new one does not fit', () => {
    expect(run('2048').status).toBe(0);
    expect(sizeMib()).toBe(2048);
    expect(run('1024').status).toBe(0);
    expect(sizeMib()).toBe(1024);
    expect(active()).toEqual([join(dir, 'swapfile')]);

    writeFileSync(join(dir, 'state', 'avail'), '3000');
    expect(run('4096').status).toBe(1);
    expect(sizeMib()).toBe(1024);
    expect(active()).toEqual([join(dir, 'swapfile')]);
  });

  it('leaves swap that is not ours alone', () => {
    writeFileSync(join(dir, 'state', 'active'), '/dev/zram0\n');
    const r = run('auto');
    expect(r.status).toBe(0);
    expect(r.out).toContain('existing swap /dev/zram0');
    expect(fstabLines()).toHaveLength(0);
  });

  it('off removes the swapfile, its fstab line and the sysctl drop-in, and is repeatable', () => {
    expect(run('auto').status).toBe(0);
    expect(run('off').status).toBe(0);
    expect(active()).toEqual([]);
    expect(fstabLines()).toHaveLength(0);
    expect(readFileSync(join(dir, 'fstab'), 'utf8')).toBe('UUID=x / ext4 defaults 0 1\n');
    expect(() => statSync(join(dir, 'swapfile'))).toThrow();
    expect(() => statSync(join(dir, 'sysctl.conf'))).toThrow();
    expect(run('off').status).toBe(0);
  });
});
