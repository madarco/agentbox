/**
 * Swap for VPS boxes (hetzner, digitalocean) and their control-box deploys.
 *
 * The stock Ubuntu images these providers boot carry no swap, and the default
 * `cx23` (3.8 GB) OOM-kills Claude within minutes once it runs subagents. The
 * swapfile is made at BOOT by cloud-init, not baked into the snapshot: a baked
 * file would inflate every base snapshot and checkpoint by its full size, could
 * not be sized to the server it lands on, and boxes made from an older snapshot
 * would never get it. cloud-init runs `runcmd` once per instance (every create,
 * including a checkpoint restore); the `/etc/fstab` line carries it across
 * stop/start and reboots. The script is idempotent, so a checkpoint that already
 * holds `/swapfile` just re-activates it.
 *
 * Everything emitted here stays ASCII: DigitalOcean truncates user-data at the
 * first non-ASCII byte.
 */

export const SWAP_SCRIPT_PATH = '/usr/local/sbin/agentbox-swap';

/** `auto`, `off`, or an explicit size in MiB. */
export type SwapSpec = 'auto' | 'off' | { mib: number };

/**
 * Parse a `box.swap` value: `auto` (default; empty means auto), `off`, or a
 * size like `4G` / `2048M` (a bare number is GiB). Throws on anything else so a
 * typo surfaces at create instead of silently giving a box no swap.
 */
export function parseSwapSpec(raw: string | undefined): SwapSpec {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'auto' || value === 'on') return 'auto';
  if (value === 'off' || value === 'none' || value === '0') return 'off';
  const m = /^(\d+)\s*([mg])?i?b?$/.exec(value);
  if (m) {
    const n = Number(m[1]);
    const mib = m[2] === 'm' ? n : n * 1024;
    if (mib >= 256 && mib <= 64 * 1024) return { mib };
  }
  throw new Error(
    `invalid box.swap '${raw}': use auto, off, or a size between 256M and 64G (e.g. 4G, 2048M)`,
  );
}

/** The script argument for a spec: `auto`, `off` or a MiB count. */
export function swapSpecArg(spec: SwapSpec): string {
  return typeof spec === 'string' ? spec : String(spec.mib);
}

/**
 * The in-box swap script (POSIX sh, run as root). Usage: `agentbox-swap
 * auto|off|<MiB>`.
 *
 * - `auto`: min(RAM, 8 GiB), at least 2 GiB, and never more than a quarter of
 *   the free space on `/`. An existing `/swapfile` (a checkpoint restore) is
 *   reused whatever its size.
 * - `<MiB>`: that size, recreating `/swapfile` if it differs; still refused if it
 *   would leave less than 2 GiB free on `/`.
 * - `off`: removes the agentbox swapfile and its fstab line (a checkpoint taken
 *   with swap on carries both).
 *
 * Swap the machine already has from elsewhere (a provider image that ships it)
 * is left alone and suppresses ours. `vm.swappiness=10` keeps the agent's
 * working set in RAM and uses swap as overflow, not as a cache.
 */
