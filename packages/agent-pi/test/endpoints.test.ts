import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProviderWarning } from '@agentbox/core';
import { stageLoopbackOverlay } from '@agentbox/sandbox-docker';
import { piEndpointFiles } from '../src/endpoints.js';
import { stagePiStaticForUpload } from '../src/host-stage.js';

const MODELS = {
  providers: {
    ollama: {
      baseUrl: 'http://127.0.0.1:11434/v1',
      api: 'openai-completions',
      models: [{ id: 'llama', baseUrl: 'http://localhost:8080/v1' }, { id: 'qwen' }],
    },
    remote: { baseUrl: 'https://api.example.com/v1' },
  },
};

async function fixtureHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'pi-endpoints-'));
  await mkdir(join(home, '.pi', 'agent'), { recursive: true });
  await writeFile(join(home, '.pi', 'agent', 'models.json'), JSON.stringify(MODELS, null, 2));
  return home;
}

describe('pi loopback endpoints (#403)', () => {
  it('docker: rewrites provider and per-model baseUrl in the overlay models.json', async () => {
    const home = await fixtureHome();
    const o = await stageLoopbackOverlay(piEndpointFiles(home));
    try {
      expect(o.endpoints.map((e) => e.port)).toEqual([11434, 8080]);
      const out = JSON.parse(await readFile(join(o.dir as string, 'models.json'), 'utf8'));
      expect(out.providers.ollama.baseUrl).toBe('http://host.docker.internal:11434/v1');
      expect(out.providers.ollama.models[0].baseUrl).toBe('http://host.docker.internal:8080/v1');
      expect(out.providers.remote.baseUrl).toBe('https://api.example.com/v1');
    } finally {
      await o.cleanup();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('cloud: warns per endpoint without rewriting', async () => {
    const home = await fixtureHome();
    const staged = await stagePiStaticForUpload({ hostHome: home });
    try {
      expect(staged.warnings.map((w) => parseProviderWarning(w) ?? '')).toHaveLength(2);
    } finally {
      await staged.cleanup();
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);
});
