import { describe, expect, it } from 'vitest';
import { ALL_CONNECTORS, getConnector } from '../src/registry.js';
import { notionConnector } from '../src/connectors/notion.js';
import { linearConnector } from '../src/connectors/linear.js';

describe('integration registry', () => {
  it('exposes the Notion connector exactly once', () => {
    expect(ALL_CONNECTORS).toContain(notionConnector);
    expect(ALL_CONNECTORS.filter((c) => c.service === 'notion')).toHaveLength(1);
  });

  it('exposes the Linear connector exactly once', () => {
    expect(ALL_CONNECTORS).toContain(linearConnector);
    expect(ALL_CONNECTORS.filter((c) => c.service === 'linear')).toHaveLength(1);
  });

  it('looks up by service name', () => {
    expect(getConnector('notion')).toBe(notionConnector);
    expect(getConnector('linear')).toBe(linearConnector);
  });

  it('returns null for unknown services (allowlist)', () => {
    expect(getConnector('trello')).toBeNull();
    expect(getConnector('clickup')).toBeNull();
    expect(getConnector('')).toBeNull();
    expect(getConnector('NOTION')).toBeNull(); // case-sensitive — matches wire shape
    expect(getConnector('LINEAR')).toBeNull();
  });
});

describe('notion connector', () => {
  it('targets the official ntn binary with file-auth env', () => {
    expect(notionConnector.hostBin).toBe('ntn');
    // The macOS host's keychain mode is the default; this var only matters
    // for Linux boxes where the carried auth.json is the credential.
    expect(notionConnector.env).toMatchObject({ NOTION_KEYRING: '0' });
  });

  it('classifies whoami/api as read and the page ops as write', () => {
    expect(notionConnector.ops.whoami?.write).toBe(false);
    expect(notionConnector.ops.api?.write).toBe(false);
    expect(notionConnector.ops['page.create']?.write).toBe(true);
    expect(notionConnector.ops['page.update']?.write).toBe(true);
  });

  it('shapes argv so the connector — not the call site — owns the host CLI surface', () => {
    expect(notionConnector.ops.whoami?.buildArgv?.([])).toEqual(['whoami']);
    expect(notionConnector.ops.api?.buildArgv?.(['v1/users/me'])).toEqual([
      'api',
      'v1/users/me',
    ]);
    expect(notionConnector.ops['page.create']?.buildArgv?.(['--parent', 'db_id'])).toEqual([
      'pages',
      'create',
      '--parent',
      'db_id',
    ]);
    expect(notionConnector.ops['page.update']?.buildArgv?.(['page_id', '--archive'])).toEqual([
      'pages',
      'update',
      'page_id',
      '--archive',
    ]);
  });

  it('has no ops beyond the conservative starter allowlist', () => {
    expect(Object.keys(notionConnector.ops).sort()).toEqual(
      ['api', 'page.create', 'page.update', 'whoami'].sort(),
    );
  });
});

describe('notion api refuseCall — keeps write:false honest', () => {
  const refuse = notionConnector.ops.api!.refuseCall!;

  it('allows plain GETs (default and explicit method)', () => {
    expect(refuse(['v1/users/me'])).toBeNull();
    expect(refuse(['-X', 'GET', 'v1/users/me'])).toBeNull();
    expect(refuse(['--method=GET', 'v1/users/me'])).toBeNull();
    expect(refuse(['-XGET', 'v1/users/me'])).toBeNull();
  });

  it('refuses any non-GET method (the write surface)', () => {
    for (const argv of [
      ['-X', 'POST', 'v1/pages'],
      ['-X', 'DELETE', 'v1/blocks/abc'],
      ['-X', 'PATCH', 'v1/pages/abc'],
      ['--method=PUT', 'v1/pages'],
      ['-XDELETE', 'v1/blocks/abc'],
    ]) {
      const r = refuse(argv);
      expect(r).not.toBeNull();
      expect(r!.exitCode).toBe(65);
      expect(r!.stderr).toMatch(/notion api/);
    }
  });

  it('refuses implicit POST via field flags (gh-pflag style)', () => {
    // -f / -F / --field / --raw-field auto-switch to POST per gh's convention.
    expect(refuse(['v1/pages', '-f', 'title=hi'])?.exitCode).toBe(65);
    expect(refuse(['v1/pages', '-fbody=hi'])?.exitCode).toBe(65);
    expect(refuse(['v1/pages', '--field=body=hi'])?.exitCode).toBe(65);
    expect(refuse(['v1/pages', '-F', 'count=5'])?.exitCode).toBe(65);
  });

  it('refuses --input (stdin/file body cannot cross the relay)', () => {
    expect(refuse(['--input', '-', 'v1/pages'])?.exitCode).toBe(65);
    expect(refuse(['--input=/tmp/x', 'v1/pages'])?.exitCode).toBe(65);
    expect(refuse(['--input=/tmp/x'])?.stderr).toMatch(/--input/);
  });

  it("doesn't downgrade a POST when a field's value looks like -X=GET", () => {
    // pflag binds `-X=GET` as `-f`'s value (so the request still POSTs);
    // refuse must consume the field value and not re-read the next token
    // as an explicit method.
    expect(refuse(['v1/pages', '-f', '-X=GET'])?.exitCode).toBe(65);
  });
});

