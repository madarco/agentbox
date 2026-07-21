import { Command } from 'commander';
import { stat } from 'node:fs/promises';
import { ConfigError, loadConfig } from '../config.js';
import { DEFAULT_CONFIG_PATH } from '../types.js';

export const validateCommand = new Command('validate')
  .description('Check agentbox.yaml for syntax and shape errors, without starting the daemon')
  .argument('[path]', 'path to agentbox.yaml', DEFAULT_CONFIG_PATH)
  .action(async (path: string) => {
    try {
      await stat(path);
    } catch {
      process.stderr.write(`agentbox-ctl: ${path} not found\n`);
      process.exit(2);
    }
    try {
      const cfg = await loadConfig(path);
      // Unknown keys are reported but don't fail the check: this yaml may have
      // been written by a newer agentbox than the one baked into this box.
      for (const w of cfg.warnings) process.stderr.write(`warning: ${w}\n`);
      process.stdout.write(`OK: ${String(cfg.services.length)} service(s)\n`);
    } catch (err) {
      if (err instanceof ConfigError) {
        process.stderr.write(`${err.message}\n`);
        process.exit(2);
      }
      throw err;
    }
  });
