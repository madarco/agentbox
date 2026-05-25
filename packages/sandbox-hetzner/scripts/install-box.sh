#!/usr/bin/env bash
# AgentBox Hetzner base-image installer.
#
# Idempotent shell-script mirror of `packages/sandbox-docker/Dockerfile.box`,
# run once on a freshly-booted Ubuntu 24.04 VPS during
# `agentbox prepare --provider hetzner`. After this script completes we
# `create_image` the VPS — that snapshot is what every per-box create boots
# from.
#
# Required inputs (already in place when this script runs):
#   /tmp/agentbox-ctl                  -- prebuilt @agentbox/ctl bundle (cjs)
#   /tmp/agentbox-vnc-start            -- VNC startup helper
#   /tmp/agentbox-dockerd-start        -- DinD startup helper
#   /tmp/agentbox-checkpoint-cleanup   -- pre-snapshot cleanup helper
#   /tmp/agentbox-open                 -- in-box xdg-open shim
#   /tmp/agentbox-custom-CLAUDE.md     -- /etc/claude-code/CLAUDE.md content
#   /tmp/agentbox-managed-settings.json -- /etc/claude-code/managed-settings.json
#   /tmp/agentbox-codex-hooks.json     -- /usr/local/share/agentbox/codex-hooks.json
#   /tmp/agentbox-setup-skill.md       -- /usr/local/share/agentbox/setup-guide.md
#
# Output: noisy progress to stdout (the host streams it into
# ~/.agentbox/logs/prepare.log via the ssh exec). Each major step prints
# `>>> BEGIN <step>` and `<<< END <step>` so a tail-watcher can spot a hang.

set -euo pipefail

