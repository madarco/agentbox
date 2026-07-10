#!/usr/bin/env bash
# AgentBox E2B base-template installer.
#
# Run once by `Template.build`'s `.runCmd` step during `agentbox prepare
# --provider e2b`. After it completes, E2B finalises the template — that
# template id is what every per-box create boots from.
#
# Differences from the vercel installer (packages/sandbox-vercel/scripts/
# provision.sh), which this mirrors:
#   - apt-get / dpkg, not dnf (E2B base = Debian 12 bookworm).
#   - docker.io + iptables ARE installed (in-box DinD): unlike the original
#     assumption, E2B microVMs DO support nested containers (full root +
#     cap_sys_admin + working namespaces, verified 2026-06-23). dockerd is
#     launched at create/resume by agentbox-dockerd-start, not systemd.
#   - The `vscode` user is created with a free uid (E2B's `code` group holds
#     1000 on the base template, so useradd picks the next free uid; there are
#     no bind mounts so the exact uid is irrelevant — only ownership of
#     /workspace + /home/vscode matters).
#
# Required inputs (uploaded via Template.copy before this runs):
#   /tmp/agentbox-ctl                  -- prebuilt @agentbox/ctl bundle (cjs)
#   /tmp/agentbox-dockerd-start        -- in-box dockerd launch helper (DinD)
#   /tmp/agentbox-vnc-start            -- VNC startup helper
#   /tmp/agentbox-checkpoint-cleanup   -- pre-snapshot cleanup helper
#   /tmp/agentbox-open                 -- in-box xdg-open shim
#   /tmp/agentbox-gh-shim              -- in-box `gh` shim (routes to host gh)
#   /tmp/agentbox-git-shim             -- in-box `git` shim (routes via relay)
#   /tmp/agentbox-ntn-shim             -- in-box `ntn`/`notion` shim (routes to host ntn)
#   /tmp/agentbox-linear-shim          -- in-box `linear` shim (routes to host linear; rejects `auth token`)
#   /tmp/agentbox-custom-CLAUDE.md     -- /etc/claude-code/CLAUDE.md content
#   /tmp/agentbox-managed-settings.json -- /etc/claude-code/managed-settings.json
#   /tmp/agentbox-codex-hooks.json     -- /usr/local/share/agentbox/codex-hooks.json
#   /tmp/agentbox-setup-skill.md       -- /usr/local/share/agentbox/setup-guide.md
#
# Output: noisy progress to stdout (streamed into ~/.agentbox/logs/prepare.log).
# Each major step prints `>>> BEGIN <step>` / `<<< END <step>`.

set -euo pipefail

step() { printf '\n>>> BEGIN %s\n' "$1"; }
done_() { printf '<<< END %s\n' "$1"; }

# Retry a command with exponential backoff. Usage: retry_backoff <max> cmd...
# Waits 60s before attempt 2, 240s before attempt 3 (~5 min total budget). Used
# for the Claude native installer, whose CDN (claude.ai / downloads.claude.ai,
# behind Cloudflare) intermittently 403s cloud-datacenter egress IPs under load.
retry_backoff() {
  local max=$1; shift
  local attempt=1
  local -a waits=(60 240)
  while true; do
    if "$@"; then return 0; fi
    if [ "$attempt" -ge "$max" ]; then return 1; fi
    local w=${waits[$((attempt-1))]:-240}
    echo "retry_backoff: attempt ${attempt}/${max} failed — backing off ${w}s" >&2
    sleep "$w"
    attempt=$((attempt+1))
  done
}

if [ "$(id -u)" -ne 0 ]; then
  echo "build-template.sh: must run as root (got uid $(id -u))" >&2
  exit 64
fi

export DEBIAN_FRONTEND=noninteractive

step "apt base packages"
# E2B base ships Debian 12 with node + git + sudo already installed; we still
# need tmux, build deps, the X11 stack, etc.
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
  autocutsel
done_ "apt base packages"

step "node sanity"
# E2B base ships node 20; just confirm it's on PATH.
if ! command -v node >/dev/null 2>&1; then
  echo "build-template.sh: node not found on the E2B base template — unexpected" >&2
  exit 65
fi
node --version
done_ "node sanity"

step "vscode user + sudoers"
# Don't force a uid: the E2B base template's `code` group/user holds 1000,
# and there are no bind mounts so uid-parity with the docker provider
# doesn't matter. Ownership + passwordless sudo is what counts.
if ! id vscode >/dev/null 2>&1; then
  useradd -m -s /bin/bash vscode
fi
install -d -m 0755 -o vscode -g vscode /home/vscode
echo 'vscode ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/90-agentbox-vscode
chmod 0440 /etc/sudoers.d/90-agentbox-vscode
visudo -cf /etc/sudoers >/dev/null
done_ "vscode user + sudoers"

