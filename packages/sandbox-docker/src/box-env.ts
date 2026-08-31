import { execa } from 'execa';

/**
 * Writes /etc/agentbox/box.env inside the container as a POSIX-sourceable
 * key='value' file. Paired with /etc/profile.d/agentbox.sh (baked in the
 * image), which `set -a; . /etc/agentbox/box.env; set +a`s it on login.
 *
 * Best-effort: failure is logged by the caller; an unwritable file just
 * means interactive shells lose the AGENTBOX_* vars (the env vars baked
 * into docker run still survive).
 */
export async function writeBoxEnvFile(
  container: string,
  env: Record<string, string>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const body = formatBoxEnvBody(env);
  const result = await execa(
    'docker',
    [
      'exec',
      '--user',
      'root',
      '-i',
      container,
      'sh',
      '-c',
      'umask 022 && cat > /etc/agentbox/box.env',
    ],
    { input: body, reject: false },
  );
  if (result.exitCode !== 0) {
    return {
      ok: false,
      reason: `docker exec failed (exit ${String(result.exitCode)}): ${(result.stderr ?? '').toString().slice(0, 400)}`,
    };
  }
  return { ok: true };
}

// Single-quote each value and escape embedded single quotes as '\''. Avoids
// double-quoted form because `. ` would expand $foo / `cmd` at source time.
export function formatBoxEnvBody(env: Record<string, string>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    lines.push(`${k}=${shellSingleQuote(v)}`);
  }
  return lines.join('\n') + '\n';
}

function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
