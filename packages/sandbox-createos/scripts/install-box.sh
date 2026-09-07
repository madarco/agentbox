#!/usr/bin/env bash
# AgentBox CreateOS per-sandbox runtime installer.
#
# CreateOS currently boots a generic rootfs and does not have an AgentBox
# template bake path that can carry local runtime files. The provider uploads
# these files to /tmp and runs this script during each provision.

set -euo pipefail

step() { printf '\n>>> BEGIN %s\n' "$1"; }
done_() { printf '<<< END %s\n' "$1"; }

retry_backoff() {
  local max=$1; shift
  local attempt=1
  local -a waits=(60 240)
  while true; do
    if "$@"; then return 0; fi
    if [ "$attempt" -ge "$max" ]; then return 1; fi
    local w=${waits[$((attempt-1))]:-240}
    echo "retry_backoff: attempt ${attempt}/${max} failed; backing off ${w}s" >&2
    sleep "$w"
    attempt=$((attempt+1))
  done
}

npm_global() {
  npm --prefix /usr/local "$@"
}

if [ "$(id -u)" -ne 0 ]; then
  echo "install-box.sh: must run as root (got uid $(id -u))" >&2
  exit 64
fi

export DEBIAN_FRONTEND=noninteractive

step "hostname resolution"
if command -v hostname >/dev/null 2>&1; then
  hn="$(hostname)"
  if [ -n "$hn" ] && ! grep -qE "(^|[[:space:]])${hn}($|[[:space:]])" /etc/hosts 2>/dev/null; then
    printf '127.0.1.1 %s\n' "$hn" >> /etc/hosts
  fi
fi
done_ "hostname resolution"

step "apt base packages"
apt-get update -y -q
apt-get install -y -q --no-install-recommends \
  ca-certificates \
  git \
  git-lfs \
  tar \
  gzip \
  curl \
  wget \
  sudo \
  python3 \
  python3-pip \
  python3-venv \
  tmux \
  vim \
  libcap2-bin \
  rsync \
  xclip \
  autocutsel \
  locales \
  bash-completion
locale-gen en_US.UTF-8 >/dev/null 2>&1 || true
update-locale LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 >/dev/null 2>&1 || true
done_ "apt base packages"

step "node sanity"
node_major=0
node_path=""
node_path_resolved=""
if command -v node >/dev/null 2>&1; then
  node_path="$(command -v node)"
  node_path_resolved="$(readlink -f "$node_path" 2>/dev/null || printf '%s' "$node_path")"
  node_major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
