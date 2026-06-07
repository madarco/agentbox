import { describe, expect, it } from 'vitest';
import { notionConnector } from '../src/connectors/notion.js';

// The `api` op's refuseCall is the security gate under test.
const refuseCall = notionConnector.ops.api!.refuseCall!;
const allowed = (args: string[]): boolean => refuseCall(args) === null;

describe('notion api gate (refuseUnsafeApiCall)', () => {
  describe('allows reads', () => {
    it.each([
      [['v1/users/me']],
      [['v1/pages/abc123']],
      [['v1/databases/abc']],
      [['v1/databases/abc', 'page_size==50']], // GET with a query param, not a body
      [['v1/users/me', '-X', 'GET']],
      [['v1/users/me', 'Accept:application/json']], // header, not a body
      [['v1/databases/abc', '--spec']], // read-only doc dump flags pass
      [['v1/pages/abc', '--docs']],
      [['v1/users/me', '-v']], // verbose boolean passes
      [['v1/databases/abc', '--notion-version=2022-06-28']], // glued value flag
    ])('GET %j', (args) => {
      expect(allowed(args)).toBe(true);
    });

    it.each([
      [['v1/search', '-d', '{"query":"x"}']],
      [['v1/databases/abc/query', '-d', '{"page_size":100}']],
      [['v1/data_sources/37813cf9-9ae2-80f0-b556-000b6299b8de/query', '-d', '{"page_size":100}']],
      [['/v1/search', '-d', '{}']], // leading-slash tolerant
      [['v1/search', 'query=foo']], // inline string body infers POST
      [['v1/data_sources/abc/query', 'filter:={}']], // typed JSON body infers POST
      [['v1/search', '-X', 'POST', '-d', '{}']], // explicit POST
      [['v1/search', '--data={}']], // glued forms
      [['v1/databases/abc/query', '-d{}']],
    ])('read-only POST %j', (args) => {
      expect(allowed(args)).toBe(true);
    });
  });

  describe('refuses writes / unsafe calls', () => {
    it.each([
      [['v1/pages', '-d', '{"parent":{}}']], // create page (body → POST write)
      [['v1/comments', '-d', '{}']],
      [['v1/pages', 'title=x']], // inline body to a write endpoint
      [['v1/blocks/abc/children', '-d', '{}']],
      [['v1/pages/abc', '-X', 'PATCH', '-d', '{}']],
      [['v1/pages/abc', '-X', 'DELETE']],
      [['v1/databases/abc', '-XPOST']], // POST to a non-/query db endpoint
      [['v1/data_sources/abc/blah', '-d', '{}']], // POST to a non-read path
      [['v1/search/../pages', '-d', '{}']], // traversal can't reach the allowlist
      [['v1/databases/../query', 'foo:=1']], // `..` segment refused even if regex-shaped
      [['-X', 'POST']], // non-GET with no endpoint → fail closed
      // Global value-consuming flags accepted after `api` must NOT have their
      // value misread as the endpoint (the real write bypass the gate closes):
      [['--workers-config-file', 'v1/search', 'v1/pages', '-d', '{}']],
      [['--env', 'prod', 'v1/pages', 'title=x']],
      [['--workers-config-file=foo', 'v1/pages', '-d', '{}']], // glued form too
    ])('%j', (args) => {
      const r = refuseCall(args);
      expect(r).not.toBeNull();
      expect(r!.exitCode).toBe(65);
    });

    it.each([
      [['v1/search', '--input', '-']], // stdin/file body — even to a read endpoint
      [['v1/databases/abc/query', '--file', '/etc/passwd']], // host-file upload
    ])('host/stdin body %j', (args) => {
      const r = refuseCall(args);
      expect(r).not.toBeNull();
      expect(r!.exitCode).toBe(65);
    });
  });
});