step "docker engine (in-box DinD)"
# E2B microVMs support nested containers (full root + cap_sys_admin), so bake
# the docker engine like the vercel/hetzner/docker providers. dockerd is NOT
# started by systemd here — agentbox-dockerd-start launches it at create/resume
# (it picks the storage driver at runtime; overlay2 works on E2B). docker.io
# pulls containerd + runc + the cli; iptables is needed for bridge networking.
# Must run AFTER the vscode user exists (usermod -aG docker vscode below).
apt-get install -y -q --no-install-recommends docker.io iptables
groupadd -f docker
usermod -aG docker vscode
systemctl disable --now docker.service docker.socket 2>/dev/null || true
# `docker compose` + BuildKit `docker build` come from CLI plugins that no
# bookworm apt package provides (its `docker-compose` is the deprecated python
# v1), so install the official release binaries into the CLI's plugin search
# path. The buildx tag comes from the releases/latest redirect, not the GitHub
# API — anonymous API calls rate-limit per IP and cloud egress IPs share pools.
arch="$(uname -m)"   # x86_64 / aarch64 — matches the compose asset names
install -d -m 0755 /usr/local/lib/docker/cli-plugins
curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${arch}" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
buildx_tag="$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/docker/buildx/releases/latest | sed 's|.*/||')"
buildx_arch="${arch/x86_64/amd64}"; buildx_arch="${buildx_arch/aarch64/arm64}"
curl -fsSL "https://github.com/docker/buildx/releases/download/${buildx_tag}/buildx-${buildx_tag}.linux-${buildx_arch}" \
  -o /usr/local/lib/docker/cli-plugins/docker-buildx
chmod 0755 /usr/local/lib/docker/cli-plugins/docker-compose /usr/local/lib/docker/cli-plugins/docker-buildx
docker compose version
docker buildx version
done_ "docker engine (in-box DinD)"

step "agentbox base dirs + /workspace ownership"
mkdir -p /workspace /run/agentbox /var/log/agentbox /var/lib/agentbox /etc/agentbox /etc/claude-code \
         /usr/local/share/agentbox
chmod 755 /workspace
chown vscode:vscode /workspace /run/agentbox /var/log/agentbox /var/lib/agentbox
done_ "agentbox base dirs + /workspace ownership"

step "node setcap (bind <1024 without root)"
# Grant node the capability so the WebProxy can bind port 80 without sudo.
# Best-effort — if setcap is unavailable the WebProxy can still be launched
# via sudo. (E2B's `getHost` accepts any port; agentbox uses 8080 across
# cloud providers, so this is belt-and-braces.)
NODE_BIN="$(readlink -f "$(command -v node)")"
setcap cap_net_bind_service=+ep "$NODE_BIN" || echo "build-template.sh: setcap failed (continuing)"
done_ "node setcap (bind <1024 without root)"

step "corepack (pnpm + yarn shims)"
npm install -g corepack@latest 2>&1 | tail -2 || true
corepack enable pnpm yarn 2>/dev/null || true
sudo -u vscode -H mkdir -p /home/vscode/.cache/node/corepack
done_ "corepack (pnpm + yarn shims)"

step "git system-wide safe.directory"
git config --system --add safe.directory '*' 2>/dev/null || true
sudo -u vscode -H git config --global --add safe.directory '*' 2>/dev/null || true
done_ "git system-wide safe.directory"

step "git-lfs system filter"
# Register filter.lfs.* system-wide (and for vscode) so an in-box checkout of an
# LFS repo smudges instead of writing pointer files. Cloud boxes have no
# bind-mounted ~/.gitconfig, so --system is the only place the filter lives.
# --skip-repo never touches a checkout at bake time.
git lfs install --system --skip-repo 2>/dev/null || true
sudo -u vscode -H git lfs install --skip-repo 2>/dev/null || true
done_ "git-lfs system filter"

step "agentbox-ctl install"
install -m 0755 /tmp/agentbox-ctl /usr/local/bin/agentbox-ctl
done_ "agentbox-ctl install"

step "baked helper scripts (dockerd / vnc / cleanup / xdg-open)"
install -m 0755 /tmp/agentbox-dockerd-start      /usr/local/bin/agentbox-dockerd-start
install -m 0755 /tmp/agentbox-vnc-start          /usr/local/bin/agentbox-vnc-start
install -m 0755 /tmp/agentbox-checkpoint-cleanup /usr/local/bin/agentbox-checkpoint-cleanup
install -m 0755 /tmp/agentbox-open               /usr/local/bin/agentbox-open
ln -sf /usr/local/bin/agentbox-open /usr/local/bin/xdg-open
# NOTE: the gh + git shims are installed LAST (see "relay shims" near the end).
# Installing them here would put the relay-routing `git` on PATH ahead of
# /usr/bin/git and route this script's own remaining git/clone commands through
# a relay that doesn't exist during the bake.
done_ "baked helper scripts (dockerd / vnc / cleanup / xdg-open)"

