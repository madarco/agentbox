import { describe, expect, it } from 'vitest';
import { parseProviderWarning, providerWarning } from '../src/provider-warning.js';

/**
 * Provider progress is rendered as transient chrome — an 80-column spinner
 * frame the next line overwrites. The marker is how a line that must outlive
 * the command gets picked back out of that stream.
 */
describe('provider warnings', () => {
  it('round-trips the text', () => {
    expect(parseProviderWarning(providerWarning('base fell back to a container'))).toBe(
      'base fell back to a container',
    );
  });

  it('leaves an ordinary progress line alone', () => {
    expect(parseProviderWarning('#14 [11/62] RUN npm install -g playwright')).toBeNull();
  });

  // The prefix only counts at the start: a build log quoting it mid-line is
  // still build output, not a warning to re-state.
  it('does not match the marker mid-line', () => {
    expect(parseProviderWarning('echo agentbox-warning: not a real one')).toBeNull();
  });

  it('keeps a multi-line warning whole', () => {
    const text = 'line one\n  line two';
    expect(parseProviderWarning(providerWarning(text))).toBe(text);
  });
});

/**
 * A queued bake reaches the terminal through the worker's log file and the hub
 * API, and the worker stamps every line — so the marker arrives mid-string.
 * Missing this made the whole mechanism a no-op for exactly the case it exists
 * for: a hub-run `prepare`.
 */
describe('provider warnings through a timestamped transport', () => {
  it('reads the marker behind a log timestamp', () => {
    const line = `2026-08-31T11:43:38.643Z ${providerWarning('base fell back to a container')}`;
    expect(parseProviderWarning(line)).toBe('base fell back to a container');
  });

  it('still ignores a timestamped ordinary line', () => {
    expect(parseProviderWarning('2026-08-31T11:43:38.643Z #14 [11/62] RUN npm i')).toBeNull();
  });
});
