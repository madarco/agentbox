import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import type {
  CloudBackend,
  CloudExecOptions,
  CloudFileEntry,
  CloudHandle,
  CloudProvisionRequest,
  CloudSandboxSummary,
  CloudState,
} from '@madarco/agentbox-provider-sdk';
import { Machine } from 'smolmachines';
import { runSmolCli } from './cli.js';

const owned = 'agentbox-smol-';
const guestPorts = [80, 6080, 8788];
const connection = { target: 'local', handleSignals: false, waitForPorts: false } as const;

function stateOf(state: string): CloudState {
  if (state === 'running' || state === 'started') return 'running';
  if (state === 'paused' || state === 'frozen' || state === 'pausing') return 'paused';
  return 'stopped';
}

async function summary(id: string) {
  return (await Machine.list(connection)).find(
    (m) => m.name === id && m.labels?.agentbox === 'smol',
  );
}

async function connect(h: CloudHandle): Promise<Machine> {
  return Machine.connect(h.sandboxId, connection);
}

async function availablePort(): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Cannot allocate a local Smol port');
    return address.port;
  } finally {
    server.close();
  }
}

function resources(req: CloudProvisionRequest) {
  const size = req.size?.match(/^(\d+)-(\d+)-(\d+)$/);
  if (req.size && !size) throw new Error('Smol size must be cpu-memory-disk in GiB, e.g. 2-4-20');
  const cpus = size ? Number(size[1]) : (req.resources?.cpu ?? 2);
  const memory = size ? Number(size[2]) : (req.resources?.memory ?? 4);
  const disk = size ? Number(size[3]) : (req.resources?.disk ?? 20);
  if (![cpus, memory, disk].every((x) => Number.isInteger(x) && x > 0)) {
    throw new Error('Smol resources must be positive integers');
  }
  return { cpu: cpus, memory, disk };
}

