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
#   - NO docker / dockerd / iptables — E2B microVMs can't run nested
#     containers (same shape as vercel).
#   - The `vscode` user is created with a free uid (E2B's `code` group holds
#     1000 on the base template, so useradd picks the next free uid; there are
#     no bind mounts so the exact uid is irrelevant — only ownership of
#     /workspace + /home/vscode matters).
#
# Required inputs (uploaded via Template.copy before this runs):
#   /tmp/agentbox-ctl                  -- prebuilt @agentbox/ctl bundle (cjs)
#   /tmp/agentbox-vnc-start            -- VNC startup helper
#   /tmp/agentbox-checkpoint-cleanup   -- pre-snapshot cleanup helper
#   /tmp/agentbox-open                 -- in-box xdg-open shim
#   /tmp/agentbox-gh-shim              -- in-box `gh` shim (routes to host gh)
#   /tmp/agentbox-git-shim             -- in-box `git` shim (routes via relay)
#   /tmp/agentbox-ntn-shim             -- in-box `ntn`/`notion` shim (routes to host ntn)
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

step "agentbox base dirs + /workspace ownership"
mkdir -p /workspace /run/agentbox /var/log/agentbox /etc/agentbox /etc/claude-code \
         /usr/local/share/agentbox
chmod 755 /workspace
chown vscode:vscode /workspace /run/agentbox /var/log/agentbox
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

step "agentbox-ctl install"
install -m 0755 /tmp/agentbox-ctl /usr/local/bin/agentbox-ctl
done_ "agentbox-ctl install"

step "baked helper scripts (vnc / cleanup / xdg-open)"
install -m 0755 /tmp/agentbox-vnc-start          /usr/local/bin/agentbox-vnc-start
install -m 0755 /tmp/agentbox-checkpoint-cleanup /usr/local/bin/agentbox-checkpoint-cleanup
install -m 0755 /tmp/agentbox-open               /usr/local/bin/agentbox-open
ln -sf /usr/local/bin/agentbox-open /usr/local/bin/xdg-open
# NOTE: the gh + git shims are installed LAST (see "relay shims" near the end).
# Installing them here would put the relay-routing `git` on PATH ahead of
# /usr/bin/git and route this script's own remaining git/clone commands through
# a relay that doesn't exist during the bake.
done_ "baked helper scripts (vnc / cleanup / xdg-open)"

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

step "Claude Code (native installer, run as vscode)"
# Anthropic's canonical installer drops `claude` at /home/vscode/.local/bin/.
sudo -u vscode -H bash -lc 'curl -fsSL https://claude.ai/install.sh | bash -s stable'
done_ "Claude Code (native installer, run as vscode)"

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
step "relay shims (gh + git + ntn)"
install -m 0755 /tmp/agentbox-gh-shim  /usr/local/bin/gh
install -m 0755 /tmp/agentbox-git-shim /usr/local/bin/git
install -m 0755 /tmp/agentbox-ntn-shim /usr/local/bin/ntn
ln -sf /usr/local/bin/ntn /usr/local/bin/notion
done_ "relay shims (gh + git + ntn)"

step "trim /tmp/agentbox-*"
rm -f /tmp/agentbox-ctl /tmp/agentbox-vnc-start \
      /tmp/agentbox-checkpoint-cleanup /tmp/agentbox-open \
      /tmp/agentbox-gh-shim /tmp/agentbox-git-shim /tmp/agentbox-ntn-shim \
      /tmp/agentbox-custom-CLAUDE.md /tmp/agentbox-managed-settings.json \
      /tmp/agentbox-codex-hooks.json /tmp/agentbox-setup-skill.md
mv /tmp/agentbox-build-template.sh /var/log/agentbox/build-template.sh 2>/dev/null || true
done_ "trim /tmp/agentbox-*"

printf '\n*** build-template.sh: complete — template ready for finalisation.\n'
