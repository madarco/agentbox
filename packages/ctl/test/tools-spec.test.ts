import { describe, expect, it } from 'vitest';
import { parseToolsRaw, parseToolsSection, ToolsConfigError } from '../src/tools-spec.js';

describe('agentbox.yaml tools: block', () => {
  it('accepts the bare list form', () => {
    expect(parseToolsRaw(['terraform', 'aws'])).toEqual([{ name: 'terraform' }, { name: 'aws' }]);
  });

  it('accepts the mapping form with options', () => {
    expect(
      parseToolsRaw({
        terraform: { bin: 'tofu', allow: ['^plan$'], deny: ['^destroy'], timeoutMs: 300000 },
      }),
    ).toEqual([
      {
        name: 'terraform',
        bin: 'tofu',
        allow: ['^plan$'],
        deny: ['^destroy'],
        timeoutMs: 300000,
      },
    ]);
  });

  it('accepts an empty mapping value', () => {
    expect(parseToolsRaw({ terraform: null })).toEqual([{ name: 'terraform' }]);
  });

  it('treats an absent block as no requests', () => {
    expect(parseToolsRaw(undefined)).toEqual([]);
    expect(parseToolsSection('services: {}\n')).toEqual([]);
  });

  it('parses from a full yaml document', () => {
    expect(parseToolsSection('tools:\n  - terraform\n')).toEqual([{ name: 'terraform' }]);
  });

  // A bad regex that silently never matches would be a hole in a `deny` list,
  // so patterns are compile-checked at parse time.
  it('rejects an invalid regex rather than letting it never match', () => {
    expect(() => parseToolsRaw({ aws: { deny: ['([unclosed'] } })).toThrow(ToolsConfigError);
  });

  it('rejects a name that is not a bare command', () => {
    expect(() => parseToolsRaw(['../../evil'])).toThrow(ToolsConfigError);
    expect(() => parseToolsRaw({ 'a/b': {} })).toThrow(ToolsConfigError);
  });

  it('rejects an unknown option (typo detection)', () => {
    expect(() => parseToolsRaw({ aws: { allowed: ['x'] } })).toThrow(/not a known option/);
  });

  it('rejects a non-positive timeout', () => {
    expect(() => parseToolsRaw({ aws: { timeoutMs: 0 } })).toThrow(ToolsConfigError);
    expect(() => parseToolsRaw({ aws: { timeoutMs: -5 } })).toThrow(ToolsConfigError);
  });

  // Reported by review: a committed yaml pointing `bin` at a path would get a
  // script from the repo's own checkout executed on the host with the host's
  // credentials — precisely what the request-vs-grant split exists to stop.
  it('rejects a bin that is a path rather than a bare command name', () => {
    for (const bin of ['./scripts/evil.sh', '/usr/bin/env', '../x', 'a/b']) {
      expect(() => parseToolsRaw({ terraform: { bin } })).toThrow(/bare command name/);
    }
  });

  it('accepts a bare command name as bin', () => {
    expect(parseToolsRaw({ terraform: { bin: 'tofu' } })).toEqual([
      { name: 'terraform', bin: 'tofu' },
    ]);
  });

  it('rejects a non-string entry in the list form', () => {
    expect(() => parseToolsRaw([{ name: 'aws' }])).toThrow(/must be a tool name string/);
  });
});
