import { describe, expect, it } from 'vitest';
import type { BoxRecord } from '@agentbox/core';
import { boxAgentConfigVolumes } from '../src/lifecycle.js';

describe('destroy never removes a named account volume (#437-1)', () => {
  it('keeps -acct- volumes and shared ones, removes per-box isolated ones', () => {
    const box = {
      agentConfigVolumes: {
        claude: 'agentbox-claude-config-acct-work',
        codex: 'agentbox-codex-config-b1234abcd',
        opencode: 'agentbox-opencode-config',
      },
    } as unknown as BoxRecord;
    const removed = boxAgentConfigVolumes(box).map((e) => e.volume);
    expect(removed).toEqual(['agentbox-codex-config-b1234abcd']);
  });
});
