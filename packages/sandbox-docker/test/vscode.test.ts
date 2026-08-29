import { describe, expect, it } from 'vitest';
import { attachedContainerUri } from '../src/vscode.js';

/** Decode the `attached-container+<hex>` authority back to its JSON payload. */
function decodePayload(uri: string): unknown {
  const m = /^vscode-remote:\/\/attached-container\+([0-9a-f]+)(\/.*)$/.exec(uri);
  if (!m) throw new Error(`unexpected URI shape: ${uri}`);
  return JSON.parse(Buffer.from(m[1]!, 'hex').toString('utf8'));
}

describe('attachedContainerUri', () => {
  it('encodes the JSON payload the modern Dev Containers extension expects', () => {
    const uri = attachedContainerUri('agentbox-smoke', { dockerContext: 'desktop-linux' });
    expect(uri.startsWith('vscode-remote://attached-container+')).toBe(true);
    expect(uri.endsWith('/workspace')).toBe(true);
    // matches the shape VS Code itself stores for an attached container
    expect(decodePayload(uri)).toEqual({
      containerName: '/agentbox-smoke',
      settings: { context: 'desktop-linux' },
    });
  });

  it('embeds whatever docker context it is given (engine-agnostic)', () => {
    expect(
      decodePayload(attachedContainerUri('agentbox-smoke', { dockerContext: 'orbstack' })),
    ).toEqual({ containerName: '/agentbox-smoke', settings: { context: 'orbstack' } });
  });

  it('omits settings when no docker context is available', () => {
    expect(decodePayload(attachedContainerUri('agentbox-smoke'))).toEqual({
      containerName: '/agentbox-smoke',
    });
  });

  it('keeps exactly one leading slash on the container name', () => {
    expect(decodePayload(attachedContainerUri('/agentbox-smoke', { dockerContext: 'x' }))).toEqual({
      containerName: '/agentbox-smoke',
      settings: { context: 'x' },
    });
  });

  it('honors a custom workspace path', () => {
    const uri = attachedContainerUri('agentbox-smoke', {
      dockerContext: 'desktop-linux',
      workspacePath: '/workspace/sub',
    });
    expect(uri.endsWith('/workspace/sub')).toBe(true);
  });
});
