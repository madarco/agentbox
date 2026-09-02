import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AgentServiceUrlField, BoxRecord } from '@agentbox/core';

/**
 * `<agent> url` must print what the Control UI actually needs.
 *
 * A gateway's URL alone does not open it — it asks for a token on first load,
 * and the tool's own `config get` redacts that key by design
 * (`__OPENCLAW_REDACTED__`, measured in the Phase 0 PoC). So the value is read
 * out of the raw config file in the box, declared as data on the service block.
 *
 * The behaviour that matters is the DEGRADATION: a missing file, a missing key
 * or a failed exec must still leave `url` printing the URL. A create that
 * succeeded and a service that is up must not turn into an error because a
 * secondary value could not be read.
 */
const exec = vi.fn();

vi.mock('../src/provider/registry.js', () => ({
  providerForBox: () => Promise.resolve({ exec }),
  providerForCreate: vi.fn(),
}));
vi.mock('../src/control-plane/with-hub.js', () => ({
  withOwningHub: vi.fn(),
  reportBoxNotOnAnyHub: vi.fn(),
}));

const { readServiceUrlFields } = await import('../src/agents/command/service-action.js');

const box = { id: 'b1', name: 'claw' } as BoxRecord;
const TOKEN_FIELD: AgentServiceUrlField = {
  label: 'token',
  file: '/home/vscode/.openclaw/openclaw.json',
  jsonPath: 'gateway.auth.token',
};

function ok(stdout: string) {
  return { exitCode: 0, stdout, stderr: '' };
}

describe('readServiceUrlFields', () => {
  beforeEach(() => exec.mockReset());

  it('reads a nested value out of the daemon’s own config file', async () => {
    exec.mockResolvedValue(ok(JSON.stringify({ gateway: { auth: { token: 'sk-abc' } } })));
    await expect(readServiceUrlFields(box, [TOKEN_FIELD])).resolves.toEqual([
      { label: 'token', value: 'sk-abc' },
    ]);
    expect(exec).toHaveBeenCalledWith(box, ['cat', TOKEN_FIELD.file], { user: 'vscode' });
  });

  it('reads each file once, however many fields come out of it', async () => {
    exec.mockResolvedValue(ok(JSON.stringify({ gateway: { auth: { token: 't' }, port: 18789 } })));
    const two = await readServiceUrlFields(box, [
      TOKEN_FIELD,
      { label: 'port', file: TOKEN_FIELD.file, jsonPath: 'gateway.port' },
    ]);
    // The port is a number, not a string — only string leaves are printable.
    expect(two).toEqual([{ label: 'token', value: 't' }]);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  // Each degradation is its own case: they are separate real states, and a
  // single test that walked all five would report only the first to break.
  it('degrades when the box has no such file yet', async () => {
    // The service can be up before it has written its config.
    exec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'No such file' });
    await expect(readServiceUrlFields(box, [TOKEN_FIELD])).resolves.toEqual([]);
  });

  it('degrades when the file is not JSON', async () => {
    exec.mockResolvedValue(ok('not json at all'));
    await expect(readServiceUrlFields(box, [TOKEN_FIELD])).resolves.toEqual([]);
  });

  it('degrades when the key is absent or empty', async () => {
    // The tool can rename a key across a version; an empty token is not one.
    exec.mockResolvedValue(ok(JSON.stringify({ gateway: {} })));
    await expect(readServiceUrlFields(box, [TOKEN_FIELD])).resolves.toEqual([]);
    exec.mockResolvedValue(ok(JSON.stringify({ gateway: { auth: { token: '' } } })));
    await expect(readServiceUrlFields(box, [TOKEN_FIELD])).resolves.toEqual([]);
  });

  it('degrades when the exec itself fails', async () => {
    exec.mockImplementationOnce(() => {
      throw new Error('box is down');
    });
    await expect(readServiceUrlFields(box, [TOKEN_FIELD])).resolves.toEqual([]);
  });

  it('never touches the box when the agent declares no fields', async () => {
    await expect(readServiceUrlFields(box, [])).resolves.toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });
});
