import { beforeEach, describe, expect, it, vi } from 'vitest';

// Fake docker: a set of container names; `ps` lists, `container inspect`
// probes, `rename` / `rm -f` change the set.
const containers = new Set<string>();
const calls: string[][] = [];
vi.mock('execa', () => ({
  execa: vi.fn(async (_cmd: string, args: string[]) => {
    calls.push(args);
    if (args[0] === 'ps') {
      const re = new RegExp(args[3]!.slice('name='.length).replace('/', ''));
      return { stdout: [...containers].filter((n) => re.test(n)).join('\n'), exitCode: 0 };
    }
    if (args[0] === 'container') return { stdout: '', exitCode: containers.has(args[2]!) ? 0 : 1 };
    if (args[0] === 'rename') {
      containers.delete(args[1]!);
      containers.add(args[2]!);
    }
    if (args[0] === 'rm') containers.delete(args[2]!);
    return { stdout: '', exitCode: 0 };
  }),
}));

const { recoverParkedContainers, removeParkedContainers } = await import(
  '../src/switch-images.js'
);

beforeEach(() => {
  containers.clear();
  calls.length = 0;
});

describe('parked switch containers (hub settings 3c)', () => {
  it('brings the newest parked container back when the box has none, and removes the rest', async () => {
    containers.add('agentbox-web-pre-switch-a1');
    containers.add('agentbox-web-pre-switch-b2');
    containers.add('agentbox-other');
    await recoverParkedContainers('agentbox-web');
    expect([...containers].sort()).toEqual(['agentbox-other', 'agentbox-web']);
  });

  it('a start keeps the others (a running switch may still need its parked one)', async () => {
    containers.add('agentbox-web');
    containers.add('agentbox-web-pre-switch-a1');
    await recoverParkedContainers('agentbox-web', { removeOthers: false });
    expect([...containers].sort()).toEqual(['agentbox-web', 'agentbox-web-pre-switch-a1']);
  });

  it('destroy removes every parked container', async () => {
    containers.add('agentbox-web');
    containers.add('agentbox-web-pre-switch-a1');
    await removeParkedContainers('agentbox-web');
    expect([...containers]).toEqual(['agentbox-web']);
  });
});
