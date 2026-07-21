/**
 * "Star this project" prompt shown at the end of `agentbox install` and
 * `agentbox self-update`.
 *
 * Cadence (deliberately gentle, no nagging):
 *   - install:     skip runs 1, 2 and 5+; the 3rd and 4th completed wizards are
 *                  the ask window (the 4th only fires if the 3rd went unanswered).
 *   - self-update: ask until the user answers.
 *   - once the user answers — yes or no — never ask again. A yes without an
 *     authenticated `gh` opens the browser; we trust it and still stop asking.
 *
 * State lives at `~/.agentbox/star-prompt.json` (same dir as the first-run
 * marker). Self-contained — no dependency on `@agentbox/relay`, whose `gh`
 * helpers are server-side; we shell out to `gh` directly here.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { hostOpenCommand } from '@agentbox/sandbox-core';
import { confirm, log } from './prompt.js';

const STATE_VERSION = 1 as const;
const REPO = 'madarco/agentbox';
const REPO_URL = `https://github.com/${REPO}`;

interface StarState {
  version: typeof STATE_VERSION;
  installCount: number;
  starred: boolean;
  answered: boolean;
}

const DEFAULT_STATE: StarState = {
  version: STATE_VERSION,
  installCount: 0,
  starred: false,
  answered: false,
};

function starStatePath(): string {
  return join(homedir(), '.agentbox', 'star-prompt.json');
}

function readStarState(): StarState {
  const path = starStatePath();
  if (!existsSync(path)) return { ...DEFAULT_STATE };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StarState>;
    return {
      version: STATE_VERSION,
      installCount: typeof parsed.installCount === 'number' ? parsed.installCount : 0,
      starred: parsed.starred === true,
      answered: parsed.answered === true,
    };
  } catch {
    // Corrupt/unreadable — treat as fresh rather than crashing install.
    return { ...DEFAULT_STATE };
  }
}

function writeStarState(state: StarState): void {
  const path = starStatePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n');
}

/** `gh` installed AND authenticated. ENOENT (gh missing) or a non-zero
 *  `gh auth status` both read as "not ready" → caller falls back to browser. */
function ghReady(): boolean {
  const r = spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' });
  return r.error === undefined && r.status === 0;
}

export interface StarPromptOptions {
  trigger: 'install' | 'self-update';
}

export async function maybePromptStar(opts: StarPromptOptions): Promise<void> {
  // Never prompt when there's no human at the keyboard.
  if (!process.stdout.isTTY) return;

  const state = readStarState();
  if (state.starred || state.answered) return;

  let shouldPrompt: boolean;
  if (opts.trigger === 'install') {
    // Advance the counter even on runs we don't prompt, then persist.
    state.installCount += 1;
    writeStarState(state);
    shouldPrompt = state.installCount === 3 || state.installCount === 4;
  } else {
    shouldPrompt = true;
  }
  if (!shouldPrompt) return;

  const yes = await confirm({
    message: 'Help support this open source project — would you like to star it on GitHub? Thanks!',
    initialValue: true,
  });
  // Any explicit answer settles it — never re-ask. (Ctrl+C aborts before this.)
  state.answered = true;
  writeStarState(state);
  if (!yes) return;

  try {
    if (ghReady()) {
      const r = spawnSync('gh', ['api', '--method', 'PUT', `/user/starred/${REPO}`], {
        stdio: 'ignore',
      });
      if (r.error === undefined && r.status === 0) {
        state.starred = true;
        writeStarState(state);
        log.success(`Starred ${REPO} — thank you!`);
        return;
      }
      // gh present but the star call failed — fall through to the browser.
    }
    spawnSync(hostOpenCommand(), [REPO_URL], { stdio: 'ignore' });
    log.info(`Opened ${REPO_URL} — star away!`);
  } catch (err) {
    // A failed star must never break install/update.
    log.warn(
      `couldn't open the star page (${err instanceof Error ? err.message : String(err)}) — star it anytime at ${REPO_URL}`,
    );
  }
}
