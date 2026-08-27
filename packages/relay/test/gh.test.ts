import { describe, expect, it } from 'vitest';
import {
  ghDestructiveTarget,
  ghVerbArgv,
  injectPrCreateHead,
  prCreateNeedsHead,
  refuseBlockedGhCall,
  refuseCheckoutByDefault,
  refuseGhApiInput,
} from '../src/gh.js';

describe('injectPrCreateHead', () => {
  it('prepends --head <branch> for create when none was passed', () => {
    expect(injectPrCreateHead('create', 'agentbox/box-one', ['--title', 'T'])).toEqual([
      '--head',
      'agentbox/box-one',
      '--title',
      'T',
    ]);
  });

  it('is a no-op for non-create ops', () => {
    expect(injectPrCreateHead('view', 'agentbox/box-one', ['7'])).toEqual(['7']);
    expect(injectPrCreateHead('merge', 'agentbox/box-one', ['42'])).toEqual(['42']);
  });

  it('does not double-inject when --head is already present', () => {
    expect(injectPrCreateHead('create', 'agentbox/box-one', ['--head', 'feat/x'])).toEqual([
      '--head',
      'feat/x',
    ]);
    expect(injectPrCreateHead('create', 'agentbox/box-one', ['--head=feat/x'])).toEqual([
      '--head=feat/x',
    ]);
  });

  it('does not double-inject when the -H shorthand is already present', () => {
    expect(injectPrCreateHead('create', 'agentbox/box-one', ['-H', 'feat/x'])).toEqual([
      '-H',
      'feat/x',
    ]);
    expect(injectPrCreateHead('create', 'agentbox/box-one', ['-Hfeat/x'])).toEqual(['-Hfeat/x']);
    expect(injectPrCreateHead('create', 'agentbox/box-one', ['-H=feat/x'])).toEqual(['-H=feat/x']);
  });

  it('leaves args unchanged when no usable branch resolved', () => {
    expect(injectPrCreateHead('create', undefined, ['--title', 'T'])).toEqual(['--title', 'T']);
    expect(injectPrCreateHead('create', '', ['--title', 'T'])).toEqual(['--title', 'T']);
    expect(injectPrCreateHead('create', 'HEAD', ['--title', 'T'])).toEqual(['--title', 'T']);
  });
});

describe('prCreateNeedsHead', () => {
  it('is true for a create that still has no --head', () => {
    expect(prCreateNeedsHead('create', ['--title', 'T'])).toBe(true);
    // After injectPrCreateHead failed to resolve a branch:
    expect(prCreateNeedsHead('create', injectPrCreateHead('create', '', ['--title', 'T']))).toBe(
      true,
    );
  });

  it('is false once --head is present (injected or caller-supplied)', () => {
    expect(prCreateNeedsHead('create', ['--head', 'agentbox/box-one', '--title', 'T'])).toBe(false);
    expect(prCreateNeedsHead('create', ['--head=feat/x'])).toBe(false);
    expect(
      prCreateNeedsHead(
        'create',
        injectPrCreateHead('create', 'agentbox/box-one', ['--title', 'T']),
      ),
    ).toBe(false);
  });

  it('is false when the -H shorthand supplied a head (no false refusal)', () => {
    expect(prCreateNeedsHead('create', ['-H', 'feat/x', '--title', 'T'])).toBe(false);
    expect(prCreateNeedsHead('create', ['-Hfeat/x'])).toBe(false);
    expect(prCreateNeedsHead('create', ['-H=feat/x'])).toBe(false);
  });

  it('is false for non-create ops', () => {
    expect(prCreateNeedsHead('view', ['7'])).toBe(false);
    expect(prCreateNeedsHead('merge', ['42'])).toBe(false);
  });
});

describe('GH_BLOCKED — refused outright', () => {
  // The host owns its GitHub credential. A box must not be able to read it,
  // rotate it, or move the host onto a different account.
  it.each([
    ['auth', 'token'],
    ['auth', 'refresh'],
    ['auth', 'login'],
    ['auth', 'logout'],
    ['auth', 'switch'],
    ['auth', 'setup-git'],
  ])('refuses gh %s %s', (a, b) => {
    const r = refuseBlockedGhCall([a, b]);
    expect(r?.exitCode).toBe(65);
  });

  it('refuses host-side config and alias mutation', () => {
    expect(refuseBlockedGhCall(['config', 'set', 'editor', 'vim'])).not.toBeNull();
    // `gh alias set x '!sh -c ...'` defines a shell escape that later runs on
    // the host under the host's credentials.
    expect(refuseBlockedGhCall(['alias', 'set', 'x', '!sh -c "curl evil"'])).not.toBeNull();
    expect(refuseBlockedGhCall(['extension', 'install', 'someone/ext'])).not.toBeNull();
    expect(refuseBlockedGhCall(['ssh-key', 'add', 'k.pub'])).not.toBeNull();
  });

  it('lets ordinary work through — including what issue #304 asked for', () => {
    for (const argv of [
      ['issue', 'list'],
      ['issue', 'view', '304'],
      ['issue', 'create', '--title', 'x'],
      ['issue', 'comment', '304', '--body', 'hi'],
      ['pr', 'list'],
      ['pr', 'merge', '--squash'],
      ['search', 'issues', 'foo'],
      ['release', 'list'],
      ['api', 'repos/o/r/issues'],
      ['auth', 'status'],
      ['config', 'get', 'editor'],
      ['alias', 'list'],
    ]) {
      expect(refuseBlockedGhCall(argv)).toBeNull();
    }
  });
});

