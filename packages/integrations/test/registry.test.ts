import { describe, expect, it } from 'vitest';
import { ALL_CONNECTORS, getConnector } from '../src/registry.js';
import { notionConnector } from '../src/connectors/notion.js';

describe('integration registry', () => {
  it('exposes the Notion connector exactly once', () => {
    expect(ALL_CONNECTORS).toContain(notionConnector);
    expect(ALL_CONNECTORS.filter((c) => c.service === 'notion')).toHaveLength(1);
  });

  it('looks up by service name', () => {
    expect(getConnector('notion')).toBe(notionConnector);
  });

  it('returns null for unknown services (allowlist)', () => {
    expect(getConnector('linear')).toBeNull();
    expect(getConnector('clickup')).toBeNull();
    expect(getConnector('')).toBeNull();
    expect(getConnector('NOTION')).toBeNull(); // case-sensitive — matches wire shape
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
