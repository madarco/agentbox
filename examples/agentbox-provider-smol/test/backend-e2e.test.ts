import { test, expect } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { smolBackend } from '../src/backend.js';

test('real AgentBox image boots and preserves the provider contract', async () => {
  const host = await mkdtemp(join(tmpdir(), 'agentbox-smol-e2e-'));
  let id: string | undefined;
  try {
    const h = await smolBackend.provision({
      name: `e2e-${process.pid}`,
      image: 'ghcr.io/madarco/agentbox/box:0.33.0',
      resources: { cpu: 2, memory: 4, disk: 20 },
      networkPolicy: 'allow-all',
      exposePorts: [8080],
    });
    id = h.sandboxId;
    expect((await smolBackend.get(id))?.sandboxId).toBe(id);
    expect(await smolBackend.state(h)).toBe('running');
    const who = await smolBackend.exec(h, 'id -un; command -v agentbox-ctl; test -w /workspace');
    expect(who.exitCode).toBe(0);
    expect(who.stdout).toContain('vscode');
    const source = join(host, 'input');
    const target = join(host, 'output');
    await writeFile(source, Buffer.from([0, 1, 255, 4]));
    await smolBackend.uploadFile(h, source, '/workspace/check.bin');
    expect((await smolBackend.listFiles(h, '/workspace')).some((f) => f.name === 'check.bin')).toBe(
      true,
    );
    await smolBackend.downloadFile(h, '/workspace/check.bin', target);
    expect(await readFile(target)).toEqual(await readFile(source));
    const server = await smolBackend.exec(
      h,
      'nohup python3 -m http.server 8080 --directory /workspace >/tmp/http.log 2>&1 </dev/null &',
    );
    expect(server.exitCode).toBe(0);
    const preview = await smolBackend.previewUrl(h, 8080);
    let response: Response | undefined;
    for (let i = 0; i < 50; i++) {
      try {
        response = await fetch(`${preview.url}/check.bin`);
        if (response.ok) break;
      } catch {}
      await Bun.sleep(100);
    }
    expect(response?.status).toBe(200);
    expect(Buffer.from(await response!.arrayBuffer())).toEqual(await readFile(source));
    await smolBackend.stop(h);
    expect(await smolBackend.state(h)).toBe('stopped');
    await smolBackend.start(h);
    expect((await smolBackend.exec(h, 'cat /workspace/check.bin | wc -c')).stdout.trim()).toBe('4');
    await smolBackend.pause(h);
    expect(await smolBackend.state(h)).toBe('paused');
    await smolBackend.resume(h);
    expect((await smolBackend.exec(h, 'cat /workspace/check.bin | wc -c')).stdout.trim()).toBe('4');
    await smolBackend.pause(h);
    await smolBackend.stop(h);
    expect(await smolBackend.state(h)).toBe('stopped');
    await smolBackend.start(h);
    expect((await smolBackend.exec(h, 'cat /workspace/check.bin | wc -c')).stdout.trim()).toBe('4');
  } finally {
    if (id) await smolBackend.destroy({ sandboxId: id });
    await rm(host, { recursive: true, force: true });
  }
}, 180_000);