describe('GH_DESTRUCTIVE — always confirmed', () => {
  it.each([
    [['repo', 'delete', 'o/r'], 'repository'],
    [['repo', 'archive', 'o/r'], 'repository'],
    [['release', 'delete', 'v1'], 'release'],
    [['secret', 'delete', 'TOKEN'], 'repository secret'],
    [['secret', 'set', 'TOKEN'], 'repository secret'],
    [['gist', 'delete', 'abc'], 'gist'],
    [['label', 'delete', 'bug'], 'label'],
    [['cache', 'delete', '1'], 'Actions cache'],
  ])('flags %s', (argv, what) => {
    expect(ghDestructiveTarget(argv)).toBe(what);
  });

  // Every pflag spelling gh accepts for the method — a missed one is a silent
  // hole, not a typo.
  it.each([
    ['-X', 'DELETE'],
    ['-XDELETE'],
    ['-X=DELETE'],
    ['--method', 'DELETE'],
    ['--method=DELETE'],
  ])('flags a raw API write via %s', (...flag) => {
    expect(ghDestructiveTarget(['api', 'repos/o/r', ...flag])).toBe('raw API write');
  });

  // The user's call: merging is ordinary agent work and is revertable, so it
  // must NOT sit in the always-confirm tier.
  it('does not flag pr merge', () => {
    expect(ghDestructiveTarget(['pr', 'merge', '--squash'])).toBeNull();
  });

  it('does not flag ordinary reads and creates', () => {
    for (const argv of [
      ['issue', 'list'],
      ['issue', 'create', '--title', 'x'],
      ['pr', 'create'],
      ['release', 'create', 'v1'],
      ['api', 'repos/o/r/issues'],
      ['api', 'repos/o/r/issues', '-f', 'title=x'],
      ['api', 'repos/o/r', '--method', 'GET'],
    ]) {
      expect(ghDestructiveTarget(argv)).toBeNull();
    }
  });
});

describe('gh api --input', () => {
  // A transport limit, not a policy one: the host gh runs with stdin ignored,
  // so the request would silently send an empty body.
  it('refuses both spellings', () => {
    expect(refuseGhApiInput(['api', 'x', '--input', 'f.json'])?.exitCode).toBe(65);
    expect(refuseGhApiInput(['api', 'x', '--input=f.json'])?.exitCode).toBe(65);
  });

  it('allows field flags', () => {
    expect(refuseGhApiInput(['api', 'x', '-f', 'body=hi'])).toBeNull();
  });
});

describe('refuseCheckoutByDefault', () => {
  // `pr checkout` is the one gh subcommand that moves the HOST's working
  // tree; the box's bind-mounted .git/HEAD follows it.
  it('refuses checkout unless opted in', () => {
    const prev = process.env['AGENTBOX_GH_PR_CHECKOUT'];
    delete process.env['AGENTBOX_GH_PR_CHECKOUT'];
    expect(refuseCheckoutByDefault('checkout')?.exitCode).toBe(13);
    process.env['AGENTBOX_GH_PR_CHECKOUT'] = 'allow';
    expect(refuseCheckoutByDefault('checkout')).toBeNull();
    if (prev === undefined) delete process.env['AGENTBOX_GH_PR_CHECKOUT'];
    else process.env['AGENTBOX_GH_PR_CHECKOUT'] = prev;
  });

  it('leaves other pr ops alone', () => {
    expect(refuseCheckoutByDefault('view')).toBeNull();
  });
});

describe('ghVerbArgv — leading global flags', () => {
  // Reported by review: every policy pattern is anchored at the start of argv,
  // so a global flag in front of the verb hid it entirely. `gh -R o/r auth
  // token` matched nothing and ran under the default allow-once flag.
  it('skips value-taking global flags to find the verb', () => {
    expect(ghVerbArgv(['-R', 'o/r', 'auth', 'token'])).toEqual(['auth', 'token']);
    expect(ghVerbArgv(['--repo', 'o/r', 'issue', 'list'])).toEqual(['issue', 'list']);
    expect(ghVerbArgv(['--hostname', 'ghe.corp', 'repo', 'delete'])).toEqual(['repo', 'delete']);
  });

  it('skips glued and equals forms', () => {
    expect(ghVerbArgv(['--repo=o/r', 'auth', 'token'])).toEqual(['auth', 'token']);
    expect(ghVerbArgv(['-Ro/r', 'auth', 'token'])).toEqual(['auth', 'token']);
  });

  it('leaves a plain argv alone', () => {
    expect(ghVerbArgv(['issue', 'list'])).toEqual(['issue', 'list']);
    expect(ghVerbArgv([])).toEqual([]);
  });

  it('closes the bypass for every tier', () => {
    expect(refuseBlockedGhCall(['-R', 'o/r', 'auth', 'token'])).not.toBeNull();
    expect(refuseBlockedGhCall(['--repo=o/r', 'config', 'set', 'x', 'y'])).not.toBeNull();
    expect(ghDestructiveTarget(['-R', 'o/r', 'repo', 'delete'])).toBe('repository');
    expect(ghDestructiveTarget(['--repo', 'o/r', 'secret', 'delete', 'K'])).toBe(
      'repository secret',
    );
  });
});

describe('GraphQL mutations', () => {
  // A mutation is a POST, so no method flag betrays it — but it has the same
  // reach as `-X DELETE`.
  it('flags a graphql mutation as destructive', () => {
    expect(
      ghDestructiveTarget(['api', 'graphql', '-f', 'query=mutation { deleteRepository }']),
    ).toBe('raw GraphQL mutation');
  });

  it('leaves graphql queries alone', () => {
    expect(ghDestructiveTarget(['api', 'graphql', '-f', 'query={ viewer { login } }'])).toBeNull();
  });
});
