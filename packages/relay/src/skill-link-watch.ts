/**
 * Linked skill folders (docs/hub-skills-plan.md, Phase 5): this PC's relay
 * watches every folder `agentbox skills import <path> --link` registered in
 * `~/.agentbox/skill-links.json` and, after a quiet moment, runs the host CLI's
 * `agentbox skills import <path> --linked`. The CLI uploads a new version to the
 * configured hub (normalization, size cap and secret scan included), and the
 * hub's `auto` policy then syncs the running boxes that hold the skill.
 *
 * Spawning the CLI keeps hub resolution and auth in one place, the same
 * decoupling the credential fan-out uses. Never run on a control box: its
 * folders are not anyone's authoring folders.
 */
import { watch, type FSWatcher } from 'node:fs';
import { execa } from 'execa';
import { readSkillLinks, type SkillLink } from '@agentbox/sandbox-core';

export interface SkillLinkWatcherDeps {
  log: (msg: string) => void;
  home?: string;
  /** Quiet time after the last change before uploading. Default 1500 ms. */
  debounceMs?: number;
  /** How often the links file is re-read. Default 5000 ms. */
  rescanMs?: number;
  /** Upload one linked folder (tests). Default: spawn the host CLI. */
  runImport?: (link: SkillLink) => Promise<void>;
  /** fs.watch (tests). */
  watchImpl?: typeof watch;
}

export interface SkillLinkWatcherHandle {
  stop(): Promise<void>;
  /** Re-read the links file now (tests). */
  rescan(): Promise<void>;
}

interface Entry {
  link: SkillLink;
  watcher: FSWatcher | null;
  timer: NodeJS.Timeout | null;
  running: Promise<void> | null;
  again: boolean;
}

async function defaultRunImport(link: SkillLink): Promise<void> {
  const entry = process.env['AGENTBOX_CLI_ENTRY'];
  if (!entry) throw new Error('AGENTBOX_CLI_ENTRY not set; cannot upload a linked skill');
  const r = await execa(process.execPath, [entry, 'skills', 'import', link.path, '--linked'], {
    reject: false,
    timeout: 300_000,
  });
  if (r.exitCode !== 0) {
    throw new Error(
      `exit ${String(r.exitCode)}: ${String(r.stderr || r.stdout)
        .trim()
        .slice(-300)}`,
    );
  }
}

export function startSkillLinkWatcher(deps: SkillLinkWatcherDeps): SkillLinkWatcherHandle {
  const entries = new Map<string, Entry>();
  const debounceMs = deps.debounceMs ?? 1500;
  const runImport = deps.runImport ?? defaultRunImport;
  const watchImpl = deps.watchImpl ?? watch;
  let stopped = false;

  const upload = (e: Entry): void => {
    if (stopped) return;
    if (e.running) {
      e.again = true;
      return;
    }
    e.running = runImport(e.link)
      .then(() => deps.log(`skills: uploaded linked skill ${e.link.name}`))
      .catch((err: unknown) =>
        deps.log(
          `skills: linked skill ${e.link.name} upload failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      )
      .finally(() => {
        e.running = null;
        if (e.again) {
          e.again = false;
          upload(e);
        }
      });
  };

  const arm = (e: Entry): void => {
    try {
      e.watcher = watchImpl(e.link.path, { recursive: true }, (_event, file) => {
        const f = typeof file === 'string' ? file : '';
        if (f === '.git' || f.startsWith('.git/') || f.endsWith('.DS_Store')) return;
        if (e.timer) clearTimeout(e.timer);
        e.timer = setTimeout(() => {
          e.timer = null;
          upload(e);
        }, debounceMs);
      });
      e.watcher.on('error', () => {
        // The folder went away (or was replaced): drop the watch and let the
        // next rescan re-arm it once the path is back.
        e.watcher?.close();
        e.watcher = null;
      });
    } catch {
      e.watcher = null;
    }
  };

  const disarm = (e: Entry): void => {
    e.watcher?.close();
    e.watcher = null;
    if (e.timer) clearTimeout(e.timer);
    e.timer = null;
  };

  const rescan = async (): Promise<void> => {
    if (stopped) return;
    const links = await readSkillLinks(deps.home);
    const want = new Map(links.map((l) => [`${l.name}\0${l.path}`, l]));
    for (const [k, e] of entries) {
      if (!want.has(k)) {
        disarm(e);
        entries.delete(k);
      }
    }
    for (const [k, link] of want) {
      let e = entries.get(k);
      if (!e) {
        e = { link, watcher: null, timer: null, running: null, again: false };
        entries.set(k, e);
        deps.log(`skills: watching linked skill ${link.name} (${link.path})`);
      }
      if (!e.watcher) arm(e);
    }
  };

  void rescan();
  const tick = setInterval(() => void rescan(), deps.rescanMs ?? 5000);
  tick.unref?.();

  return {
    rescan,
    async stop() {
      stopped = true;
      clearInterval(tick);
      const running: Promise<void>[] = [];
      for (const e of entries.values()) {
        disarm(e);
        if (e.running) running.push(e.running);
      }
      entries.clear();
      await Promise.allSettled(running);
    },
  };
}