fi
if [ "${node_major:-0}" -lt 20 ] || [[ "$node_path_resolved" == /root/* ]] || [ ! -x /usr/bin/node ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y -q --no-install-recommends nodejs
fi
if [ -x /usr/bin/node ]; then
  ln -sf /usr/bin/node /usr/local/bin/node
fi
if [ -x /usr/bin/npm ]; then
  ln -sf /usr/bin/npm /usr/local/bin/npm
fi
if [ -x /usr/bin/npx ]; then
  ln -sf /usr/bin/npx /usr/local/bin/npx
fi
hash -r
node --version
done_ "node sanity"

step "vscode user + sudoers"
if ! id vscode >/dev/null 2>&1; then
  useradd -m -s /bin/bash vscode
fi
install -d -m 0755 -o vscode -g vscode /home/vscode
echo 'vscode ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/90-agentbox-vscode
chmod 0440 /etc/sudoers.d/90-agentbox-vscode
visudo -cf /etc/sudoers >/dev/null
done_ "vscode user + sudoers"

step "agentbox base dirs + /workspace ownership"
mkdir -p /workspace /run/agentbox /var/log/agentbox /var/lib/agentbox /etc/agentbox /etc/claude-code \
         /usr/local/share/agentbox
chmod 755 /workspace
chown vscode:vscode /workspace /run/agentbox /var/log/agentbox /var/lib/agentbox
done_ "agentbox base dirs + /workspace ownership"

step "docker engine"
docker_packages=()
if ! command -v docker >/dev/null 2>&1; then
  docker_packages+=(docker.io)
fi
if ! docker compose version >/dev/null 2>&1; then
  docker_packages+=(docker-compose-v2)
fi
if ! docker buildx version >/dev/null 2>&1; then
  docker_packages+=(docker-buildx)
fi
if ! command -v fuse-overlayfs >/dev/null 2>&1; then
  docker_packages+=(fuse3 fuse-overlayfs)
fi
if ! command -v iptables >/dev/null 2>&1; then
  docker_packages+=(iptables)
fi
if [ "${#docker_packages[@]}" -gt 0 ]; then
  apt-get install -y -q --no-install-recommends "${docker_packages[@]}"
fi
groupadd -f docker
usermod -aG docker vscode
mkdir -p /etc/docker
printf '%s\n' '{ "iptables": true }' > /etc/docker/daemon.json
systemctl disable --now docker.service docker.socket 2>/dev/null || true
docker --version
docker compose version
docker buildx version
done_ "docker engine"

step "node setcap"
NODE_BIN="$(readlink -f "$(command -v node)")"
setcap cap_net_bind_service=+ep "$NODE_BIN" || echo "install-box.sh: setcap failed (continuing)"
done_ "node setcap"

step "corepack"
npm_global install -g --force corepack@latest 2>&1 | tail -2 || true
corepack enable pnpm yarn 2>/dev/null || true
sudo -u vscode -H mkdir -p /home/vscode/.cache/node/corepack
done_ "corepack"

step "git config"
git config --system --add safe.directory '*' 2>/dev/null || true
sudo -u vscode -H git config --global --add safe.directory '*' 2>/dev/null || true
git lfs install --system --skip-repo 2>/dev/null || true
sudo -u vscode -H git lfs install --skip-repo 2>/dev/null || true
done_ "git config"

step "agentbox-ctl install"
install -m 0755 /tmp/agentbox-ctl /usr/local/bin/agentbox-ctl
done_ "agentbox-ctl install"

step "helper scripts"
install -m 0755 /tmp/agentbox-vnc-start          /usr/local/bin/agentbox-vnc-start
install -m 0755 /tmp/agentbox-dockerd-start      /usr/local/bin/agentbox-dockerd-start
install -m 0755 /tmp/agentbox-portless-trust     /usr/local/bin/agentbox-portless-trust
install -m 0755 /tmp/agentbox-checkpoint-cleanup /usr/local/bin/agentbox-checkpoint-cleanup
install -m 0755 /tmp/agentbox-open               /usr/local/bin/agentbox-open
ln -sf /usr/local/bin/agentbox-open /usr/local/bin/xdg-open
done_ "helper scripts"

step "config files"
install -m 0644 /tmp/agentbox-custom-CLAUDE.md      /etc/claude-code/CLAUDE.md
install -m 0644 /tmp/agentbox-managed-settings.json /etc/claude-code/managed-settings.json
install -m 0644 /tmp/agentbox-codex-hooks.json      /usr/local/share/agentbox/codex-hooks.json
install -m 0644 /tmp/agentbox-setup-skill.md        /usr/local/share/agentbox/setup-guide.md
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
done_ "config files"

step "credential pivot symlinks"
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
sudo -u vscode -H cp /usr/local/share/agentbox/setup-guide.md \
  /home/vscode/.claude/skills/agentbox-setup/SKILL.md
done_ "credential pivot symlinks"

step "login-shell shim"
cat > /etc/profile.d/agentbox.sh <<'PROFILE'
if [ -r /etc/agentbox/box.env ]; then
  set -a
  . /etc/agentbox/box.env
  set +a
fi
case ":$PATH:" in
  *:/home/vscode/.local/bin:*) : ;;
  *) PATH=/home/vscode/.local/bin:$PATH ;;
esac
PATH=/usr/local/bin:$(printf '%s' "$PATH" | sed -e 's#:/usr/local/bin:#:#g' -e 's#^/usr/local/bin:##' -e 's#:/usr/local/bin$##' -e 's#^/usr/local/bin$##')
export PATH
export COLORTERM=${COLORTERM:-truecolor}
export DISABLE_AUTOUPDATER=${DISABLE_AUTOUPDATER:-1}
export LANG=${LANG:-en_US.UTF-8}
export LC_ALL=${LC_ALL:-en_US.UTF-8}
export DISPLAY=${DISPLAY:-:1}
export AGENT_BROWSER_EXECUTABLE_PATH=${AGENT_BROWSER_EXECUTABLE_PATH:-/usr/local/bin/chromium}
export BROWSER=${BROWSER:-/usr/local/bin/agentbox-open}
case $- in
  *i*)
    if [ "$PWD" = "$HOME" ] && [ -d /workspace ]; then
      cd /workspace
    fi
    ;;
esac
PROFILE
chmod 0644 /etc/profile.d/agentbox.sh
done_ "login-shell shim"

step "VNC stack"
apt-get install -y -q --no-install-recommends \
  tigervnc-standalone-server xterm 2>&1 | tail -3 || \
  echo "install-box.sh: tigervnc install failed (VNC may be unavailable)"
python3 -m venv /usr/local/share/agentbox/venv 2>/dev/null || true
/usr/local/share/agentbox/venv/bin/pip install --quiet websockify 2>&1 | tail -2 || \
  echo "install-box.sh: websockify install failed (VNC may be unavailable)"
ln -sf /usr/local/share/agentbox/venv/bin/websockify /usr/local/bin/websockify
if [ ! -d /usr/local/share/novnc ]; then
  git clone --depth 1 https://github.com/novnc/noVNC /usr/local/share/novnc 2>&1 | tail -2 || \
    echo "install-box.sh: noVNC clone failed (VNC may be unavailable)"
fi
sudo -u vscode -H mkdir -p /home/vscode/.vnc
done_ "VNC stack"

step "agent CLIs"
npm_global install -g --force @openai/codex opencode-ai agent-browser portless 2>&1 | tail -3 || \
  echo "install-box.sh: one or more agent npm installs failed (continuing)"
done_ "agent CLIs"

if [ "${AGENTBOX_CLAUDE_INSTALL:-native}" = "npm" ]; then
  step "Claude Code npm"
  npm_global install -g --force @anthropic-ai/claude-code
  install -d -o vscode -g vscode /home/vscode/.local/bin
  ln -sf "$(command -v claude)" /home/vscode/.local/bin/claude
  chown -h vscode:vscode /home/vscode/.local/bin/claude
  command -v claude >/dev/null || { echo "install-box.sh: npm claude install produced no claude on PATH" >&2; exit 71; }
  done_ "Claude Code npm"
else
  step "Claude Code native"
  if ! retry_backoff 3 sudo -u vscode -H bash -lc \
       'set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash -s stable && command -v claude >/dev/null'; then
    echo "install-box.sh: Claude native installer failed after 3 attempts" >&2
    exit 71
  fi
  done_ "Claude Code native"
fi

step "Chrome runtime libs"
apt-get install -y -q --no-install-recommends \
  libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libpango-1.0-0 libcairo2 libasound2t64 \
  fonts-liberation
done_ "Chrome runtime libs"

step "playwright Chromium"
npm_global install -g --force playwright 2>&1 | tail -3
PLAYWRIGHT_BIN="$(command -v playwright || true)"
if [ -z "$PLAYWRIGHT_BIN" ]; then
  echo "install-box.sh: playwright install produced no playwright on PATH" >&2
  exit 71
fi
sudo -u vscode -H env PATH=/usr/local/bin:/usr/bin:/bin "$PLAYWRIGHT_BIN" install chromium
CHROME_BIN="$(sudo -u vscode -H bash -lc 'ls /home/vscode/.cache/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | sort | tail -1')"
if [ -z "$CHROME_BIN" ] || [ ! -x "$CHROME_BIN" ]; then
  echo "install-box.sh: could not resolve Playwright Chromium binary" >&2
  exit 70
fi
LDD_OUT="$(ldd "$CHROME_BIN" 2>&1 || true)"
if printf '%s\n' "$LDD_OUT" | grep -q 'not found'; then
  echo "install-box.sh: Chromium has unresolved shared libs:" >&2
  printf '%s\n' "$LDD_OUT" | grep 'not found' >&2
  exit 71
fi
ln -sf "$CHROME_BIN" /usr/local/bin/chromium
done_ "playwright Chromium"

step "relay shims"
install -m 0755 /tmp/agentbox-gh-shim     /usr/local/bin/gh
install -m 0755 /tmp/agentbox-git-shim    /usr/local/bin/git
install -m 0755 /tmp/agentbox-ntn-shim    /usr/local/bin/ntn
ln -sf /usr/local/bin/ntn /usr/local/bin/notion
install -m 0755 /tmp/agentbox-linear-shim /usr/local/bin/linear
done_ "relay shims"

step "apt cleanup"
apt-get clean -y -q 2>/dev/null || true
rm -rf /var/lib/apt/lists/* 2>/dev/null || true
done_ "apt cleanup"

step "trim /tmp/agentbox-*"
rm -f /tmp/agentbox-ctl /tmp/agentbox-dockerd-start /tmp/agentbox-vnc-start \
      /tmp/agentbox-portless-trust /tmp/agentbox-checkpoint-cleanup /tmp/agentbox-open \
      /tmp/agentbox-gh-shim /tmp/agentbox-git-shim /tmp/agentbox-ntn-shim \
      /tmp/agentbox-linear-shim \
      /tmp/agentbox-custom-CLAUDE.md /tmp/agentbox-managed-settings.json \
      /tmp/agentbox-codex-hooks.json /tmp/agentbox-setup-skill.md
mv /tmp/agentbox-install.sh /var/log/agentbox/install-box.sh 2>/dev/null || true
done_ "trim /tmp/agentbox-*"

printf '\n*** install-box.sh: complete - CreateOS sandbox ready.\n'
