import { describe, expect, it } from 'vitest';
import { oneShotBashArgv } from '../src/commands/shell.js';

describe('oneShotBashArgv', () => {
  it('treats a single token as a shell snippet (login)', () => {
    expect(oneShotBashArgv(['cd /workspace && npm test'], true)).toEqual([
      'bash',
      '-lc',
      'cd /workspace && npm test',
    ]);
  });

  it('treats a single token as a shell snippet (no login)', () => {
    expect(oneShotBashArgv(['echo $HOME'], false)).toEqual(['bash', '-c', 'echo $HOME']);
  });

  it('passes a multi-token argv through exec "$@" verbatim (no re-parse)', () => {
    // The bug: joining + `bash -c` double-parsed the user quoting. Here each
    // token must survive intact as a positional param.
    const cmd = ['bash', '-lc', "echo 'gitdir: X' > /workspace/.git"];
    expect(oneShotBashArgv(cmd, true)).toEqual(['bash', '-lc', 'exec "$@"', 'bash', ...cmd]);
  });

  it('keeps a token with embedded spaces/format chars as one arg', () => {
    const cmd = ['curl', '-w', 'code=%{http_code} time=%{time_total}', 'http://x/'];
    const argv = oneShotBashArgv(cmd, true);
    // The format string is still a single element after the exec wrapper.
    expect(argv.slice(0, 4)).toEqual(['bash', '-lc', 'exec "$@"', 'bash']);
    expect(argv).toContain('code=%{http_code} time=%{time_total}');
    expect(argv.filter((a) => a.includes('%{http_code}'))).toHaveLength(1);
  });

  it('empty argv yields an empty snippet (defensive)', () => {
    expect(oneShotBashArgv([], true)).toEqual(['bash', '-lc', '']);
  });
});
