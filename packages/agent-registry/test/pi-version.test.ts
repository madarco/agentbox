/**
 * `pi.version`: the recipe is the only thing between a config value and an npm
 * argv, so it runs through a real /bin/sh with a fake `npm` on PATH.
 */
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPiNpmInstall, piSpec } from '../src/specs/pi.js';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'pi-version-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('pi.version pins the installed release', () => {
  /** Run the recipe under /bin/sh with a fake `npm` that prints its argv. */
  async function runRecipe(version: string | undefined): Promise<{ code: number; out: string }> {
    const bin = join(home, 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, 'npm'), '#!/bin/sh\necho "npm $*"\n');
    await chmod(join(bin, 'npm'), 0o755);
    const env: NodeJS.ProcessEnv = { PATH: `${bin}:/usr/bin:/bin` };
    if (version !== undefined) env['AGENTBOX_AGENT_SETTING_VERSION'] = version;
    const r = spawnSync('sh', ['-c', buildPiNpmInstall('@earendil-works/pi-coding-agent')], {
      env,
      encoding: 'utf8',
    });
    return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
  }

  it('declares a bake-affecting `version` setting defaulting to latest', () => {
    const setting = piSpec.settings?.find((s) => s.key === 'version');
    expect(setting).toMatchObject({ type: 'string', default: 'latest', affectsBake: true });
    expect(piSpec.install.recipe).toEqual({
      kind: 'exec',
      script: buildPiNpmInstall('@earendil-works/pi-coding-agent'),
    });
  });

  it('installs latest when the setting is unset or empty, without failing', async () => {
    for (const v of [undefined, '']) {
      const r = await runRecipe(v);
      expect(r.code, String(v)).toBe(0);
      expect(r.out).toContain('npm install -g @earendil-works/pi-coding-agent@latest');
    }
  });

  it('installs an exact version or a dist-tag', async () => {
    for (const v of ['0.70.2', '1.0.0-beta.3', '1.0.0+build.7', 'latest', 'next', 'beta-2']) {
      const r = await runRecipe(v);
      expect(r.code, v).toBe(0);
      expect(r.out, v).toContain(`npm install -g @earendil-works/pi-coding-agent@${v}`);
    }
  });

  it('refuses ranges and anything that is not a version or dist-tag, before npm runs', async () => {
    const bad = [
      '^1.2',
      '~1.2.3',
      '>=1.0.0',
      '1.2',
      '1.x',
      'x',
      '*',
      '01.2.3',
      '1.0; touch pwned',
      '--registry=http://evil',
      '$(id)',
      '1 2',
      '1.0.0\nlatest',
      'latest\n--registry=http://evil',
    ];
    for (const v of bad) {
      const r = await runRecipe(v);
      expect(r.code, v).toBe(64);
      expect(r.out, v).not.toContain('npm install');
    }
  });
});
