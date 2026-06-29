import { resolve } from 'node:path';
import { log } from '@clack/prompts';
import { Command } from 'commander';
import { loadEffectiveConfig } from '@agentbox/config';
import {
  downloadFromBox,
  inspectBox,
  startBox,
  unpauseBox,
  uploadToBox,
} from '@agentbox/sandbox-docker';
import { resolveBoxOrExit } from '../box-ref.js';
import { providerForBox } from '../provider/registry.js';
import {
  effectiveExcludes,
  fmtBytes,
  measureCopy,
  toTarExcludes,
} from '../lib/dir-breakdown.js';
import { handleLifecycleError } from './_errors.js';

interface CpOptions {
  exclude: string[];
  defaultExcludes: boolean;
  yes: boolean;
}

function collectExclude(val: string, acc: string[]): string[] {
  acc.push(val);
  return acc;
}

/**
 * Block an upload whose post-exclude size exceeds `box.cpMaxBytes` unless `--yes`
 * is passed, printing a `du`-style tree + a strategy the (often agent) caller can
 * act on. The limit is enforced *per source* (not on the sum) so the split
 * suggestions stay coherent for a multi-source copy. Returns the tar `--exclude`
 * patterns to apply to the copy.
 */
async function guardUploadSizes(
  hostSrcs: string[],
  boxDst: string,
  opts: CpOptions,
): Promise<string[]> {
  const tokens = effectiveExcludes(opts.exclude, opts.defaultExcludes);
  const tarPatterns = toTarExcludes(tokens);
  if (opts.yes) return tarPatterns;

  const cfg = await loadEffectiveConfig(process.cwd());
  const maxBytes = cfg.effective.box.cpMaxBytes;

  for (const hostSrc of hostSrcs) {
    const absSrc = resolve(hostSrc);
    const measured = await measureCopy(absSrc, tokens);
    if (measured.totalBytes <= maxBytes) continue;

    const dropped =
      measured.isDir && opts.defaultExcludes
        ? ` after default excludes (${effectiveExcludes([], true).join(', ')})`
        : '';
    const lines: string[] = [
      `${hostSrc} is ${fmtBytes(measured.totalBytes)}${dropped}, over the ${fmtBytes(maxBytes)} per-copy limit.`,
    ];
    if (measured.isDir) {
      // Directory: show where the weight is and how to split / trim it.
      lines.push(
        'Biggest remaining folders/subfolders:',
        ...measured.treeLines,
        'Each copy must be under the limit. To proceed, EITHER:',
        '  - copy the heavy folders one at a time, e.g.:',
      );
      for (const child of measured.topChildren.slice(0, 3)) {
        lines.push(`      agentbox cp ${hostSrc}/${child.path} ${boxDst}`);
      }
      lines.push(
        '  - or drop what you do not need:',
        `      agentbox cp ${hostSrc} ${boxDst} --exclude=<dir>`,
        '  - or copy the whole thing anyway:',
        `      agentbox cp ${hostSrc} ${boxDst} --yes`,
      );
    } else {
      // Single file: can't split or exclude — only override.
      lines.push(
        'A single file cannot be split or trimmed. To copy it anyway:',
        `      agentbox cp ${hostSrc} ${boxDst} --yes`,
      );
    }
    throw new Error(lines.join('\n'));
  }
  return tarPatterns;
}

/**
 * A `<box>:<path>` arg has a `:` in it AND no `/` before that colon. Anything
 * starting with `./`, `/`, or `../` is unambiguously a host path. Box names
 * are kebab-case identifiers (validated at create), so they can't contain
 * `/`. Empty box ref or missing path → returns null and the caller errors out.
 */
function parseBoxArg(arg: string): { boxRef: string; path: string } | null {
  const idx = arg.indexOf(':');
  if (idx === -1) return null;
  const prefix = arg.slice(0, idx);
  if (prefix.includes('/')) return null;
  if (prefix.length === 0) return null;
  const p = arg.slice(idx + 1);
  if (p.length === 0) return null;
  return { boxRef: prefix, path: p };
}

interface Parsed {
  direction: 'download' | 'upload';
  boxRef: string;
  // download: box-side sources (>=1) + host-side dest (undefined = cwd)
  boxSrcs?: string[];
  hostDst?: string;
  // upload: host-side sources (>=1) + box-side dest
  hostSrcs?: string[];
  boxDst?: string;
}

/**
 * Split a variadic `cp` arg list into sources + destination and pick the
 * direction. Commander requires the variadic to be the last argument, so the
 * destination is recovered by arity: one arg downloads into cwd; otherwise the
 * last arg is the destination and the rest are sources. Every source must be on
 * the side opposite the destination (no box-to-box, no mixed sides), and all
 * box sources must name the same box.
 */