step() { printf '\n>>> BEGIN %s\n' "$1"; }
done_() { printf '<<< END %s\n' "$1"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "install-box.sh: must run as root (got uid $(id -u))" >&2
  exit 64
fi

export DEBIAN_FRONTEND=noninteractive

step "wait for cloud-init"
# sshd is up via cloud-init's `users:` module before all of cloud-init's
# modules finish. Without this wait, our own `apt-get update` can race
# against cloud-init's apt operations (unattended-upgrades, etc.) and fail
# with "Could not get lock /var/lib/dpkg/lock-frontend".
cloud-init status --wait || true
done_ "wait for cloud-init"

step "apt update + base packages"
apt-get update
apt-get install -y --no-install-recommends \
  curl ca-certificates gnupg
done_ "apt update + base packages"

step "Node 24 via NodeSource"
if ! command -v node >/dev/null 2>&1 || ! node --version | grep -qE '^v24\.'; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
fi
done_ "Node 24 via NodeSource"

step "core runtime + tooling"
apt-get install -y --no-install-recommends \
  fuse3 \
  fuse-overlayfs \
  rsync \
  nodejs \
  python3 \
  python3-pip \
  python3-venv \
  build-essential \
  git \
  tmux \
  vim \
  libcap2-bin \
  sudo \
  locales \
  bash-completion
# devcontainers/base bakes en_US.UTF-8; on plain Ubuntu we have to generate it
# ourselves so /etc/profile.d/agentbox.sh's LANG export doesn't surface a
# locale warning.
locale-gen en_US.UTF-8 >/dev/null 2>&1 || true
update-locale LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 >/dev/null 2>&1 || true
done_ "core runtime + tooling"

step "vscode user (UID 1000) + sudoers"
# The devcontainers base image creates `vscode` for us; on plain Ubuntu we
# do it ourselves. UID 1000 matches the docker provider so any path that
# bakes in /home/vscode (agentbox-ctl, /etc/profile.d/agentbox.sh, the
# credential symlinks, the in-box configs) Just Works regardless of provider.
if ! id vscode >/dev/null 2>&1; then
  # Hetzner's stock images already create a sequenced UID 1000 user named
  # `debian` / `ubuntu` depending on the distro stage. If something owns UID
  # 1000 already, rename that account to `vscode` instead of failing — keeps
  # any cloud-init-deposited files (authorized_keys) discoverable under the
  # new home.
  if existing="$(getent passwd 1000 | cut -d: -f1)"; then
    if [ -n "$existing" ] && [ "$existing" != "vscode" ]; then
      usermod -l vscode "$existing"
      usermod -d /home/vscode -m vscode || true
      groupmod -n vscode "$existing" 2>/dev/null || true
    fi
  fi
  if ! id vscode >/dev/null 2>&1; then
    useradd -m -u 1000 -s /bin/bash vscode
  fi
fi
install -d -m 0755 -o vscode -g vscode /home/vscode
echo 'vscode ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/90-agentbox-vscode
chmod 0440 /etc/sudoers.d/90-agentbox-vscode
done_ "vscode user (UID 1000) + sudoers"

step "agentbox base dirs + /workspace ownership"
mkdir -p /workspace /run/agentbox /var/log/agentbox /etc/agentbox /etc/claude-code \
         /usr/local/share/agentbox
chmod 755 /workspace
chown vscode:vscode /workspace /run/agentbox /var/log/agentbox
done_ "agentbox base dirs + /workspace ownership"

step "node setcap (port <1024 bind without root)"
NODE_BIN="$(readlink -f "$(command -v node)")"
setcap cap_net_bind_service=+ep "$NODE_BIN"
done_ "node setcap (port <1024 bind without root)"

step "corepack (pnpm + yarn shims)"
npm install -g corepack@latest
corepack enable pnpm yarn
done_ "corepack (pnpm + yarn shims)"

step "corepack cache dir (vscode-owned, prevents first-use ENOENT)"
sudo -u vscode -H mkdir -p /home/vscode/.cache/node/corepack
done_ "corepack cache dir (vscode-owned, prevents first-use ENOENT)"

step "git system-wide safe.directory"
git config --system --add safe.directory '*'
done_ "git system-wide safe.directory"

step "docker + iptables for in-VPS DinD"
apt-get install -y --no-install-recommends \
  docker.io \
  iptables
mkdir -p /etc/docker
printf '%s\n' '{ "iptables": true }' > /etc/docker/daemon.json
usermod -aG docker vscode
# In-VPS dockerd is launched by the cloud-provider scaffolding via
# `agentbox-dockerd-start` (the same script the docker provider uses), so the
# systemd `docker.service` shouldn't auto-start — we want the agentbox
# helper's storage-driver-probe + flag composition, not Ubuntu's defaults.
systemctl disable --now docker.service 2>/dev/null || true
systemctl disable --now docker.socket  2>/dev/null || true
done_ "docker + iptables for in-VPS DinD"

step "agentbox-ctl install"
install -m 0755 /tmp/agentbox-ctl /usr/local/bin/agentbox-ctl
done_ "agentbox-ctl install"

# === EARLY BAKE: helper scripts, baked configs, profile/sshd shims ===
# Originally these steps lived after Chromium download (which takes ~5min).
# We moved them up because — for reasons that didn't fully resolve in
# diagnostic runs — bash's set -x trace, the pipe-tee log capture, and any
# subsequent file system writes from this script silently stop emitting
# output after the long-running `playwright install chromium` exec, leaving
# the snapshot missing every file these steps would install. Running them
# *before* Chromium sidesteps the issue and keeps the snapshot complete.
# Tracked as Phase-7 follow-up in docs/hertzner_backlog.md.

step "baked helper scripts (vnc / dockerd / cleanup / xdg-open shim)"
install -m 0755 /tmp/agentbox-vnc-start          /usr/local/bin/agentbox-vnc-start
install -m 0755 /tmp/agentbox-dockerd-start      /usr/local/bin/agentbox-dockerd-start
install -m 0755 /tmp/agentbox-checkpoint-cleanup /usr/local/bin/agentbox-checkpoint-cleanup
install -m 0755 /tmp/agentbox-open               /usr/local/bin/agentbox-open
ln -sf /usr/local/bin/agentbox-open /usr/local/bin/xdg-open
done_ "baked helper scripts (vnc / dockerd / cleanup / xdg-open shim)"

step "baked config files (claude / codex / setup guide / tmux.conf)"
install -m 0644 /tmp/agentbox-custom-CLAUDE.md      /etc/claude-code/CLAUDE.md
install -m 0644 /tmp/agentbox-managed-settings.json /etc/claude-code/managed-settings.json
install -m 0644 /tmp/agentbox-codex-hooks.json      /usr/local/share/agentbox/codex-hooks.json
install -m 0644 /tmp/agentbox-setup-skill.md        /usr/local/share/agentbox/setup-guide.md

# tmux.conf — verbatim from Dockerfile.box.
cat > /etc/tmux.conf <<'TMUX'
set -g default-terminal "tmux-256color"
set -as terminal-overrides ",*:Tc"
set -as terminal-overrides ",*:RGB"
set -as terminal-features ",*:hyperlinks"
set -as terminal-features ",*:RGB"
set -g allow-passthrough on
set -g set-clipboard on
set -g extended-keys on
set -as terminal-features ",*:extkeys"
set -g mouse on
bind -T copy-mode    WheelUpPane   send -N2 -X scroll-up
bind -T copy-mode    WheelDownPane send -N2 -X scroll-down
bind -T copy-mode-vi WheelUpPane   send -N2 -X scroll-up
bind -T copy-mode-vi WheelDownPane send -N2 -X scroll-down
set -g history-limit 50000
set -g escape-time 0
TMUX
done_ "baked config files (claude / codex / setup guide / tmux.conf)"

step "credential pivot symlinks (vscode home)"
sudo -u vscode -H mkdir -p \
  /home/vscode/.claude \
  /home/vscode/.claude/skills/agentbox-setup \
  /home/vscode/.codex \
  /home/vscode/.local/share/opencode \
  /home/vscode/.agentbox-creds/claude \
  /home/vscode/.agentbox-creds/codex \
  /home/vscode/.agentbox-creds/opencode
sudo -u vscode -H ln -sf /home/vscode/.agentbox-creds/claude/.credentials.json \
  /home/vscode/.claude/.credentials.json
sudo -u vscode -H ln -sf /home/vscode/.agentbox-creds/codex/auth.json \
  /home/vscode/.codex/auth.json
sudo -u vscode -H ln -sf /home/vscode/.agentbox-creds/opencode/auth.json \
  /home/vscode/.local/share/opencode/auth.json
sudo -u vscode -H ln -sf /home/vscode/.claude/_claude.json /home/vscode/.claude.json

# `/agentbox-setup` skill — the in-box-only first-run wizard the setup
# prompt references. Docker's seedSetupSkillIntoVolume() (sandbox-docker/
# src/claude.ts) does this at create time via a helper container with the
# claude-config volume mounted. Hetzner doesn't have a shared volume — we
# bake it directly into the snapshot here so every box has it. The same
# content is also reachable as a static file at /usr/local/share/agentbox/
# setup-guide.md (referenced as fallback in the wizard initial prompt).
# `tar -xzf` of the host's ~/.claude in prepareHetzner extracts WITHOUT
# removing pre-existing files in the dest, so this skill survives the
# subsequent static-config bake.
sudo -u vscode -H cp /usr/local/share/agentbox/setup-guide.md \
  /home/vscode/.claude/skills/agentbox-setup/SKILL.md
done_ "credential pivot symlinks (vscode home)"

step "login-shell shim (/etc/profile.d/agentbox.sh)"
cat > /etc/profile.d/agentbox.sh <<'PROFILE'
# Auto-loaded by login shells; box.env is written at create time.
if [ -r /etc/agentbox/box.env ]; then
  set -a
  . /etc/agentbox/box.env
  set +a
fi
case ":$PATH:" in
  *:/home/vscode/.local/bin:*) : ;;
  *) PATH=/home/vscode/.local/bin:$PATH ;;
