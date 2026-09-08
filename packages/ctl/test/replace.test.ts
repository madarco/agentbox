import { describe, expect, it } from 'vitest';
import { parseReplacementsSection, removeReplacementsSet } from '../src/replace.js';

/**
 * Yaml surgery on `agentbox.yaml`, used by `agentbox clone`: a bot's identity
 * rules name the SOURCE bot, so the copy must not keep them.
 */
describe('removeReplacementsSet', () => {
  it('removes one set and the sentinel, keeping the rest of the file', () => {
    const before = [
      'openclaw:',
      '  logging:',
      '    level: info',
      '',
      '# agentbox:identity-rules (written by /agentbox-identity)',
      'replacements:',
      '  identity:',
      "    - from: '\\bAda\\b'",
      "      to: '{{AGENTBOX_BOX_NAME}}'",
      '      regex: true',
      '',
    ].join('\n');

    const after = removeReplacementsSet(before, 'identity', 'agentbox:identity-rules');

    expect(after).not.toContain('identity:');
    expect(after).not.toContain('agentbox:identity-rules');
    // The user's own config is untouched — a clone has no business editing it.
    expect(after).toContain('openclaw:');
    expect(after).toContain('level: info');
  });

  it('drops an emptied replacements: rather than leaving a null key', () => {
    // `replacements:` with no children parses as null, which the section parser
    // then rejects — the clone would hand the new box a broken yaml.
    const after = removeReplacementsSet(
      'replacements:\n  identity:\n    - from: Ada\n      to: bea\n',
      'identity',
    );
    expect(after).not.toContain('replacements:');
    expect(() => parseReplacementsSection(after)).not.toThrow();
  });

  it('keeps sibling rule-sets', () => {
    const after = removeReplacementsSet(
      'replacements:\n  identity:\n    - from: Ada\n      to: bea\n  box-host:\n    - from: a\n      to: b\n',
      'identity',
    );
    expect(parseReplacementsSection(after)).toHaveProperty('box-host');
    expect(parseReplacementsSection(after)).not.toHaveProperty('identity');
  });

  it('returns the text unchanged when there is nothing to remove', () => {
    const text = 'openclaw:\n  logging:\n    level: info\n';
    expect(removeReplacementsSet(text, 'identity', 'agentbox:identity-rules')).toBe(text);
  });

  it('leaves a file it cannot parse alone', () => {
    const broken = 'replacements:\n  identity:\n   - from: [unclosed\n';
    expect(removeReplacementsSet(broken, 'identity')).toBe(broken);
  });
});
