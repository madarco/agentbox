import { describe, expect, it } from 'vitest';
import type { BoxRecord } from '@agentbox/core';
import { withLlmProxyHost } from '../src/cloud-provider.js';
import { boxLlmProxyPreamble, buildCloudAttachInnerCommand } from '../src/detached-agent.js';

const rec = { mode: 'forward' as const, upstream: 'hub.example.com:8790' };
const box = (llmProxy?: typeof rec) =>
  ({ name: 'b', ...(llmProxy ? { llmProxy } : {}) }) as unknown as BoxRecord;

describe('withLlmProxyHost (vercel networkPolicy)', () => {
  it('adds the hub host to an allowlist, once', () => {
    expect(withLlmProxyHost('github.com,npmjs.org', rec)).toBe(
      'github.com,npmjs.org,hub.example.com',
    );
    expect(withLlmProxyHost('hub.example.com', rec)).toBe('hub.example.com');
  });
  it('leaves unset / allow-all / deny-all and a proxy-less box alone', () => {
    expect(withLlmProxyHost(undefined, rec)).toBeUndefined();
    expect(withLlmProxyHost('allow-all', rec)).toBe('allow-all');
    expect(withLlmProxyHost('deny-all', rec)).toBe('deny-all');
    expect(withLlmProxyHost('github.com', undefined)).toBe('github.com');
  });
});

describe('the cloud launch command and the LLM split proxy', () => {
  it('no proxy: the command is unchanged', () => {
    expect(boxLlmProxyPreamble(box(), 'claude')).toBe('');
    expect(
      buildCloudAttachInnerCommand('claude', [], {}, boxLlmProxyPreamble(box(), 'claude')),
    ).toBe(buildCloudAttachInnerCommand('claude', [], {}));
  });
  it('an agent with no model hosts is never proxied', () => {
    expect(boxLlmProxyPreamble(box(rec), 'opencode')).toBe('');
  });
  it('a forward box starts the split proxy before the agent, inside the bash -lc body', () => {
    for (const args of [[], ['--model', 'sonnet']]) {
      const cmd = buildCloudAttachInnerCommand(
        'claude',
        args,
        {},
        boxLlmProxyPreamble(box(rec), 'claude'),
      );
      expect(cmd.startsWith("bash -lc '")).toBe(true);
      // Exactly the two quotes that open and close the body: the preamble adds none.
      expect(cmd.split("'").length).toBe(3);
      const body = cmd.slice(cmd.indexOf("'") + 1);
      expect(body.indexOf('export HTTPS_PROXY=http://127.0.0.1:47290')).toBeLessThan(
        body.indexOf('exec claude'),
      );
      expect(body).toContain('--ensure 47290 hub.example.com:8790 api.anthropic.com,');
    }
  });
  it('refuses a preamble that would break the quoting', () => {
    expect(() => buildCloudAttachInnerCommand('claude', [], {}, "echo 'x'; ")).toThrow(
      /single quote/,
    );
  });
});
