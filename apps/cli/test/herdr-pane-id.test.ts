import { describe, expect, it } from 'vitest';
import { extractHerdrPaneId } from '../src/terminal/host.js';

/**
 * `extractHerdrPaneId` pulls the new pane id out of a Herdr create reply so the
 * spawn path can type the attach command into it. Herdr numbers panes in
 * HEXADECIMAL (`p9` → `pA` → `pB` …), so the extractor must not assume decimal
 * digits — a regression that silently dropped hex pane ids made `-i` boxes open
 * a new tab with only a bare shell (the attach `send_text` never fired).
 */
describe('extractHerdrPaneId', () => {
  // The exact reply shape captured live from `tab.create` (Herdr 0.7).
  const tabReply = (paneId: string): Record<string, unknown> => ({
    type: 'tab_created',
    tab: { tab_id: 'w1:t6', workspace_id: 'w1', number: 6 },
    root_pane: { pane_id: paneId, terminal_id: 'term_abc', workspace_id: 'w1', tab_id: 'w1:t6' },
  });

  it('extracts a low decimal pane id from root_pane', () => {
    expect(extractHerdrPaneId(tabReply('w1:p9'))).toBe('w1:p9');
  });

  it('extracts a hex-lettered pane id (the 10th+ pane) from root_pane', () => {
    // The actual failing case: the 10th pane is `pA`, which `/:p\d+$/` rejected.
    expect(extractHerdrPaneId(tabReply('w1:pA'))).toBe('w1:pA');
    expect(extractHerdrPaneId(tabReply('w1:pB'))).toBe('w1:pB');
    expect(extractHerdrPaneId(tabReply('w1:pFF'))).toBe('w1:pFF');
  });

  it('extracts a pane id from the `pane` field (pane.split reply)', () => {
    expect(extractHerdrPaneId({ pane: { pane_id: 'w1:pC' } })).toBe('w1:pC');
  });

  it('extracts a top-level pane_id', () => {
    expect(extractHerdrPaneId({ pane_id: 'w1:pA' })).toBe('w1:pA');
  });

  it('falls back to a regex over the serialized reply for an unknown shape', () => {
    expect(extractHerdrPaneId({ something: { nested: { pane_id: 'w2:pA1' } } })).toBe('w2:pA1');
  });

  it('returns undefined for null or a reply with no pane id', () => {
    expect(extractHerdrPaneId(null)).toBeUndefined();
    expect(extractHerdrPaneId({ type: 'tab_created', tab: { tab_id: 'w1:t6' } })).toBeUndefined();
  });
});
