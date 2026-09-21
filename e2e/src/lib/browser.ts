import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './exec.js';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export function browserAvailable(): boolean {
  return existsSync(CHROME);
}

/**
 * Screenshot a page with headless Chrome. The hub web UI renders client-side, so a
 * virtual-time budget lets its fetches settle before the capture. A throwaway
 * profile keeps the user's own Chrome profile out of it.
 */
export async function screenshot(url: string, out: string, log: string): Promise<void> {
  const profile = mkdtempSync(join(tmpdir(), 'e2e-chrome-'));
  try {
    await run(
      CHROME,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        `--user-data-dir=${profile}`,
        '--window-size=1400,1000',
        '--virtual-time-budget=15000',
        `--screenshot=${out}`,
        url,
      ],
      { log, timeoutMs: 120_000, allowFail: true },
    );
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
  if (!existsSync(out)) throw new Error(`headless Chrome wrote no screenshot for ${url}`);
}
