import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Use the CLI shipped with the same native engine as the installed SDK. */
export function smolCli(): { bin: string; env: Record<string, string> } {
  const sdkRequire = createRequire(createRequire(import.meta.url).resolve('smolmachines'));
  const packageName =
    process.platform === 'darwin'
      ? 'smolmachines-darwin-universal'
      : process.platform === 'win32'
        ? 'smolmachines-win32-x64-msvc'
        : process.arch === 'arm64'
          ? 'smolmachines-linux-arm64-gnu'
          : 'smolmachines-linux-x64-gnu';
  const nativeDir = join(dirname(sdkRequire.resolve(`${packageName}/package.json`)), 'native');
  const bin =
    process.env.SMOLVM_BOOT_BINARY ??
    join(nativeDir, process.platform === 'win32' ? 'smol-vmm.exe' : 'smol-vmm');
  return {
    bin,
    env: {
      SMOLVM_LIB_DIR: process.env.SMOLVM_LIB_DIR ?? nativeDir,
      SMOLVM_BOOT_BINARY: bin,
      SMOLVM_AGENT_ROOTFS_TAR:
        process.env.SMOLVM_AGENT_ROOTFS_TAR ?? join(nativeDir, 'agent-rootfs.tar'),
    },
  };
}

export async function runSmolCli(args: string[]): Promise<void> {
  const cli = smolCli();
  await execFileAsync(cli.bin, args, {
    env: { ...process.env, ...cli.env },
    timeout: 30 * 60_000,
  });
}