/** AgentBox's cloud-shaped contract, backed by persistent local SmolVMs. */
export const smolBackend: CloudBackend = {
  name: 'smol',
  stageFilesAsRoot: true,
  async provision(req) {
    if (req.snapshot) throw new Error('Smol checkpoints are not supported by this provider yet');
    if (
      req.networkPolicy &&
      req.networkPolicy !== 'allow-all' &&
      req.networkPolicy !== 'deny-all'
    ) {
      throw new Error('Smol provider accepts allow-all or deny-all network policies');
    }
    const name = `${owned}${req.name.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 35)}-${randomBytes(4).toString('hex')}`;
    const allocation = resources(req);
    const ports = [...new Set([...guestPorts, ...(req.exposePorts ?? [])])];
    for (const port of ports) {
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error(`Invalid guest port ${port}`);
    }
    const mappings = [];
    for (const guest of ports) mappings.push({ guest, host: await availablePort() });
    const machine = await Machine.create(
      {
        name,
        image: req.image,
        labels: { agentbox: 'smol' },
        persistent: true,
        detach: true,
        waitForPorts: false,
        ports: mappings,
        network: req.networkPolicy !== 'deny-all',
        resources: {
          cpus: allocation.cpu,
          memoryMb: allocation.memory * 1024,
          storageGb: allocation.disk,
        },
        ...(req.env ? { env: req.env } : {}),
      },
      connection,
    );
    try {
      // Smol's fresh storage mount currently hides the image's vscode-owned
      // /workspace. Give it to the box user before AgentBox seeds its git tree.
      const fix = await machine.exec(['chown', 'vscode:vscode', '/workspace'], { user: 'root' });
      if (fix.exitCode !== 0) throw new Error(`Cannot prepare /workspace: ${fix.stderr}`);
      // The image's static hosts file may not resolve the VM hostname; sudo
      // needs that name during AgentBox's workspace bootstrap.
      const hostname = (await machine.exec(['hostname'])).stdout.trim();
      if (!/^[a-zA-Z0-9.-]+$/.test(hostname)) throw new Error('Invalid guest hostname');
      const found = await machine.exec(['getent', 'hosts', hostname]);
      if (found.exitCode !== 0) {
        const add = await machine.exec(
          ['sh', '-c', `printf '127.0.1.1 %s\n' '${hostname}' >>/etc/hosts`],
          { user: 'root' },
        );
        if (add.exitCode !== 0) throw new Error(`Cannot register guest hostname: ${add.stderr}`);
      }
      return { sandboxId: name, resources: allocation };
    } catch (error) {
      await machine.delete().catch(() => {});
      throw error;
    }
  },
  async get(id) {
    return (await summary(id)) ? { sandboxId: id } : null;
  },
  async list(): Promise<CloudSandboxSummary[]> {
    return (await Machine.list(connection))
      .filter((m) => m.name.startsWith(owned) && m.labels?.agentbox === 'smol')
      .map((m) => ({ sandboxId: m.name, name: m.name, state: stateOf(m.state) }));
  },
  async state(h) {
    const machine = await summary(h.sandboxId);
    return machine ? stateOf(machine.state) : 'missing';
  },
  async start(h) {
    const state = await this.state(h);
    if (state === 'missing') throw new Error(`Smol machine ${h.sandboxId} is missing`);
    if (state === 'paused') {
      // A paused local machine can be reconnected without booting its disk on
      // SDKs with paused-connect support; resume restores its saved RAM.
      try {
        await (await connect(h)).resume({ waitUntilReady: false });
      } catch (error) {
        // SDKs before paused-connect support cannot attach to saved RAM. The
        // bundled CLI can resume that same durable machine without replacing it.
        if (!/paused|saved execution/i.test(String(error))) throw error;
        await runSmolCli(['machine', 'resume', '--name', h.sandboxId]);
      }
    } else if (state === 'stopped') {
      await (await connect(h)).start({ waitUntilReady: false });
    }
  },
  async resume(h) {
    await this.start(h);
  },
  async stop(h) {
    const state = await this.state(h);
    if (state === 'running') await (await connect(h)).stop();
    else if (state === 'paused') {
      // Smol only stops running machines: resume the saved execution first,
      // then stop it with its filesystem intact.
      await this.resume(h);
      await (await connect(h)).stop();
    }
  },
  async pause(h) {
    if ((await this.state(h)) === 'running') await (await connect(h)).pause();
  },
  async destroy(h) {
    if ((await this.state(h)) !== 'missing')
      await runSmolCli(['machine', 'delete', '--force', '--name', h.sandboxId]);
  },
  async exec(h, cmd, opts?: CloudExecOptions) {
    const result = await (
      await connect(h)
    ).exec(['bash', '-lc', cmd], {
      user: opts?.user ?? 'vscode',
      workdir: opts?.cwd,
      env: opts?.env,
      timeout: opts?.attemptTimeoutMs ? Math.ceil(opts.attemptTimeoutMs / 1000) : undefined,
    });
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  },
  async uploadFile(h, localPath, remotePath) {
    const machine = await connect(h);
    const userFile =
      remotePath === '/workspace' ||
      remotePath.startsWith('/workspace/') ||
      remotePath === '/home/vscode' ||
      remotePath.startsWith('/home/vscode/') ||
      remotePath === '/tmp' ||
      remotePath.startsWith('/tmp/') ||
      remotePath === '/var/tmp' ||
      remotePath.startsWith('/var/tmp/');
    const parent = await machine.exec(['mkdir', '-p', dirname(remotePath)], {
      user: userFile ? 'vscode' : 'root',
    });
    if (parent.exitCode !== 0)
      throw new Error(`Cannot create ${dirname(remotePath)}: ${parent.stderr}`);
    await machine.writeFile(remotePath, await readFile(localPath));
    if (userFile) {
      const owner = await machine.exec(['chown', 'vscode:vscode', remotePath], { user: 'root' });
      if (owner.exitCode !== 0)
        throw new Error(`Cannot set ownership of ${remotePath}: ${owner.stderr}`);
    }
  },
  async downloadFile(h, remotePath, localPath) {
    await mkdir(dirname(localPath), { recursive: true });
    await writeFile(localPath, await (await connect(h)).readFile(remotePath));
  },
  async listFiles(h, remoteDir): Promise<CloudFileEntry[]> {
    const script =
      'import json,os,sys; print(json.dumps([{"name":e.name,"isDir":e.is_dir()} for e in os.scandir(sys.argv[1])]))';
    const result = await (await connect(h)).exec(['python3', '-c', script, remoteDir]);
    if (result.exitCode !== 0) throw new Error(`Cannot list ${remoteDir}: ${result.stderr}`);
    return JSON.parse(result.stdout) as CloudFileEntry[];
  },
  async previewUrl(h, port) {
    const endpoint = (await connect(h)).endpoint(port);
    return { url: endpoint.httpUrl };
  },
  async signedPreviewUrl(h, port) {
    // Loopback forwards need no browser header or expiring token.
    return this.previewUrl(h, port);
  },
};