export function swapScript(): string {
  return `#!/bin/sh
# agentbox-swap: create/activate (or remove) the box swapfile. Idempotent.
set -u
MODE="\${1:-auto}"
# The AGENTBOX_SWAP_* overrides only exist so the script can be exercised off a
# real VPS (unit test, container).
F="\${AGENTBOX_SWAP_FILE:-/swapfile}"
FSTAB="\${AGENTBOX_SWAP_FSTAB:-/etc/fstab}"
SYSCTL_CONF="\${AGENTBOX_SWAP_SYSCTL_CONF:-/etc/sysctl.d/99-agentbox-swap.conf}"
FSTAB_LINE="$F none swap sw 0 0"
log() { echo "agentbox-swap: $*"; }

active() { swapon --show=NAME --noheadings 2>/dev/null | grep -qx "$F"; }

if [ "$MODE" = off ]; then
  if active; then swapoff "$F" || true; fi
  if grep -q "^$F " "$FSTAB" 2>/dev/null; then
    sed -i "\\\\#^$F #d" "$FSTAB"
  fi
  rm -f "$F" "$SYSCTL_CONF"
  log "off"
  exit 0
fi

echo 'vm.swappiness=10' > "$SYSCTL_CONF"
sysctl -q -w vm.swappiness=10 >/dev/null 2>&1 || true

# Swap from somewhere else (not our file): respect it, add nothing.
OTHER=$(swapon --show=NAME --noheadings 2>/dev/null | grep -vx "$F" | head -n 1)
if [ -n "$OTHER" ] && ! active; then
  log "existing swap $OTHER, not adding $F"
  exit 0
fi

MEM_MIB=$(awk '/^MemTotal:/ {print int($2 / 1024)}' /proc/meminfo)
if [ "$MODE" = auto ]; then
  WANT=$MEM_MIB
  [ "$WANT" -gt 8192 ] && WANT=8192
  [ "$WANT" -lt 2048 ] && WANT=2048
else
  WANT=$MODE
fi

HAVE=0
[ -f "$F" ] && HAVE=$(( $(stat -c %s "$F") / 1048576 ))

if [ "$HAVE" -gt 0 ] && { [ "$MODE" = auto ] || [ "$HAVE" -eq "$WANT" ]; }; then
  if ! active; then
    if ! swapon "$F" 2>/dev/null; then
      mkswap "$F" >/dev/null && swapon "$F" || { log "cannot activate $F"; exit 1; }
    fi
  fi
else
  # Decide before tearing anything down, so a refused resize keeps the old swap.
  # The current file's space counts as free: it is about to be replaced.
  AVAIL_MIB=$(( $(df -Pm "$(dirname "$F")" | awk 'NR == 2 {print $4}') + HAVE ))
  if [ "$MODE" = auto ]; then
    CAP=$(( AVAIL_MIB / 4 ))
    [ "$WANT" -gt "$CAP" ] && WANT=$CAP
  elif [ $(( AVAIL_MIB - WANT )) -lt 2048 ]; then
    log "$WANT MiB would leave under 2 GiB free on $(dirname "$F"), skipping"
    exit 1
  fi
  if [ "$WANT" -lt 256 ]; then
    log "not enough free disk for swap (\${AVAIL_MIB} MiB free)"
    exit 0
  fi
  if active; then swapoff "$F" || { log "cannot swapoff $F to resize"; exit 1; }; fi
  rm -f "$F"
  # fallocate is instant; dd covers filesystems where swapon rejects a
  # fallocated (unwritten-extent) file.
  fallocate -l "\${WANT}M" "$F" 2>/dev/null || dd if=/dev/zero of="$F" bs=1M count="$WANT" status=none
  chmod 600 "$F"
  mkswap "$F" >/dev/null || { rm -f "$F"; log "mkswap failed"; exit 1; }
  if ! swapon "$F" 2>/dev/null; then
    rm -f "$F"
    dd if=/dev/zero of="$F" bs=1M count="$WANT" status=none
    chmod 600 "$F"
    mkswap "$F" >/dev/null && swapon "$F" || { rm -f "$F"; log "swapon failed"; exit 1; }
  fi
fi

grep -q "^$F " "$FSTAB" 2>/dev/null || echo "$FSTAB_LINE" >> "$FSTAB"
log "$(( $(stat -c %s "$F") / 1048576 )) MiB on $F"
`;
}

/**
 * cloud-config fragments that install and run the swap script: a `write_files`
 * entry (indented for a `write_files:` list) and a `runcmd` entry. The caller
 * splices them into its hand-rolled cloud-config, `runcmd` first in the list so
 * the swap is there before anything memory-hungry (a control box's docker
 * build) starts.
 */
export function swapCloudInit(spec: SwapSpec): { writeFile: string[]; runcmd: string[] } {
  const body = swapScript()
    .split('\n')
    .map((l) => (l.length > 0 ? `      ${l}` : ''));
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return {
    writeFile: [
      `  - path: ${SWAP_SCRIPT_PATH}`,
      '    permissions: "0755"',
      '    content: |',
      ...body,
    ],
    // `|| true`: swap is an optimization; a failure must not mark the boot failed.
    runcmd: [`  - [ sh, -c, "${SWAP_SCRIPT_PATH} ${swapSpecArg(spec)} || true" ]`],
  };
}
