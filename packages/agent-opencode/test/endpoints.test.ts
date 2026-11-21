import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProviderWarning } from '@agentbox/core';
import { stageLoopbackOverlay } from '@agentbox/sandbox-docker';
import { opencodeEndpointFiles } from '../src/endpoints.js';
import { stageOpencodeStaticForUpload } from '../src/host-stage.js';

const JSONC = `{
  // LiteLLM on the host
  "provider": {
    "litellm": { "npm": "@ai-sdk/openai-compatible", "options": { "baseURL": "http://localhost:4000/v1" } },
    "remote": { "options": { "baseURL": "https://api.example.com/v1" } }
  }
}
`;

async function fixtureHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'oc-endpoints-'));
  await mkdir(join(home, '.config', 'opencode'), { recursive: true });
  await writeFile(join(home, '.config', 'opencode', 'opencode.jsonc'), JSONC);
  return home;
}

describe('opencode loopback endpoints (#403)', () => {
  it('docker: overlays a rewritten opencode.jsonc under config/, comments intact', async () => {
    const home = await fixtureHome();
    const o = await stageLoopbackOverlay(opencodeEndpointFiles(home));
    try {
      expect(o.endpoints.map((e) => e.where)).toEqual([
        '~/.config/opencode/opencode.jsonc provider.litellm.options.baseURL',
      ]);
      const out = await readFile(join(o.dir as string, 'config', 'opencode.jsonc'), 'utf8');
      expect(out).toBe(JSONC.replace('localhost', 'host.docker.internal'));
    } finally {
      await o.cleanup();
      await rm(home, { recursive: true, force: true });
    }
  });

  it('cloud: stages the config unchanged and warns per endpoint', async () => {
    const home = await fixtureHome();
    const staged = await stageOpencodeStaticForUpload({ hostHome: home });
    try {
      const warnings = staged.warnings.map((w) => parseProviderWarning(w));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('http://localhost:4000/v1');
      expect(warnings[0]).toContain('inside a cloud box is the box itself');
    } finally {
      await staged.cleanup();
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);
});