step "baked config files (claude / codex / setup guide / tmux.conf)"
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
# Force /usr/local/bin to win PATH so the relay-routing shims at
# /usr/local/bin/{git,gh} aren't shadowed by /usr/bin/{git,gh}. Strip any
# existing occurrence and re-prepend.
PATH=/usr/local/bin:$(printf '%s' "$PATH" | sed -e 's#:/usr/local/bin:#:#g' -e 's#^/usr/local/bin:##' -e 's#:/usr/local/bin$##' -e 's#^/usr/local/bin$##')
export PATH
export COLORTERM=${COLORTERM:-truecolor}
export DISABLE_AUTOUPDATER=${DISABLE_AUTOUPDATER:-1}
export DISPLAY=${DISPLAY:-:1}
export AGENT_BROWSER_EXECUTABLE_PATH=${AGENT_BROWSER_EXECUTABLE_PATH:-/usr/local/bin/chromium}
export BROWSER=${BROWSER:-/usr/local/bin/agentbox-open}
# Land interactive login shells in the workspace, so remote-host integrations
# (Codex app, VS Code Remote-SSH, plain `ssh <box>`) open in the project instead
# of $HOME. Interactive-only so scp/sftp and `ssh box <cmd>` are untouched; only
# when still at $HOME so a caller-chosen dir (e.g. agentbox's tmux `-c /workspace`)
# is never overridden.
case $- in
  *i*)
    if [ "$PWD" = "$HOME" ] && [ -d /workspace ]; then
      cd /workspace
    fi
    ;;
esac
PROFILE
chmod 0644 /etc/profile.d/agentbox.sh
done_ "login-shell shim (/etc/profile.d/agentbox.sh)"

step "VNC stack (TigerVNC + websockify + noVNC)"
# Best-effort: VNC is a convenience (agentbox screen). A package that isn't in
# the Debian repos shouldn't fail the whole bake.
apt-get install -y -q --no-install-recommends \
  tigervnc-standalone-server xterm 2>&1 | tail -3 || \
  echo "build-template.sh: tigervnc install failed (VNC may be unavailable)"
# Install websockify into a per-user venv (PEP 668 forbids system pip on
# Debian 12). The venv goes under /usr/local/share so agentbox-vnc-start can
# find it regardless of the launching user.
python3 -m venv /usr/local/share/agentbox/venv 2>/dev/null || true
/usr/local/share/agentbox/venv/bin/pip install --quiet websockify 2>&1 | tail -2 || \
  echo "build-template.sh: websockify install failed (VNC may be unavailable)"
ln -sf /usr/local/share/agentbox/venv/bin/websockify /usr/local/bin/websockify
# noVNC static assets — clone shallow into a stable path the vnc-start script
# can serve.
if [ ! -d /usr/local/share/novnc ]; then
  git clone --depth 1 https://github.com/novnc/noVNC /usr/local/share/novnc 2>&1 | tail -2 || \
    echo "build-template.sh: noVNC clone failed (VNC may be unavailable)"
fi
sudo -u vscode -H mkdir -p /home/vscode/.vnc
done_ "VNC stack (TigerVNC + websockify + noVNC)"

step "agent CLIs (codex + opencode + agent-browser, global npm)"
npm install -g @openai/codex opencode-ai agent-browser 2>&1 | tail -3 || \
  echo "build-template.sh: one or more agent npm installs failed (continuing)"
done_ "agent CLIs (codex + opencode + agent-browser, global npm)"

# AGENTBOX_CLAUDE_INSTALL selects how Claude Code is installed (default
# `native`). `npm` is an opt-in fallback for hosts whose egress IP the native
# installer's CDN 403s — see `box.claudeInstall`.
if [ "${AGENTBOX_CLAUDE_INSTALL:-native}" = "npm" ]; then
  step "Claude Code (npm: @anthropic-ai/claude-code)"
  # npm-global drops `claude` at Node's prefix bin, not the
  # /home/vscode/.local/bin/claude the rest of AgentBox hardcodes. Symlink it
  # into that path so the box stays indistinguishable from a native install.
  npm install -g @anthropic-ai/claude-code
  install -d -o vscode -g vscode /home/vscode/.local/bin
  ln -sf "$(command -v claude)" /home/vscode/.local/bin/claude
  chown -h vscode:vscode /home/vscode/.local/bin/claude
  command -v claude >/dev/null || { echo "build-template.sh: npm claude install produced no claude on PATH" >&2; exit 71; }
  done_ "Claude Code (npm: @anthropic-ai/claude-code)"
