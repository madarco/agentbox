/**
 * Where a one-shot `docker …` runs. The default is this machine's docker CLI;
 * a hub with no docker of its own (a control box, whose hub runs in a
 * container) passes one that reaches its engine over remote-docker's ssh
 * chokepoint instead. Only the helpers a hub-driven sign-in calls take it.
 */
import { execa } from 'execa';

export interface DockerRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DockerRunOptions {
  /** Written to docker's stdin (for `run -i`). */
  input?: string;
  timeoutMs?: number;
}

/** Run `docker <argv…>`; never throws on a non-zero exit (like execa `reject: false`). */
export type DockerRun = (argv: string[], opts?: DockerRunOptions) => Promise<DockerRunResult>;

export const localDockerRun: DockerRun = async (argv, opts = {}) => {
  const r = await execa('docker', argv, {
    reject: false,
    ...(opts.input !== undefined ? { input: opts.input } : {}),
    ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
  });
  return {
    exitCode: typeof r.exitCode === 'number' ? r.exitCode : 1,
    stdout: typeof r.stdout === 'string' ? r.stdout : '',
    stderr: typeof r.stderr === 'string' ? r.stderr : '',
  };
};