esac
export PATH
export COLORTERM=${COLORTERM:-truecolor}
export DISABLE_AUTOUPDATER=${DISABLE_AUTOUPDATER:-1}
export LANG=${LANG:-en_US.UTF-8}
export LC_ALL=${LC_ALL:-en_US.UTF-8}
export DISPLAY=${DISPLAY:-:1}
export AGENT_BROWSER_EXECUTABLE_PATH=${AGENT_BROWSER_EXECUTABLE_PATH:-/usr/local/bin/chromium}
export BROWSER=${BROWSER:-/usr/local/bin/agentbox-open}
PROFILE
chmod 0644 /etc/profile.d/agentbox.sh
done_ "login-shell shim (/etc/profile.d/agentbox.sh)"

step "sshd hardening drop-in"
cat > /etc/ssh/sshd_config.d/agentbox.conf <<'SSHD'
# Written by AgentBox install-box.sh — see plan §"safety model".
PasswordAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
AllowUsers vscode
AllowTcpForwarding yes
GatewayPorts no
PermitTunnel no
X11Forwarding no
ChallengeResponseAuthentication no
KbdInteractiveAuthentication no
SSHD
# Don't reload sshd here — we still need root SSH for the rest of the
# install. The drop-in takes effect on next sshd restart (the snapshot will
# include it; the next boot reads it).
done_ "sshd hardening drop-in"

