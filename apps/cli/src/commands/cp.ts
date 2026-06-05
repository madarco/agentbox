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
 * act on. Returns the tar `--exclude` patterns to apply to the copy.
 */
async function guardUploadSize(
  hostSrc: string,
  boxDst: string,
  opts: CpOptions,
): Promise<string[]> {
  const tokens = effectiveExcludes(opts.exclude, opts.defaultExcludes);
  const tarPatterns = toTarExcludes(tokens);

  const cfg = await loadEffectiveConfig(process.cwd());
  const maxBytes = cfg.effective.box.cpMaxBytes;

  const absSrc = resolve(hostSrc);
  const measured = await measureCopy(absSrc, tokens);
  if (!measured.isDir || opts.yes || measured.totalBytes <= maxBytes) {
    return tarPatterns;
  }

  const dropped = opts.defaultExcludes
    ? ` after default excludes (${effectiveExcludes([], true).join(', ')})`
    : '';
  const lines: string[] = [
    `${hostSrc} is ${fmtBytes(measured.totalBytes)}${dropped}, over the ${fmtBytes(maxBytes)} per-copy limit.`,
    'Biggest remaining folders/subfolders:',
    ...measured.treeLines,
    'Each copy must be under the limit. To proceed, EITHER:',
    '  - copy the heavy folders one at a time, e.g.:',
  ];
  for (const child of measured.topChildren.slice(0, 3)) {
    lines.push(`      agentbox cp ${hostSrc}/${child.path} ${boxDst}`);
  }
  lines.push(
    '  - or drop what you do not need:',
    `      agentbox cp ${hostSrc} ${boxDst} --exclude=<dir>`,
    '  - or copy the whole thing anyway:',
    `      agentbox cp ${hostSrc} ${boxDst} --yes`,
  );
  throw new Error(lines.join('\n'));
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
  boxPath: string;
  hostPath: string | undefined; // undefined only on download with no dst (= cwd)
}

function parseArgs(src: string, dst: string | undefined): Parsed {
  const srcBox = parseBoxArg(src);
  const dstBox = dst === undefined ? null : parseBoxArg(dst);

  if (srcBox && dstBox) {
    throw new Error(
      'box-to-box copy is not supported; both arguments look like box paths (`name:/path`).',
    );
  }
  if (!srcBox && !dstBox) {
    throw new Error(
      'one argument must be a box path of the form `<box>:/path` (e.g. `mybox:/workspace/foo`).',
    );
  }
  if (srcBox) {
    return {
      direction: 'download',
      boxRef: srcBox.boxRef,
      boxPath: srcBox.path,
      hostPath: dst,
    };
  }
  if (dst === undefined) {
    throw new Error('host -> box copy requires a destination, e.g. `agentbox cp ./foo box:/dst`.');
  }
  return {
    direction: 'upload',
    boxRef: dstBox!.boxRef,
    boxPath: dstBox!.path,
    hostPath: src,
  };
}

export const cpCommand = new Command('cp')
  .description('Copy files between host and box (like `docker cp`; direction picked by `name:` prefix)')
  .argument('<src>', '`box:/path` (download) or host path (upload)')
  .argument(
    '[dst]',
    '`box:/path` (upload) or host path (download); defaults to cwd when downloading',
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
  .option('-y, --yes', 'copy even if the source is over the box.cpMaxBytes size limit')
  .addHelpText(
    'after',
    [
      '',
      'Examples:',
      '  agentbox cp mybox:/etc/foo ./foo            # download (host path optional)',
      '  agentbox cp mybox:/workspace/.env           # download into cwd',
      '  agentbox cp ./local.txt mybox:/workspace/   # upload (host path required)',
      '  agentbox cp ./dir mybox:/workspace/         # upload directory (recursive)',
      '  agentbox cp ./dir mybox:/workspace/ --exclude=.git --exclude="*/cache"',
    ].join('\n'),
  )
  .action(async (src: string, dst: string | undefined, opts: CpOptions) => {
    try {
      const parsed = parseArgs(src, dst);
      const box = await resolveBoxOrExit(parsed.boxRef);
      const isCloud = (box.provider ?? 'docker') !== 'docker';

      // Excludes apply to both directions; the size guard only gates uploads
      // (we know the host source's size cheaply; a box-side dir we don't).
      const tarPatterns =
        parsed.direction === 'upload'
          ? await guardUploadSize(parsed.hostPath!, `${parsed.boxRef}:${parsed.boxPath}`, opts)
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
          const result = await provider.uploadPath(box, parsed.hostPath!, parsed.boxPath, tarPatterns);
          process.stdout.write(`copied to ${box.name}:${result.finalPath}\n`);
        } else {
          const result = await provider.downloadPath(
            box,
            parsed.boxPath,
            parsed.hostPath ?? process.cwd(),
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
        const result = await uploadToBox(box, parsed.hostPath!, parsed.boxPath, tarPatterns);
        if (result.warn) {
          log.warn(`copied to ${box.name}:${result.finalPath}, but ${result.warn}`);
        } else {
          process.stdout.write(`copied to ${box.name}:${result.finalPath}\n`);
        }
      } else {
        // Download: default dst to cwd (POSIX `cp` convention).
        const result = await downloadFromBox(
          box,
          parsed.boxPath,
          parsed.hostPath ?? process.cwd(),
          tarPatterns,
        );
        process.stdout.write(`copied to ${result.finalPath}\n`);
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });
