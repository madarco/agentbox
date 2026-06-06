#!/usr/bin/env bash
# AgentBox Vercel base-snapshot installer.
#
# Idempotent installer run once on a fresh Vercel Sandbox (Amazon Linux 2023,
# node24 runtime) during `agentbox prepare --provider vercel`. After it
# completes we `sandbox.snapshot()` the microVM — that snapshot is what every
# per-box create boots from.
#
# Differences from the hetzner installer (packages/sandbox-hetzner/scripts/
# install-box.sh), which this mirrors:
#   - dnf, not apt (Amazon Linux 2023).
#   - NO docker / dockerd / iptables — Vercel Sandbox blocks the namespace
#     syscalls a container runtime needs, so DinD is impossible here.
#   - The `vscode` user is created without forcing uid 1000 (the Vercel default
#     user may already hold it; there are no bind mounts so the exact uid is
#     irrelevant — only ownership of /workspace + /home/vscode matters).
#
# Required inputs (uploaded to /tmp before this runs):
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
  echo "provision.sh: must run as root (got uid $(id -u))" >&2
  exit 64
fi

step "dnf base packages"
# NOTE: do NOT request `curl` — AL2023 ships `curl-minimal` which provides the
# `curl` binary, and asking for full `curl` conflicts with it and aborts the
# whole (atomic) dnf transaction. `--allowerasing` lets dnf resolve any other
# such conflict by swapping rather than failing. No `| tail || true` here: that
# masks dnf's real exit code and lets the script march on with nothing
# installed (the bug that broke the first bake).
dnf install -y -q --allowerasing \
  ca-certificates \
  git \
  tar \
  gzip \
  which \
  shadow-utils \
  sudo \
  python3 \
  python3-pip \
  tmux \
  vim \
  libcap \
  rsync
done_ "dnf base packages"

step "node 24 sanity"
# Vercel's node24 runtime already ships node; just confirm it's on PATH.
if ! command -v node >/dev/null 2>&1; then
  echo "provision.sh: node not found on the node24 runtime — unexpected" >&2
  exit 65
fi
node --version
done_ "node 24 sanity"

step "vscode user + sudoers"
# No forced uid: the Vercel default user (`vercel-sandbox`) may already hold
# 1000, and there are no bind mounts so uid-parity with the docker provider
# doesn't matter. Ownership + passwordless sudo is what counts.
if ! id vscode >/dev/null 2>&1; then
  useradd -m -s /bin/bash vscode
fi
install -d -m 0755 -o vscode -g vscode /home/vscode
echo 'vscode ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/90-agentbox-vscode
chmod 0440 /etc/sudoers.d/90-agentbox-vscode
# Vercel's AL2023 base ships /etc/sudoers WITHOUT an includedir for
# /etc/sudoers.d (and with non-0440 perms), so the drop-in above is silently
# ignored and `sudo -n` as vscode fails with "a password is required" — which
# breaks the workspace seed, ctl-launch, and carry (all run as vscode and lean
# on passwordless sudo). Wire the include in and normalise perms so the rule
# actually loads, then fail loud if the result doesn't parse.
if ! grep -qE '^[[:space:]]*[@#]includedir[[:space:]]+/etc/sudoers\.d' /etc/sudoers; then
  printf '\n@includedir /etc/sudoers.d\n' >> /etc/sudoers
fi
chmod 0440 /etc/sudoers
visudo -cf /etc/sudoers >/dev/null
done_ "vscode user + sudoers"

step "agentbox base dirs + /workspace ownership"
mkdir -p /workspace /run/agentbox /var/log/agentbox /etc/agentbox /etc/claude-code \
         /usr/local/share/agentbox
chmod 755 /workspace
chown vscode:vscode /workspace /run/agentbox /var/log/agentbox
done_ "agentbox base dirs + /workspace ownership"