describe('linear connector', () => {
  it('targets the @schpet/linear-cli `linear` binary', () => {
    expect(linearConnector.hostBin).toBe('linear');
  });

  it("declares no env override (linear uses plaintext credentials.toml)", () => {
    // Unlike `ntn` (which needs NOTION_KEYRING=0 to read file-based auth on
    // Linux boxes), `linear` already reads ~/.config/linear/credentials.toml
    // by default. Setting an env var would require an entry in the
    // <SERVICE>_* namespace guard in mergeConnectorEnv; leaving it unset is
    // the safer call.
    expect(linearConnector.env).toBeUndefined();
  });

  it('declares the doctor install/login hints so the doctor row is self-describing', () => {
    expect(linearConnector.detect.versionArgs).toEqual(['--version']);
    expect(linearConnector.detect.authArgs).toEqual(['auth', 'whoami']);
    expect(linearConnector.detect.installHint).toMatch(/@schpet\/linear-cli/);
    expect(linearConnector.detect.loginHint).toMatch(/linear auth login/);
  });

  it('classifies reads vs writes — auth-token-equivalent ops never reach the allowlist', () => {
    const ops = linearConnector.ops;
    expect(ops.whoami?.write).toBe(false);
    expect(ops['issue.list']?.write).toBe(false);
    expect(ops['issue.mine']?.write).toBe(false);
    expect(ops['issue.view']?.write).toBe(false);
    expect(ops['issue.query']?.write).toBe(false);
    expect(ops['team.list']?.write).toBe(false);
    expect(ops.api?.write).toBe(false);
    expect(ops['issue.create']?.write).toBe(true);
    expect(ops['issue.update']?.write).toBe(true);
    expect(ops['issue.comment']?.write).toBe(true);
  });

  it('shapes argv so the connector — not the call site — owns the host CLI surface', () => {
    const ops = linearConnector.ops;
    expect(ops.whoami?.buildArgv?.([])).toEqual(['auth', 'whoami']);
    expect(ops['issue.list']?.buildArgv?.(['--limit', '5'])).toEqual([
      'issue',
      'list',
      '--limit',
      '5',
    ]);
    // `issue mine` is the v2-native "issues assigned to me" read; the older
    // `issue list --me` path was dropped upstream.
    expect(ops['issue.mine']?.buildArgv?.([])).toEqual(['issue', 'mine']);
    expect(ops['issue.view']?.buildArgv?.(['ABC-1'])).toEqual(['issue', 'view', 'ABC-1']);
    expect(ops['issue.query']?.buildArgv?.(['--team', 'ABC'])).toEqual([
      'issue',
      'query',
      '--team',
      'ABC',
    ]);
    expect(ops['team.list']?.buildArgv?.([])).toEqual(['team', 'list']);
    expect(ops.api?.buildArgv?.(['{ teams { id } }'])).toEqual(['api', '{ teams { id } }']);
    expect(ops['issue.create']?.buildArgv?.(['--title', 'hi'])).toEqual([
      'issue',
      'create',
      '--title',
      'hi',
    ]);
    expect(ops['issue.update']?.buildArgv?.(['ABC-1', '--state', 'done'])).toEqual([
      'issue',
      'update',
      'ABC-1',
      '--state',
      'done',
    ]);
    // `issue.comment` maps to `linear issue comment add` — `@schpet/linear-cli`
    // v2 uses `add`, not `create`. The connector expands the dotted op into
    // the three-segment host argv exactly here.
    expect(ops['issue.comment']?.buildArgv?.(['ABC-1', '--body', 'hi'])).toEqual([
      'issue',
      'comment',
      'add',
      'ABC-1',
      '--body',
      'hi',
    ]);
  });

  it('has exactly the conservative starter ops — no destructive deletes, no auth token', () => {
    expect(Object.keys(linearConnector.ops).sort()).toEqual(
      [
        'whoami',
        'issue.list',
        'issue.mine',
        'issue.view',
        'issue.query',
        'team.list',
        'api',
        'issue.create',
        'issue.update',
        'issue.comment',
      ].sort(),
    );
    // Defense in depth: even if a future contributor adds an op called
    // 'auth.token' or 'token', it must never be classified as a read passthrough
    // — there's no good reason to expose any token-printing op to the box.
    expect(linearConnector.ops['auth.token']).toBeUndefined();
    expect(linearConnector.ops['token']).toBeUndefined();
    expect(linearConnector.ops['issue.delete']).toBeUndefined();
    expect(linearConnector.ops['team.create']).toBeUndefined();
    expect(linearConnector.ops['team.delete']).toBeUndefined();
  });
});

