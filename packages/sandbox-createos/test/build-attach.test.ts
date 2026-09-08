import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/createos-cli.js', () => ({
  detectCreateosCli: () => ({ installed: true, bin: 'createos' }),
}));
vi.mock('../src/credentials.js', () => ({
  readCreateOsCredStatus: () => ({ token: 'test-token' }),
}));

const { buildCreateosAttach, buildCreateosAttachArgv } = await import('../src/build-attach.js');

describe('buildCreateosAttachArgv', () => {
  it('uses CreateOS managed PTY for interactive agent attaches', () => {
    expect(
      buildCreateosAttachArgv({
        bin: 'createos',
        sandboxId: 'sb_123',
        kind: 'agent',
        inner: 'exec tmux attach -t claude',
      }),
    ).toEqual([
      'createos',
      'sandbox',
      'process',
      'run',
      '--cwd',
      '/workspace',
      '--pty',
      'sb_123',
      '--',
      'sudo',
      '-u',
      'vscode',
      '-H',
      'bash',
      '-lc',
      'exec tmux attach -t claude',
    ]);
  });

  it('does not allocate a PTY for detached pre-start commands', () => {
    expect(
      buildCreateosAttachArgv({
        bin: 'createos',
        sandboxId: 'sb_123',
        kind: 'agent',
        inner: 'tmux new-session -d',
        detached: true,
      }),
    ).not.toContain('--pty');
  });
});


// Finding 5 — `create` honoured a custom sandbox endpoint but `attach` did
// not, so against a private control plane the CLI looked for the resulting
// sandbox id on its own default endpoint.
describe('buildCreateosAttach: endpoint forwarding', () => {
  afterEach(() => {
    delete process.env.CREATEOS_SANDBOX_URL;
  });

  it('hands the CLI the endpoint the provider provisioned against', async () => {
    process.env.CREATEOS_SANDBOX_URL = 'https://staging.sb.example.com';
    const spec = await buildCreateosAttach(
      { name: 'review', cloud: { sandboxId: 'sb_123' } } as never,
      'shell',
    );
    expect(spec.env).toMatchObject({
      CREATEOS_API_KEY: 'test-token',
      CREATEOS_SANDBOX_URL: 'https://staging.sb.example.com',
    });
  });

  it('falls back to the public sandbox API, never the project API', async () => {
    const spec = await buildCreateosAttach(
      { name: 'review', cloud: { sandboxId: 'sb_123' } } as never,
      'shell',
    );
    expect(spec.env?.CREATEOS_SANDBOX_URL).toBe('https://api.sb.createos.sh');
  });
});