step "node setcap (bind <1024 without root)"
# The cloud WebProxy binds port 80; grant node the capability so it needn't run
# as root. Best-effort — if setcap is unavailable the WebProxy can still be
# launched via sudo.
NODE_BIN="$(readlink -f "$(command -v node)")"
setcap cap_net_bind_service=+ep "$NODE_BIN" || echo "provision.sh: setcap failed (continuing)"
done_ "node setcap (bind <1024 without root)"

step "corepack (pnpm + yarn shims)"
npm install -g corepack@latest 2>&1 | tail -2 || true
corepack enable pnpm yarn 2>/dev/null || true
sudo -u vscode -H mkdir -p /home/vscode/.cache/node/corepack
done_ "corepack (pnpm + yarn shims)"

step "git system-wide safe.directory"
# The Vercel node24 runtime's git is built with prefix /opt/git, so its system
# config is /opt/git/etc/gitconfig and the parent dir may not exist — without
# it `git config --system` fails with "could not lock config file" (exit 255).
# Create the dir, then set it system-wide AND for the vscode user so workspace
# git ops never trip "dubious ownership". All best-effort — a git-config quirk
# must never abort the bake.
mkdir -p /opt/git/etc 2>/dev/null || true
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
# /usr/bin/git and route provision.sh's own noVNC `git clone` through a relay
# that doesn't exist during the bake.
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
# Force /usr/local/bin to win PATH. Vercel's AL2023 base prepends /opt/git/bin
# AHEAD of /usr/local/bin, so the relay-routing shims at /usr/local/bin/{git,gh}
# are otherwise shadowed by the real binaries and agent-typed `git push` /
# `gh ...` bypass the host relay (backlog #19). A plain `case` prepend doesn't
# help — /usr/local/bin is already on PATH, just not first — so strip any
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
# the AL2023 repos shouldn't fail the whole bake — the VNC daemon launch is
# already best-effort on the create path.
dnf install -y -q --allowerasing tigervnc-server xterm 2>&1 | tail -3 || \
  echo "provision.sh: tigervnc-server install failed (VNC may be unavailable)"
pip3 install --quiet websockify 2>&1 | tail -2 || \
  echo "provision.sh: websockify install failed (VNC may be unavailable)"
# noVNC static assets — clone shallow into a stable path the vnc-start script
# can serve.
if [ ! -d /usr/local/share/novnc ]; then
  git clone --depth 1 https://github.com/novnc/noVNC /usr/local/share/novnc 2>&1 | tail -2 || \
    echo "provision.sh: noVNC clone failed (VNC may be unavailable)"
fi
sudo -u vscode -H mkdir -p /home/vscode/.vnc
done_ "VNC stack (TigerVNC + websockify + noVNC)"

step "X11 clipboard tools (xclip + autocutsel, built from source)"
# xclip and autocutsel are NOT in the AL2023 repos (unlike Debian/Ubuntu where
# docker + hetzner apt-install them). They are load-bearing: xclip backs the
# host->box Ctrl+V image paste (apps/cli/src/lib/paste-image.ts), and autocutsel
# keeps the VNC CLIPBOARD/PRIMARY selections in sync (agentbox-vnc-start). Build
# both from source — all deps are in the AL2023 default repos. Fail loud: a
# missing binary is a silently broken feature, not a skippable convenience.
dnf install -y -q --allowerasing \
  gcc make automake autoconf git \
  libX11-devel libXmu-devel libXt-devel libXaw-devel
git clone --depth 1 https://github.com/astrand/xclip /tmp/xclip
( cd /tmp/xclip && autoreconf -i && ./configure --prefix=/usr/local && make && make install )
rm -rf /tmp/xclip
command -v xclip >/dev/null || { echo "provision.sh: xclip build failed"; exit 1; }
git clone --depth 1 https://github.com/sigmike/autocutsel /tmp/autocutsel
( cd /tmp/autocutsel && autoreconf -i && ./configure --prefix=/usr/local && make && make install )
rm -rf /tmp/autocutsel
command -v autocutsel >/dev/null || { echo "provision.sh: autocutsel build failed"; exit 1; }
done_ "X11 clipboard tools (xclip + autocutsel, built from source)"

