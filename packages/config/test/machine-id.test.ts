import { execFile, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getMachineId,
  getMachineLabel,
  isMachineId,
  machineIdFile,
  machineKeyFor,
  machineKeyIn,
  sameMachine,
  sameMachineRef,
  thisMachine,
  tryGetMachineId,
} from '../src/machine-id.js';

const A = '11111111-2222-4333-8444-555555555555';
const B = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const REAL_HOME = process.env['HOME'];

/** A fresh $HOME per test: the id file is resolved against the current one. */
function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'agentbox-mid-'));
  process.env['HOME'] = home;
  return home;
}

afterEach(() => {
  if (REAL_HOME !== undefined) process.env['HOME'] = REAL_HOME;
});

describe('getMachineId', () => {
  it('mints a UUID once, 0600, and returns the same one on every later call', () => {
    const home = freshHome();
    const id = getMachineId();
    expect(isMachineId(id)).toBe(true);
    expect(machineIdFile()).toBe(join(home, '.agentbox', 'machine-id'));
    expect(readFileSync(machineIdFile(), 'utf8').trim()).toBe(id);
    expect(statSync(machineIdFile()).mode & 0o777).toBe(0o600);
    expect(getMachineId()).toBe(id);
  });

  it('never regenerates an id that is already on disk', () => {
    const home = freshHome();
    mkdirSync(join(home, '.agentbox'), { recursive: true });
    writeFileSync(join(home, '.agentbox', 'machine-id'), `${A}\n`);
    expect(getMachineId()).toBe(A);
  });

  it('replaces a file that holds no id (a crash between create and write)', () => {
    const home = freshHome();
    mkdirSync(join(home, '.agentbox'), { recursive: true });
    writeFileSync(join(home, '.agentbox', 'machine-id'), '');
    const id = getMachineId();
    expect(isMachineId(id)).toBe(true);
    expect(readFileSync(machineIdFile(), 'utf8').trim()).toBe(id);
  });

  it('never overwrites an id file it cannot read', () => {
    const home = freshHome();
    const file = join(home, '.agentbox', 'machine-id');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${A}\n`);
    chmodSync(file, 0o000);
    try {
      expect(() => getMachineId()).toThrow(/EACCES/);
      expect(tryGetMachineId()).toBeUndefined();
    } finally {
      chmodSync(file, 0o600);
    }
    expect(readFileSync(file, 'utf8').trim()).toBe(A);
  });

  it('waits for a repair another process holds the lock for, and takes its id', () => {
    const home = freshHome();
    const file = join(home, '.agentbox', 'machine-id');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'garbage');
    mkdirSync(`${file}.lock`);
    const child = spawn(
      process.execPath,
      [
        '-e',
        `setTimeout(() => { const fs = require('fs'); fs.writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(`${B}\n`)}); fs.rmdirSync(${JSON.stringify(`${file}.lock`)}); }, 300)`,
      ],
      { stdio: 'ignore' },
    );
    try {
      expect(getMachineId()).toBe(B);
    } finally {
      child.kill();
    }
  });

  it('takes over a lock a crashed repairer left behind', () => {
    const home = freshHome();
    const file = join(home, '.agentbox', 'machine-id');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'garbage');
    mkdirSync(`${file}.lock`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${file}.lock`, old, old);
    const id = getMachineId();
    expect(isMachineId(id)).toBe(true);
    expect(readFileSync(file, 'utf8').trim()).toBe(id);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  it('converges on one id when many processes repair a corrupt file at once', async () => {
    const home = freshHome();
    const file = join(home, '.agentbox', 'machine-id');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'garbage');
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const src = resolve(dirname(fileURLToPath(import.meta.url)), '../src/machine-id.ts');
    const run = promisify(execFile);
    const ids = await Promise.all(
      Array.from({ length: 8 }, () =>
        run(
          process.execPath,
          [
            '--import',
            'tsx',
            '-e',
            `import(${JSON.stringify(src)}).then((m) => process.stdout.write(m.getMachineId()))`,
          ],
          { cwd: repoRoot, env: { ...process.env, HOME: home } },
        ).then((r) => r.stdout.trim()),
      ),
    );
    const onDisk = readFileSync(file, 'utf8').trim();
    expect(isMachineId(onDisk)).toBe(true);
    expect(new Set(ids)).toEqual(new Set([onDisk]));
  }, 30_000);

  it('degrades to no id (hostname matching) when the home cannot hold one', () => {
    const home = freshHome();
    // A HOME that is a file: ~/.agentbox cannot be created under it.
    const file = join(home, 'not-a-dir');
    writeFileSync(file, '');
    process.env['HOME'] = file;
    expect(tryGetMachineId()).toBeUndefined();
    expect(thisMachine()).toEqual({ label: hostname() });
    expect(() => getMachineId()).toThrow();
  });

  it('labels the machine with its hostname', () => {
    expect(getMachineLabel()).toBe(hostname());
  });
});

describe('sameMachine', () => {
  it('decides by id alone when both sides have one, whatever the hostnames say', () => {
    // A flip: same machine, new name.
    expect(sameMachine({ machineId: A, host: 'mac.local' }, { id: A, label: 'mac-2.local' })).toBe(
      true,
    );
    // Two machines that share a hostname.
    expect(sameMachine({ machineId: A, host: 'mac.local' }, { id: B, label: 'mac.local' })).toBe(
      false,
    );
  });

  it('falls back to the hostname for a record or a caller from before machine ids', () => {
    expect(sameMachine({ host: 'mac.local' }, { id: A, label: 'mac.local' })).toBe(true);
    expect(sameMachine({ host: 'mac.local' }, { id: A, label: 'mac-2.local' })).toBe(false);
    expect(sameMachine({ machineId: A, host: 'mac.local' }, 'mac.local')).toBe(true);
    expect(sameMachineRef({ id: A, label: 'x' }, { id: A, label: 'y' })).toBe(true);
  });
});

describe('machineKeyIn', () => {
  it('finds a machine by id, then by a legacy hostname key, never an id entry by label', () => {
    const hosts = { [A]: { label: 'mac.local' }, 'desk.lan': {} };
    expect(machineKeyIn(hosts, { id: A, label: 'mac-2.local' })).toBe(A);
    expect(machineKeyIn(hosts, { id: B, label: 'desk.lan' })).toBe('desk.lan');
    // A hostname alone never claims an id-keyed entry: another machine may share it.
    expect(machineKeyIn(hosts, 'mac.local')).toBeUndefined();
    // Nor does a caller WITH an id claims another machine's id-keyed entry by name.
    expect(machineKeyIn(hosts, { id: B, label: 'mac.local' })).toBeUndefined();
  });

  it('writes under the id when there is one', () => {
    expect(machineKeyFor({ id: A, label: 'mac.local' })).toBe(A);
    expect(machineKeyFor('mac.local')).toBe('mac.local');
  });
});
