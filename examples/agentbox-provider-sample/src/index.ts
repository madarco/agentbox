/**
 * agentbox-provider-sample — a minimal external provider built ONLY on
 * @madarco/agentbox-provider-sdk, to prove the plugin path end-to-end. The backend is a
 * stub (it does not talk to a real cloud); it demonstrates the contract a real
 * community provider implements.
 */
import {
  createCloudProvider,
  SDK_API_VERSION,
  type CloudBackend,
  type CloudHandle,
  type ProviderModule,
  type CheckResult,
} from '@madarco/agentbox-provider-sdk';

const NAME = 'sample';

const sampleBackend: CloudBackend = {
  name: NAME,
  async provision() {
    throw new Error('sample provider is a stub — it does not provision real boxes');
  },
  async get(): Promise<CloudHandle | null> {
    return null;
  },
  async start() {},
  async stop() {},
  async pause() {},
  async resume() {},
  async destroy() {},
  async state() {
    return 'missing';
  },
  async exec() {
    return { exitCode: 0, stdout: 'sample', stderr: '' };
  },
  async uploadFile() {},
  async downloadFile() {},
  async listFiles() {
    return [];
  },
  async previewUrl(_h, port) {
    return { url: `https://sample.invalid:${String(port)}` };
  },
};

const sampleProvider = createCloudProvider(sampleBackend, {
  defaultResources: { cpu: 1, memory: 2, disk: 8 },
});

async function doctorChecks(): Promise<CheckResult[]> {
  return [
    { label: 'sdk', status: 'ok', detail: `built on provider-sdk v${String(SDK_API_VERSION)}` },
    { label: 'note', status: 'info', detail: 'stub backend — does not provision real boxes' },
  ];
}

export const providerModule: ProviderModule = {
  provider: sampleProvider,
  backend: sampleBackend,
  readCredStatus: () => ({ configured: true, label: 'stub' }),
  doctorChecks,
};

export { SDK_API_VERSION };