step "agent CLIs (codex + opencode + agent-browser, global npm)"
npm install -g @openai/codex opencode-ai agent-browser 2>&1 | tail -3 || \
  echo "provision.sh: one or more agent npm installs failed (continuing)"
done_ "agent CLIs (codex + opencode + agent-browser, global npm)"

step "Claude Code (native installer, run as vscode)"
# Anthropic's canonical installer drops `claude` at /home/vscode/.local/bin/.
sudo -u vscode -H bash -lc 'curl -fsSL https://claude.ai/install.sh | bash -s stable'
done_ "Claude Code (native installer, run as vscode)"

step "Chrome runtime libs (dnf)"
# agent-browser launches Chromium at AGENT_BROWSER_EXECUTABLE_PATH
# (/usr/local/bin/chromium, set in the login-shell shim above). Docker + hetzner
# bake that binary in; do the same here. These are the AL2023 (dnf) equivalents
# of the Ubuntu `t64` Chrome deps the other two providers apt-install — the
# Ubuntu package names don't exist on Amazon Linux 2023. Fail loud: a missing lib
# means a silently broken browser, not a convenience we can skip.
dnf install -y -q --allowerasing \
  nss nspr atk at-spi2-atk at-spi2-core cups-libs \
  libdrm libxkbcommon libXcomposite libXdamage libXfixes libXrandr \
  libXext libX11 libxcb mesa-libgbm pango cairo alsa-lib \
  liberation-fonts
done_ "Chrome runtime libs (dnf)"

step "playwright + Chromium download (as vscode)"
# Run the download as vscode so the cache lands under
# /home/vscode/.cache/ms-playwright. Resolve a stable symlink at
# /usr/local/bin/chromium so AGENT_BROWSER_EXECUTABLE_PATH stays predictable
# across Chromium revision bumps (mirrors hetzner install-box.sh).
npm install -g playwright 2>&1 | tail -3
sudo -u vscode -H bash -lc 'playwright install chromium'
CHROME_BIN="$(sudo -u vscode -H bash -lc 'ls /home/vscode/.cache/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | sort | tail -1')"
if [ -z "$CHROME_BIN" ] || [ ! -x "$CHROME_BIN" ]; then
  echo "provision.sh: could not resolve Playwright Chromium binary" >&2
  exit 70
fi
# Fail loud if a shared lib is missing — this is where an incomplete AL2023 dep
# set surfaces at bake time instead of at first agent-browser launch. Capture
# ldd's output first (|| true): under `set -euo pipefail` a non-zero ldd exit
# would otherwise dominate the `ldd | grep` pipeline and make the missing-libs
# check a silent no-op even when 'not found' lines are present.
LDD_OUT="$(ldd "$CHROME_BIN" 2>&1 || true)"
if printf '%s\n' "$LDD_OUT" | grep -q 'not found'; then
  echo "provision.sh: Chromium has unresolved shared libs:" >&2
  printf '%s\n' "$LDD_OUT" | grep 'not found' >&2
  exit 71
fi
ln -sf "$CHROME_BIN" /usr/local/bin/chromium
done_ "playwright + Chromium download (as vscode)"

step "dnf cleanup"
dnf clean all 2>/dev/null || true
done_ "dnf cleanup"

# Relay-routing shims, installed LAST — after every git/gh use in this script
# (the noVNC `git clone` and any npm/installer step). At RUNTIME agent calls to
# `gh ...` / `git push|pull|fetch|clone` must route through the host relay; the
# login-shell shim above forces /usr/local/bin ahead of Vercel's /opt/git/bin so
# these win (a plain install location is NOT enough on AL2023 — see #19). During
# the bake there is no relay, so they must not shadow the real binaries until
# provisioning is done. Installed from /tmp just before the trim step removes the
# sources.
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
mv /tmp/agentbox-provision.sh /var/log/agentbox/provision.sh 2>/dev/null || true
done_ "trim /tmp/agentbox-*"

printf '\n*** provision.sh: complete — microVM ready for snapshot.\n'
