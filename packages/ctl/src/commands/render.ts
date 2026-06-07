import { readFile, writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import { DEFAULT_CONFIG_PATH } from '../types.js';
import {
  applyReplacements,
  loadReplacementsSection,
  parseRuleArg,
  placeholderContextFromEnv,
  resolveRuleRefs,
  type ReplaceRule,
} from '../replace.js';

interface RenderOptions {
  out?: string;
  inPlace?: boolean;
  env?: boolean;
  rule: string[];
  ruleRegex: string[];
  rules?: string;
  config: string;
}

function collect(value: string, prev: string[]): string[] {
  prev.push(value);
  return prev;
}

export const renderCommand = new Command('render')
  .description(
    'Render a file by substituting {{AGENTBOX_*}} placeholders and/or applying ' +
      'replacement rules (a declarative alternative to sed).',
  )
  .argument('<src>', 'file to read')
  .option('--out <path>', 'write the result here (default: stdout)')
  .option('--in-place', 'overwrite <src> with the result')
  .option('--env', 'substitute {{AGENTBOX_*}} whitelist placeholders')
  .option('--rule <from=>to>', 'literal replacement (repeatable)', collect, [])
  .option('--rule-regex <pat=>repl>', 'regex replacement (repeatable)', collect, [])
  .option('--rules <names>', 'comma-separated replacements: rule-set names to apply')
  .option('--config <path>', 'agentbox.yaml to read replacements: from', DEFAULT_CONFIG_PATH)
  .action(async (src: string, opts: RenderOptions) => {
    const content = await readFile(src, 'utf8');

    const rules: ReplaceRule[] = [];
    if (opts.rules) {
      const refs = opts.rules
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (refs.length > 0) {
        const replacements = await loadReplacementsSection(opts.config);
        rules.push(...resolveRuleRefs(refs, replacements, '--rules'));
      }
    }
    for (const arg of opts.rule) rules.push(parseRuleArg(arg, false));
    for (const arg of opts.ruleRegex) rules.push(parseRuleArg(arg, true));

    const result = applyReplacements(content, {
      env: opts.env,
      rules,
      context: placeholderContextFromEnv(),
      onWarn: (msg) => process.stderr.write(`agentbox-ctl render: ${msg}\n`),
    });

    if (opts.inPlace) {
      await writeFile(src, result, 'utf8');
    } else if (opts.out) {
      await writeFile(opts.out, result, 'utf8');
    } else {
      process.stdout.write(result);
    }
  });