step "allow unprivileged user namespaces (sysctl drop-in)"
# Ubuntu 23.10+ / 24.04 enables an AppArmor knob that blocks unprivileged
# user namespaces, which Chromium's sandbox needs. Without this, every
# in-box `chromium` / `agent-browser` invocation dies with
# "FATAL: zygote_host_impl_linux.cc: No usable sandbox!". Docker boxes
# don't hit it because the host kernel running their containers is older
# (or they get the relaxed sysctl from the docker host). On a bare Ubuntu
# 24.04 Hetzner VPS we have to flip it ourselves.
#
# We flip both the modern knob (`apparmor_restrict_unprivileged_userns`)
# and the legacy `unprivileged_userns_clone` — the legacy one is already
# 1 on 24.04 but writing it costs nothing and keeps the drop-in valid if
# a future kernel hardens the default back to 0.
cat > /etc/sysctl.d/99-agentbox-userns.conf <<'SYSCTL'
# Written by AgentBox install-box.sh — Chromium needs unprivileged user
# namespaces for its sandbox; the VPS itself is the isolation boundary.
kernel.apparmor_restrict_unprivileged_userns = 0
kernel.unprivileged_userns_clone = 1
SYSCTL
chmod 0644 /etc/sysctl.d/99-agentbox-userns.conf
# Apply now too so the rest of this install (in particular `playwright
# install chromium`'s post-install probe) works without needing a reboot
# of the prepare VPS. The drop-in then re-applies on every boot of the
# baked snapshot.
sysctl -p /etc/sysctl.d/99-agentbox-userns.conf >/dev/null
done_ "allow unprivileged user namespaces (sysctl drop-in)"

# === END EARLY BAKE ===

step "VNC stack (TigerVNC + noVNC + websockify + autocutsel)"
apt-get install -y --no-install-recommends \
  tigervnc-standalone-server tigervnc-common tigervnc-tools \
  novnc websockify \
  autocutsel xclip
mkdir -p /home/vscode/.vnc
chown -R vscode:vscode /home/vscode/.vnc
done_ "VNC stack (TigerVNC + noVNC + websockify + autocutsel)"

step "Chrome runtime libs"
apt-get install -y --no-install-recommends \
  libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libdrm2 libpango-1.0-0 libcairo2 libasound2t64 \
  fonts-liberation xdg-utils
done_ "Chrome runtime libs"

step "agent-browser + playwright + portless (global npm)"
npm install -g agent-browser playwright portless
done_ "agent-browser + playwright + portless (global npm)"

step "Codex CLI prereqs (bubblewrap) + agent installs"
apt-get install -y --no-install-recommends bubblewrap
npm install -g @openai/codex opencode-ai
done_ "Codex CLI prereqs (bubblewrap) + agent installs"

step "Claude Code (native installer, run as vscode)"
# Anthropic's native installer drops `claude` at /home/vscode/.local/bin/.
# Run as vscode so the binary lands in the right home and is owned by the
# user that'll execute it. DISABLE_AUTOUPDATER is set globally via
# /etc/profile.d/agentbox.sh below.
sudo -u vscode -H bash -lc 'curl -fsSL https://claude.ai/install.sh | bash -s stable'
done_ "Claude Code (native installer, run as vscode)"

step "Chromium download via Playwright (as vscode)"
# Run the download as vscode so the cache lands under
# /home/vscode/.cache/ms-playwright. Resolve a stable symlink at
# /usr/local/bin/chromium so AGENT_BROWSER_EXECUTABLE_PATH stays predictable
# across Chromium revision bumps.
sudo -u vscode -H bash -lc 'playwright install chromium'
CHROME_BIN="$(sudo -u vscode -H bash -lc 'ls /home/vscode/.cache/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | sort | tail -1')"
if [ -z "$CHROME_BIN" ] || [ ! -x "$CHROME_BIN" ]; then
  echo "install-box.sh: could not resolve Playwright Chromium binary" >&2
  exit 70
fi
ln -sf "$CHROME_BIN" /usr/local/bin/chromium
done_ "Chromium download via Playwright (as vscode)"

step "apt cleanup"
apt-get clean
rm -rf /var/lib/apt/lists/*
done_ "apt cleanup"

step "trim /tmp/agentbox-*"
# Keep the install script itself out of the trim list — it's referenced by
# the install log saved into the snapshot so a Phase-7-style diagnostic can
# re-read which lines actually executed against which source.
rm -f /tmp/agentbox-ctl /tmp/agentbox-vnc-start /tmp/agentbox-dockerd-start \
      /tmp/agentbox-checkpoint-cleanup /tmp/agentbox-open \
      /tmp/agentbox-custom-CLAUDE.md /tmp/agentbox-managed-settings.json \
      /tmp/agentbox-codex-hooks.json /tmp/agentbox-setup-skill.md
# Move install-box.sh into the persistent location for diagnostics.
mv /tmp/agentbox-install.sh /var/log/agentbox/install-box.sh 2>/dev/null || true
done_ "trim /tmp/agentbox-*"

printf '\n*** install-box.sh: complete — VPS ready for create_image snapshot.\n'
