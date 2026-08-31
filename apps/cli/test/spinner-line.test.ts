import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clampSpinnerLine } from '@agentbox/cli-kit';

/**
 * `clampSpinnerLine` is the safety belt around clack's spinner: it
 * collapses multi-line input to a single line and clamps width. The
 * pile-up bug observed during `agentbox create --provider daytona`
 * (each Daytona Image.fromDockerfile log callback feeds a multi-line
 * chunk and clack only redraws the first line) is the specific case
 * this covers.
 */

const originalIsTTY = process.stdout.isTTY;
const originalCols = process.stdout.columns;

function setTty(isTty: boolean, cols?: number): void {
  Object.defineProperty(process.stdout, 'isTTY', { value: isTty, configurable: true });
  if (cols !== undefined) {
    Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true });
  }
}

describe('clampSpinnerLine', () => {
  beforeEach(() => setTty(true, 80));
  afterEach(() => {
    setTty(originalIsTTY ?? false, originalCols);
  });

  it('passes a short single line through unchanged', () => {
    expect(clampSpinnerLine('hello')).toBe('hello');
  });

  it('truncates with an ellipsis when wider than the terminal', () => {
    setTty(true, 20);
    const out = clampSpinnerLine('a'.repeat(50));
    expect(out.length).toBeLessThanOrEqual(20 - 6); // SPINNER_CHROME = 6
    expect(out.endsWith('…')).toBe(true);
  });

  it('collapses multi-line input to its last non-empty line (the daytona pile-up bug)', () => {
    // Wide terminal so the long URL doesn't get width-truncated — we're
    // testing the line-collapse behavior here.
    setTty(true, 200);
    const daytonaChunk =
      '#1 [internal] load remote build context\n' +
      '#2 copy /context /\n' +
      '#3 [internal] load metadata for mcr.microsoft.com/devcontainers/base:ubuntu-24.04';
    expect(clampSpinnerLine(daytonaChunk)).toBe(
      '#3 [internal] load metadata for mcr.microsoft.com/devcontainers/base:ubuntu-24.04',
    );
  });

  it('skips trailing blank lines and returns the actual last progress line', () => {
    const input = 'starting\nbuilding\nfetched 38.2 MB\n\n\n';
    expect(clampSpinnerLine(input)).toBe('fetched 38.2 MB');
  });

  it('handles CR / CRLF (apt-style progress bars) by folding them into newlines', () => {
    const input = 'Reading package lists...\rReading package lists... 50%\rDone';
    expect(clampSpinnerLine(input)).toBe('Done');
  });

  it('returns empty string when every line is blank', () => {
    expect(clampSpinnerLine('\n  \n\t\n')).toBe('');
  });

  it('non-TTY skips width clamping but still collapses lines', () => {
    setTty(false, undefined);
    expect(clampSpinnerLine('first\nsecond')).toBe('second');
    // Long line passes through unmodified (no terminal width to clamp to).
    const long = 'x'.repeat(200);
    expect(clampSpinnerLine(long)).toBe(long);
  });
});