export function parseArgs(paths: string[]): Parsed {
  if (paths.length === 0) {
    throw new Error('cp requires at least one path.');
  }
  const sources = paths.length === 1 ? paths : paths.slice(0, -1);
  const dst = paths.length === 1 ? undefined : paths[paths.length - 1];

  const srcBoxes = sources.map((s) => ({ raw: s, box: parseBoxArg(s) }));
  const dstBox = dst === undefined ? null : parseBoxArg(dst);
  const allSrcBox = srcBoxes.every((s) => s.box);
  const anySrcBox = srcBoxes.some((s) => s.box);

  if (anySrcBox && !allSrcBox) {
    throw new Error(
      'all sources must be on the same side; mixing box paths (`name:/path`) and host paths is not supported.',
    );
  }
  if (allSrcBox && dstBox) {
    throw new Error(
      'box-to-box copy is not supported; both sides look like box paths (`name:/path`).',
    );
  }
  if (!allSrcBox && !dstBox) {
    throw new Error(
      'one side must be a box path of the form `<box>:/path` (e.g. `mybox:/workspace/foo`).',
    );
  }
  if (allSrcBox) {
    const boxRefs = new Set(srcBoxes.map((s) => s.box!.boxRef));
    if (boxRefs.size > 1) {
      throw new Error(
        `all box sources must name the same box; got ${[...boxRefs].join(', ')}.`,
      );
    }
    return {
      direction: 'download',
      boxRef: srcBoxes[0]!.box!.boxRef,
      boxSrcs: srcBoxes.map((s) => s.box!.path),
      hostDst: dst,
    };
  }
  if (dst === undefined) {
    throw new Error('host -> box copy requires a destination, e.g. `agentbox cp ./foo box:/dst`.');
  }
  return {
    direction: 'upload',
    boxRef: dstBox!.boxRef,
    hostSrcs: sources,
    boxDst: dstBox!.path,
  };
}

export const cpCommand = new Command('cp')
  .description('Copy files between host and box (like `docker cp`; direction picked by `name:` prefix)')
  .argument(
    '<paths...>',
    'source path(s) then destination; `box:/path` marks the box side. With one arg, downloads into cwd. With >=2 sources the destination must be a directory.',
  )
  .option(
    '--exclude <pattern>',
    'exclude paths matching <pattern> (repeatable; tar glob like "*/foo" or a bare dir name)',
    collectExclude,
    [],
  )
  .option(
    '--no-default-excludes',
    `keep the heavy dirs cp drops by default (${effectiveExcludes([], true).join(', ')})`,
  )
  .option('-y, --yes', 'copy even if a source is over the box.cpMaxBytes size limit')
  .addHelpText(
    'after',
    [
      '',
      'Examples:',
      '  agentbox cp mybox:/etc/foo ./foo            # download (host path optional)',
      '  agentbox cp mybox:/workspace/.env           # download into cwd',
      '  agentbox cp ./local.txt mybox:/workspace/   # upload (host path required)',
      '  agentbox cp ./dir mybox:/workspace/         # upload directory (recursive)',
      '  agentbox cp a.txt b.txt src/ mybox:/workspace/dest/   # many sources into a dir',
      '  agentbox cp ./*.log mybox:/workspace/logs/  # shell-expanded wildcard',
      '  agentbox cp ./dir mybox:/workspace/ --exclude=.git --exclude="*/cache"',
    ].join('\n'),
  )
  .action(async (paths: string[], opts: CpOptions) => {
    try {
      const parsed = parseArgs(paths);
      const box = await resolveBoxOrExit(parsed.boxRef);
      const isCloud = (box.provider ?? 'docker') !== 'docker';

      // Excludes apply to both directions; the size guard only gates uploads
      // (we know the host source's size cheaply; a box-side dir we don't).
      const tarPatterns =
        parsed.direction === 'upload'
          ? await guardUploadSizes(parsed.hostSrcs!, `${parsed.boxRef}:${parsed.boxDst}`, opts)
          : toTarExcludes(effectiveExcludes(opts.exclude, opts.defaultExcludes));

      if (isCloud) {
        // Cloud cp: provider.uploadPath / downloadPath handle the tar +
        // backend.uploadFile/downloadFile dance. No docker exec, no pause-
        // probe — Daytona sandboxes don't have a Docker container state to
        // probe and the SDK handles the running/archived states itself.
        const provider = await providerForBox(box);
        if (!provider.uploadPath || !provider.downloadPath) {
          throw new Error(`provider '${provider.name}' does not support cp`);
        }
        if (parsed.direction === 'upload') {
          const result = await provider.uploadPath(box, parsed.hostSrcs!, parsed.boxDst!, tarPatterns);
          process.stdout.write(`copied to ${box.name}:${result.finalPath}\n`);
        } else {
          const result = await provider.downloadPath(
            box,
            parsed.boxSrcs!,
            parsed.hostDst ?? process.cwd(),
            tarPatterns,
          );
          process.stdout.write(`copied to ${result.finalPath}\n`);
        }
        return;
      }

      const insp = await inspectBox(box.id);
      if (insp.state === 'paused') {
        log.info('box is paused; unpausing');
        await unpauseBox(box.id);
      } else if (insp.state === 'stopped') {
        log.info('box is stopped; starting');
        await startBox(box.id);
      } else if (insp.state === 'missing') {
        throw new Error(`box ${box.name} has no container; was it destroyed?`);
      }

      if (parsed.direction === 'upload') {
        const result = await uploadToBox(box, parsed.hostSrcs!, parsed.boxDst!, tarPatterns);
        if (result.warn) {
          log.warn(`copied to ${box.name}:${result.finalPath}, but ${result.warn}`);
        } else {
          process.stdout.write(`copied to ${box.name}:${result.finalPath}\n`);
        }
      } else {
        // Download: default dst to cwd (POSIX `cp` convention).
        const result = await downloadFromBox(
          box,
          parsed.boxSrcs!,
          parsed.hostDst ?? process.cwd(),
          tarPatterns,
        );
        process.stdout.write(`copied to ${result.finalPath}\n`);
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });
