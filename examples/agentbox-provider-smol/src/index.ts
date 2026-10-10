import type {
  AttachKind,
  AttachSpec,
  BoxRecord,
  BuildAttachOptions,
  Provider,
  ProviderDescriptor,
  ProviderModule,
} from '@madarco/agentbox-provider-sdk';
import {
  createCloudProvider,
  hostTermForCloud,
  readCliStamp,
  renderInnerCommand,
} from '@madarco/agentbox-provider-sdk';
import { Machine } from 'smolmachines';
import { smolBackend } from './backend.js';
import { smolCli } from './cli.js';

const IMAGE_REGISTRY = 'ghcr.io/madarco/agentbox/box';
const provider = createCloudProvider(smolBackend, {
  provisionImage: async (req) => {
    if (req.image && req.image !== 'agentbox/box:dev') return req.image;
    return process.env.AGENTBOX_SMOL_IMAGE ?? `${IMAGE_REGISTRY}:${readCliStamp().cliVersion}`;
  },
  defaultResources: { cpu: 2, memory: 4, disk: 20 },
  launchDockerd: true,
});

export async function buildSmolAttach(
  box: BoxRecord,
  kind: AttachKind,
  opts?: BuildAttachOptions,
): Promise<AttachSpec> {
  const id = box.cloud?.sandboxId;
  if (!id) throw new Error(`Smol box ${box.name} has no sandboxId`);
  const cli = smolCli();
  const interactive = !opts?.detached && kind !== 'logs';
  const inner = `export LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=${hostTermForCloud()}; ${renderInnerCommand(kind, opts)}`;
  return {
    argv: [
      cli.bin,
      'machine',
      'exec',
      '--name',
      id,
      ...(interactive ? ['-i', '-t'] : kind === 'logs' ? ['--stream'] : []),
      '--user',
      'vscode',
      '--',
      'bash',
      '-lc',
      inner,
    ],
    env: cli.env,
  };
}

export const smolProvider: Provider = { ...provider, buildAttach: buildSmolAttach };
export const descriptor: ProviderDescriptor = {
  name: 'smol',
  kind: 'cloud',
  label: 'Smol Machines (local)',
  loginHint: 'Runs local microVMs with Smol; no cloud account required.',
  credentials: { envKeys: [], fields: [] },
  bake: { required: false, approxMinutes: '0', createProgressSteps: 25, bakeProgressSteps: 0 },
  capabilities: {
    checkpoints: false,
    checkpointReboots: false,
    ssh: false,
    persistentSsh: false,
    directBoxSsh: false,
    inbound: false,
    directGit: true,
    resync: true,
    prune: true,
    vnc: true,
    dind: true,
    pauseSemantics: 'freeze',
    hubRoutable: true,
  },
  sizes: [
    { key: '2-4-20', label: '2 vCPU / 4 GB RAM / 20 GB disk' },
    { key: '4-8-40', label: '4 vCPU / 8 GB RAM / 40 GB disk' },
  ],
  sizeHint: 'cpu-memory-disk in GiB, e.g. 4-8-40',
  blurb: 'local microVMs that run AgentBox without a cloud account',
  sizeDesc: 'vCPUs, memory and disk for a new Smol microVM.',
  imageDesc: 'OCI image for the box; defaults to the AgentBox image matching the installed CLI.',
};

export const providerModule: ProviderModule = {
  provider: smolProvider,
  backend: smolBackend,
  descriptor,
  doctorChecks: async () => {
    const availability = Machine.localAvailability();
    return [
      {
        label: 'local hypervisor',
        status: availability.available ? ('ok' as const) : ('fail' as const),
        detail: availability.available ? 'Smol microVMs available' : availability.reason,
      },
    ];
  },
};
