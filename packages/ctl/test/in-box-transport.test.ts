import { describe, expect, it } from 'vitest';
import { selectInBoxTransport } from '../src/commands/in-box-transport.js';

describe('selectInBoxTransport', () => {
  it('cloud + control-plane URL → forwarder to the plane', () => {
    expect(
      selectInBoxTransport({
        AGENTBOX_BOX_KIND: 'cloud',
        AGENTBOX_CONTROL_PLANE_URL: 'https://plane.example',
      }),
    ).toEqual({ kind: 'forwarder', upstream: 'https://plane.example' });
  });

  it('cloud without a control-plane URL → mode:box relay', () => {
    expect(selectInBoxTransport({ AGENTBOX_BOX_KIND: 'cloud' })).toEqual({ kind: 'box' });
    expect(
      selectInBoxTransport({ AGENTBOX_BOX_KIND: 'cloud', AGENTBOX_CONTROL_PLANE_URL: '' }),
    ).toEqual({ kind: 'box' });
  });

  it('docker → forwarder to the host relay (explicit or default)', () => {
    expect(selectInBoxTransport({ AGENTBOX_BOX_KIND: 'docker' })).toEqual({
      kind: 'forwarder',
      upstream: 'http://host.docker.internal:8787',
    });
    expect(
      selectInBoxTransport({
        AGENTBOX_BOX_KIND: 'docker',
        AGENTBOX_HOST_RELAY_URL: 'http://host.docker.internal:9999',
      }),
    ).toEqual({ kind: 'forwarder', upstream: 'http://host.docker.internal:9999' });
  });

  it('a control-plane URL is ignored for a docker box (never a plane target)', () => {
    expect(
      selectInBoxTransport({
        AGENTBOX_BOX_KIND: 'docker',
        AGENTBOX_CONTROL_PLANE_URL: 'https://plane.example',
      }),
    ).toEqual({ kind: 'forwarder', upstream: 'http://host.docker.internal:8787' });
  });
});
