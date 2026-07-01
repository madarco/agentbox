import { describe, expect, it } from 'vitest';
import {
  applyReplacements,
  parseReplaceRule,
  parseReplacements,
  parseRuleArg,
  placeholderContextFromEnv,
  ReplaceError,
  resolveRuleRefs,
  substitutePlaceholders,
} from '../src/replace.js';

const ctx = {
  AGENTBOX_BOX_NAME: 'optima-abc123',
  AGENTBOX_BOX_HOST: 'optima-abc123.localhost',
};

describe('substitutePlaceholders', () => {
  it('substitutes whitelisted placeholders', () => {
    expect(substitutePlaceholders('https://{{AGENTBOX_BOX_HOST}}/x', ctx)).toBe(
      'https://optima-abc123.localhost/x',
    );
  });

  it('tolerates inner whitespace', () => {
    expect(substitutePlaceholders('{{ AGENTBOX_BOX_NAME }}', ctx)).toBe('optima-abc123');
  });

  it('leaves non-whitelisted placeholders untouched', () => {
    expect(substitutePlaceholders('{{NOT_ALLOWED}} {{HOME}}', ctx)).toBe('{{NOT_ALLOWED}} {{HOME}}');
  });

  it('leaves whitelisted-but-missing values untouched and warns', () => {
    const warnings: string[] = [];
    const out = substitutePlaceholders('{{AGENTBOX_BOX_ID}}', ctx, (m) => warnings.push(m));
    expect(out).toBe('{{AGENTBOX_BOX_ID}}');
    expect(warnings).toHaveLength(1);
  });
});

describe('applyReplacements', () => {
  it('applies env substitution when env:true', () => {
    expect(
      applyReplacements('host={{AGENTBOX_BOX_HOST}}', { env: true, context: ctx }),
    ).toBe('host=optima-abc123.localhost');
  });

  it('does not substitute placeholders when env is false', () => {
    expect(applyReplacements('{{AGENTBOX_BOX_HOST}}', { context: ctx })).toBe(
      '{{AGENTBOX_BOX_HOST}}',
    );
  });

  it('applies literal rules and substitutes placeholders in the replacement', () => {
    const out = applyReplacements('see optima.localhost here', {
      context: ctx,
      rules: [{ from: 'optima.localhost', to: '{{AGENTBOX_BOX_HOST}}' }],
    });
    expect(out).toBe('see optima-abc123.localhost here');
  });

  it('applies regex rules with capture groups', () => {
    const out = applyReplacements('a1 b2', {
      context: ctx,
      rules: [{ from: '([a-z])(\\d)', to: '$2$1', regex: true }],
    });
    expect(out).toBe('1a 2b');
  });

  it('treats $ literally in literal rules', () => {
    const out = applyReplacements('price', {
      context: ctx,
      rules: [{ from: 'price', to: '$1.00' }],
    });
    expect(out).toBe('$1.00');
  });

  it('throws ReplaceError on an invalid regex rule', () => {
    expect(() =>
      applyReplacements('x', { context: ctx, rules: [{ from: '(', to: 'y', regex: true }] }),
    ).toThrow(ReplaceError);
  });
});

describe('placeholderContextFromEnv', () => {
  it('derives AGENTBOX_BOX_HOST from the box name', () => {
    const c = placeholderContextFromEnv({ AGENTBOX_BOX_NAME: 'foo' } as NodeJS.ProcessEnv);
    expect(c.AGENTBOX_BOX_HOST).toBe('foo.localhost');
  });

  it('ignores non-whitelisted env vars', () => {
    const c = placeholderContextFromEnv({
      AGENTBOX_BOX_NAME: 'foo',
      SECRET: 'nope',
    } as NodeJS.ProcessEnv);
    expect(c).not.toHaveProperty('SECRET');
  });

  it('prefers an explicit AGENTBOX_BOX_HOST over the derived host', () => {
    // The cloud public-URL fix relies on this: a box that sets AGENTBOX_BOX_HOST
    // to its real preview host (e.g. <sub>.vercel.run) must win over the
    // <name>.localhost fallback derived from AGENTBOX_BOX_NAME.
    const c = placeholderContextFromEnv({
      AGENTBOX_BOX_NAME: 'foo',
      AGENTBOX_BOX_HOST: 'abc123.vercel.run',
    } as NodeJS.ProcessEnv);
    expect(c.AGENTBOX_BOX_HOST).toBe('abc123.vercel.run');
  });
});

describe('rule parsing', () => {
  it('parses a top-level replacements block', () => {
    const r = parseReplacements({ host: [{ from: 'a', to: 'b' }] });
    expect(r.host).toEqual([{ from: 'a', to: 'b' }]);
  });

  it('rejects an unknown rule key', () => {
    expect(() => parseReplaceRule({ from: 'a', to: 'b', bogus: 1 }, 'x')).toThrow(ReplaceError);
  });

  it('rejects an invalid regex at parse time', () => {
    expect(() => parseReplaceRule({ from: '(', to: 'b', regex: true }, 'x')).toThrow(ReplaceError);
  });

  it('resolveRuleRefs concatenates named sets in order', () => {
    const sets = { a: [{ from: '1', to: 'one' }], b: [{ from: '2', to: 'two' }] };
    expect(resolveRuleRefs(['a', 'b'], sets, 'x')).toEqual([
      { from: '1', to: 'one' },
      { from: '2', to: 'two' },
    ]);
  });

  it('resolveRuleRefs throws on an unknown name', () => {
    expect(() => resolveRuleRefs(['ghost'], {}, 'carry[0].rules')).toThrow(/unknown/);
  });

  it('parseRuleArg parses from=>to', () => {
    expect(parseRuleArg('a=>b', false)).toEqual({ from: 'a', to: 'b' });
    expect(parseRuleArg('a=>b', true)).toEqual({ from: 'a', to: 'b', regex: true });
  });

  it('parseRuleArg rejects a missing arrow', () => {
    expect(() => parseRuleArg('noarrow', false)).toThrow(ReplaceError);
  });
});
