import { describe, expect, it } from 'vitest';
import { formatBoxEnvBody } from '../src/box-env.js';

describe('formatBoxEnvBody', () => {
  it('single-quotes plain values and emits one var per line with trailing newline', () => {
    const body = formatBoxEnvBody({
      AGENTBOX: '1',
      AGENTBOX_BOX_NAME: 'smoke',
    });
    expect(body).toBe("AGENTBOX='1'\nAGENTBOX_BOX_NAME='smoke'\n");
  });

  it('escapes embedded single quotes with the POSIX close-escape-reopen pattern', () => {
    const body = formatBoxEnvBody({
      AGENTBOX_HOST_WORKSPACE: "/Users/it's/a path",
    });
    expect(body).toBe("AGENTBOX_HOST_WORKSPACE='/Users/it'\\''s/a path'\n");
  });

  it('does not expand $ or backticks (would break under double-quote form)', () => {
    const body = formatBoxEnvBody({
      AGENTBOX_FOO: '$HOME `whoami`',
    });
    expect(body).toBe("AGENTBOX_FOO='$HOME `whoami`'\n");
  });
});