describe('linear api refuseCall — keeps write:false honest (GraphQL gate)', () => {
  const refuse = linearConnector.ops.api!.refuseCall!;

  it('allows a named query', () => {
    expect(refuse(['query Teams { teams { id } }'])).toBeNull();
  });

  it('allows the anonymous { … } shorthand', () => {
    expect(refuse(['{ teams { id } }'])).toBeNull();
  });

  it('allows queries with leading whitespace and # line comments', () => {
    expect(refuse(['  \n# pick teams\nquery Teams { teams { id } }'])).toBeNull();
    expect(refuse(['# header comment\n{ teams { id } }'])).toBeNull();
    expect(refuse(['\t\n  query Teams { teams { id } }'])).toBeNull();
  });

  it('refuses a GraphQL mutation', () => {
    const r = refuse(['mutation IssueCreate { issueCreate(input: {}) { issue { id } } }']);
    expect(r).not.toBeNull();
    expect(r!.exitCode).toBe(65);
    expect(r!.stderr).toMatch(/linear api/);
    expect(r!.stderr).toMatch(/mutation/);
  });

  it('refuses a mutation hidden behind leading whitespace + comment', () => {
    const r = refuse([
      '  # innocuous comment\n  mutation IssueCreate { issueCreate(input: {}) { issue { id } } }',
    ]);
    expect(r).not.toBeNull();
    expect(r!.exitCode).toBe(65);
  });

  it('refuses a GraphQL subscription', () => {
    const r = refuse(['subscription IssueUpdates { issueUpdates { id } }']);
    expect(r).not.toBeNull();
    expect(r!.exitCode).toBe(65);
    expect(r!.stderr).toMatch(/subscription/);
  });

  it('refuses --input (stdin/file body cannot cross the relay)', () => {
    expect(refuse(['--input', '-'])?.exitCode).toBe(65);
    expect(refuse(['--input=/tmp/x'])?.exitCode).toBe(65);
    expect(refuse(['--input=/tmp/x'])?.stderr).toMatch(/--input/);
  });

  it('refuses --variable key=@<path> (host-file load is an exfiltration channel)', () => {
    // `--variable key=@/host/path` reads the file and sends contents as a
    // GraphQL variable — the box could echo the variable back through the
    // query response, an exfiltration channel.
    expect(refuse(['--variable', 'key=@/etc/passwd', '{ x }'])?.exitCode).toBe(65);
    expect(refuse(['--variable=key=@/etc/passwd', '{ x }'])?.exitCode).toBe(65);
    expect(refuse(['--variable', '@/etc/passwd', '{ x }'])?.exitCode).toBe(65);
    expect(refuse(['--variable', 'key=@/etc/passwd'])?.stderr).toMatch(/host-file load/);
  });

  it('allows plain --variable key=value (non-@ values pass)', () => {
    expect(refuse(['--variable', 'key=value', '{ x }'])).toBeNull();
    expect(refuse(['--variable=key=value', '{ x }'])).toBeNull();
  });

  it('consumes --variable / --variables-json values so the JSON is not misread as a positional', () => {
    // The JSON payload to --variables-json must NOT be classified as a
    // positional GraphQL source — otherwise a perfectly benign query whose
    // variables JSON starts with the literal "mutation" would be refused.
    expect(refuse(['--variables-json', '"mutation"', '{ teams { id } }'])).toBeNull();
    expect(refuse(['--variables-json=mutation literal', '{ teams { id } }'])).toBeNull();
    // The --variable VALUE comes as the next token — if we didn't consume
    // it, a value of "mutation" would refuse.
    expect(refuse(['--variable', 'mutation', '{ teams { id } }'])).toBeNull();
    // Order doesn't matter: flag-first still picks up the positional after
    // the consumed value.
    expect(refuse(['--paginate', '--variables-json', '{}', '{ teams { id } }'])).toBeNull();
  });

  it('is case-insensitive on the operation keyword', () => {
    // GraphQL is case-sensitive in spec but defensive matching is cheap.
    expect(refuse(['MUTATION IssueCreate { x }'])?.exitCode).toBe(65);
    expect(refuse(['Subscription Foo { x }'])?.exitCode).toBe(65);
  });

  it('treats flag-only argv as a pass (no positional source to inspect)', () => {
    // The relay still rejects missing-positional at the host CLI; the gate
    // is only responsible for refusing operations it CAN see. Empty/flag-
    // only argv → null (let the host CLI emit its own usage error).
    expect(refuse([])).toBeNull();
    expect(refuse(['--help'])).toBeNull();
  });
});