else
  step "Claude Code (native installer, run as vscode)"
  # Anthropic's native installer drops `claude` at /home/vscode/.local/bin/claude
  # with installMethod=native (matching the host-seeded .claude.json, so the
  # startup integrity check stays quiet) and ships native-only features the npm
  # package lacks. Its CDN (claude.ai / downloads.claude.ai) sits behind
  # Cloudflare, which intermittently 403s cloud-datacenter egress IPs under load —
  # so retry with backoff rather than falling back to npm. A bare `curl | bash`
  # would hide a 403 (curl -f exits non-zero but the pipe's status is bash's 0),
  # so keep pipefail and fold the PATH check in so a "succeeded but absent" result
  # also retries. A failed build is better than a claude-less template.
  if ! retry_backoff 3 sudo -u vscode -H bash -lc \
       'set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash -s stable && command -v claude >/dev/null'; then
    echo "build-template.sh: Claude native installer failed after 3 attempts (Cloudflare 403?) — aborting build" >&2
    exit 71
  fi
  done_ "Claude Code (native installer, run as vscode)"
fi

step "Chrome runtime libs (apt)"
# agent-browser launches Chromium at AGENT_BROWSER_EXECUTABLE_PATH
# (/usr/local/bin/chromium, set in the login-shell shim above). Bake the libs
# Playwright's Chromium needs. Match the docker provider's Debian apt list.
apt-get install -y -q --no-install-recommends \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libpango-1.0-0 libcairo2 libasound2 \
  fonts-liberation
done_ "Chrome runtime libs (apt)"

step "playwright + Chromium download (as vscode)"
# Run the download as vscode so the cache lands under
# /home/vscode/.cache/ms-playwright. Resolve a stable symlink at
# /usr/local/bin/chromium so AGENT_BROWSER_EXECUTABLE_PATH stays predictable
# across Chromium revision bumps.
npm install -g playwright 2>&1 | tail -3
sudo -u vscode -H bash -lc 'playwright install chromium'
CHROME_BIN="$(sudo -u vscode -H bash -lc 'ls /home/vscode/.cache/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | sort | tail -1')"
if [ -z "$CHROME_BIN" ] || [ ! -x "$CHROME_BIN" ]; then
  echo "build-template.sh: could not resolve Playwright Chromium binary" >&2
  exit 70
fi
# Fail loud if a shared lib is missing — surfaces an incomplete apt set at bake
# time, not at first agent-browser launch.
LDD_OUT="$(ldd "$CHROME_BIN" 2>&1 || true)"
if printf '%s\n' "$LDD_OUT" | grep -q 'not found'; then
  echo "build-template.sh: Chromium has unresolved shared libs:" >&2
  printf '%s\n' "$LDD_OUT" | grep 'not found' >&2
  exit 71
fi
ln -sf "$CHROME_BIN" /usr/local/bin/chromium
done_ "playwright + Chromium download (as vscode)"

step "apt cleanup"
apt-get clean -y -q 2>/dev/null || true
rm -rf /var/lib/apt/lists/* 2>/dev/null || true
done_ "apt cleanup"

# Relay-routing shims, installed LAST — after every git/gh use in this script
# (the noVNC `git clone` and any npm/installer step). At RUNTIME agent calls to
# `gh ...` / `git push|pull|fetch|clone` must route through the host relay; the
# login-shell shim above forces /usr/local/bin ahead of /usr/bin so these win.
# During the bake there is no relay, so they must not shadow the real binaries
# until provisioning is done. Installed from /tmp just before the trim step.
step "relay shims (gh + git + ntn + linear)"
install -m 0755 /tmp/agentbox-gh-shim     /usr/local/bin/gh
install -m 0755 /tmp/agentbox-git-shim    /usr/local/bin/git
install -m 0755 /tmp/agentbox-ntn-shim    /usr/local/bin/ntn
ln -sf /usr/local/bin/ntn /usr/local/bin/notion
install -m 0755 /tmp/agentbox-linear-shim /usr/local/bin/linear
done_ "relay shims (gh + git + ntn + linear)"

step "trim /tmp/agentbox-*"
rm -f /tmp/agentbox-ctl /tmp/agentbox-dockerd-start /tmp/agentbox-vnc-start \
      /tmp/agentbox-checkpoint-cleanup /tmp/agentbox-open \
      /tmp/agentbox-gh-shim /tmp/agentbox-git-shim /tmp/agentbox-ntn-shim \
      /tmp/agentbox-linear-shim \
      /tmp/agentbox-custom-CLAUDE.md /tmp/agentbox-managed-settings.json \
      /tmp/agentbox-codex-hooks.json /tmp/agentbox-setup-skill.md
mv /tmp/agentbox-build-template.sh /var/log/agentbox/build-template.sh 2>/dev/null || true
done_ "trim /tmp/agentbox-*"

printf '\n*** build-template.sh: complete — template ready for finalisation.\n'
