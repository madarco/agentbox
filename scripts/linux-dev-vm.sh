#!/usr/bin/env bash
#
# linux-dev-vm.sh — manage a *persistent* clean Ubuntu VM on Hetzner for testing
# `agentbox` on a Linux host. NOT an agentbox box: a bare VPS you log into and
# drive the CLI on to check Linux compatibility of any feature.
#
# WHY this exists: the CLI grew up macOS-only (see docs/linux-host-backlog.md).
# To find and fix Linux-host issues we need a real Ubuntu host that survives
# across edit/deploy/test cycles. This script provisions one, ships the locally
# built CLI on demand, and tears it down when you're done.
#
# Subcommands:
#   up        create the VM if absent (cx23 / nbg1 / ubuntu-24.04), install
#             node 20 + docker + git + tmux, create a non-root `dev` user
#             (docker + passwordless sudo). Idempotent: reuses a live VM.
#   deploy    build the monorepo, npm pack apps/cli, scp + `npm install -g` it
#             on the VM. Re-run after local changes. Use --no-build to skip build.
#   ssh       open an interactive shell as `dev` (or run: `linux-dev-vm.sh ssh -- uptime`)
#   doctor    run `agentbox doctor --provider docker` twice — as a user NOT in
#             the docker group (permission-denied branch) and as `dev` (healthy).
#   info      print server id / ip / ssh command / state file
#   down      destroy the server + SSH key + local state
#
# State (server id, ip, key) persists in ~/.agentbox/linux-dev-vm/ so every
# subcommand targets the same VM. `down` is the only thing that deletes it.
#
# HCLOUD_TOKEN is read from env, else .env.local, else ~/.agentbox/secrets.env.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="https://api.hetzner.cloud/v1"
STATE_DIR="$HOME/.agentbox/linux-dev-vm"
STATE_FILE="$STATE_DIR/state.json"
KEY="$STATE_DIR/id_ed25519"
NAME="agentbox-linux-dev"
SERVER_TYPE="cx23"
LOCATION="nbg1"
IMAGE="ubuntu-24.04"
SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8 -o LogLevel=ERROR)

die() { echo "error: $*" >&2; exit 1; }

# --- token -------------------------------------------------------------------
resolve_token() {
  if [[ -z "${HCLOUD_TOKEN:-}" && -f "$REPO_ROOT/.env.local" ]]; then
    HCLOUD_TOKEN="$(grep -E '^HCLOUD_TOKEN=' "$REPO_ROOT/.env.local" | head -1 | cut -d= -f2- | tr -d '"' || true)"
  fi
  if [[ -z "${HCLOUD_TOKEN:-}" && -f "$HOME/.agentbox/secrets.env" ]]; then
    HCLOUD_TOKEN="$(grep -E '^HCLOUD_TOKEN=' "$HOME/.agentbox/secrets.env" | head -1 | cut -d= -f2- | tr -d '"' || true)"
  fi
  [[ -n "${HCLOUD_TOKEN:-}" ]] || die "HCLOUD_TOKEN not found (env / .env.local / ~/.agentbox/secrets.env)"
}

# Tiny JSON field extractor (node is always present in this repo; jq is not).
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);const p=process.argv[1].split(".");let v=o;for(const k of p)v=(v==null?undefined:v[k]);process.stdout.write(v==null?"":String(v));})' "$1"; }

api() {
  # api <METHOD> <PATH> [json-body]
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -fsS -X "$method" -H "Authorization: Bearer $HCLOUD_TOKEN" -H "Content-Type: application/json" -d "$body" "$API$path"
  else
    curl -fsS -X "$method" -H "Authorization: Bearer $HCLOUD_TOKEN" "$API$path"
  fi
}

state_get() { [[ -f "$STATE_FILE" ]] && jget "$1" < "$STATE_FILE" || true; }

require_vm() {
  [[ -f "$STATE_FILE" ]] || die "no VM — run \`$0 up\` first"
  IP="$(state_get ip)"
  [[ -n "$IP" ]] || die "state file has no ip; \`$0 down\` and re-\`up\`"
}

ssh_dev() { ssh -i "$KEY" "${SSH_OPTS[@]}" "dev@$IP" "$@"; }
ssh_root() { ssh -i "$KEY" "${SSH_OPTS[@]}" "root@$IP" "$@"; }

# --- cloud-init: node 20 + docker + git + tmux, non-root `dev` user ----------
cloud_init() {
cat <<'EOF'
#cloud-config
package_update: true
runcmd:
  - curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  - apt-get install -y nodejs docker.io git tmux ca-certificates
  - systemctl enable --now docker
  - id dev >/dev/null 2>&1 || useradd -m -s /bin/bash dev
  - usermod -aG docker dev
  - echo 'dev ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-dev
  - install -d -m 700 -o dev -g dev /home/dev/.ssh
  - cp /root/.ssh/authorized_keys /home/dev/.ssh/authorized_keys
  - chown dev:dev /home/dev/.ssh/authorized_keys
  - chmod 600 /home/dev/.ssh/authorized_keys
  - touch /var/lib/cloud/agentbox-ready
EOF
}

cmd_up() {
  resolve_token
  mkdir -p "$STATE_DIR"
  local sid; sid="$(state_get server_id)"
  if [[ -n "$sid" ]] && api GET "/servers/$sid" >/dev/null 2>&1; then
    echo ">> VM already up (server_id=$sid)"; cmd_info; return 0
  fi

  [[ -f "$KEY" ]] || ssh-keygen -t ed25519 -N "" -C "$NAME" -f "$KEY" >/dev/null
  local pub; pub="$(cat "$KEY.pub")"
  local suffix; suffix="$(date +%s)"
  echo ">> uploading ssh key"
  local key_resp key_id
  key_resp="$(api POST /ssh_keys "$(node -e 'console.log(JSON.stringify({name:process.argv[1],public_key:process.argv[2]}))' "$NAME-$suffix" "$pub")")"
  key_id="$(printf '%s' "$key_resp" | jget ssh_key.id)"

  echo ">> creating $SERVER_TYPE/$LOCATION $IMAGE server '$NAME'"
  local body create ip server_id
  body="$(node -e 'console.log(JSON.stringify({name:process.argv[1],server_type:process.argv[2],location:process.argv[3],image:process.argv[4],ssh_keys:[Number(process.argv[5])],user_data:process.argv[6],public_net:{enable_ipv4:true,enable_ipv6:false}}))' "$NAME" "$SERVER_TYPE" "$LOCATION" "$IMAGE" "$key_id" "$(cloud_init)")"
  create="$(api POST /servers "$body")"
  server_id="$(printf '%s' "$create" | jget server.id)"
  ip="$(printf '%s' "$create" | jget server.public_net.ipv4.ip)"
  node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({server_id:Number(process.argv[2]),ip:process.argv[3],ssh_key_id:Number(process.argv[4])},null,2)+"\n")' "$STATE_FILE" "$server_id" "$ip" "$key_id"
  echo "   server_id=$server_id ip=$ip"

  echo ">> waiting for SSH"
  for i in $(seq 1 60); do
    if ssh -i "$KEY" "${SSH_OPTS[@]}" "root@$ip" true 2>/dev/null; then break; fi
    sleep 5; [[ "$i" == "60" ]] && die "ssh never came up"
  done
  echo ">> waiting for cloud-init (node + docker + dev user)"
  ssh -i "$KEY" "${SSH_OPTS[@]}" "root@$ip" 'cloud-init status --wait >/dev/null 2>&1 || true; until [ -f /var/lib/cloud/agentbox-ready ]; do sleep 3; done'
  echo ">> ready:"
  ssh -i "$KEY" "${SSH_OPTS[@]}" "root@$ip" 'echo "   node=$(node -v) docker=$(docker --version) git=$(git --version)"'
  cmd_info
}

cmd_deploy() {
  require_vm
  local build=1
  for a in "$@"; do [[ "$a" == "--no-build" ]] && build=0; done
  if [[ "$build" == "1" ]]; then echo ">> pnpm -w build"; (cd "$REPO_ROOT" && pnpm -w build); fi
  local tmp tarball
  tmp="$(mktemp -d)"
  echo ">> npm pack apps/cli"
  tarball="$(cd "$REPO_ROOT/apps/cli" && npm pack --silent --pack-destination "$tmp")"
  echo ">> scp + npm install -g on the VM"
  scp -i "$KEY" "${SSH_OPTS[@]}" "$tmp/$tarball" "dev@$IP:/home/dev/$tarball"
  ssh_dev "sudo npm install -g --no-fund --no-audit /home/dev/$tarball && echo \"installed agentbox \$(agentbox --version)\""
  rm -rf "$tmp"
}

cmd_ssh() {
  require_vm
  # `linux-dev-vm.sh ssh`            -> interactive shell
  # `linux-dev-vm.sh ssh -- <cmd…>`  -> run a command
  if [[ "${1:-}" == "--" ]]; then shift; ssh_dev "$@"; else ssh_dev "$@"; fi
}

cmd_doctor() {
  require_vm
  ssh_dev 'command -v agentbox >/dev/null' || die "agentbox not installed on the VM — run: $0 deploy"
  # A user NOT in the docker group exercises the permission-denied branch.
  ssh_root 'id probe >/dev/null 2>&1 || { useradd -m -s /bin/bash probe; install -d -m 700 -o probe -g probe /home/probe/.ssh; }'
  echo ""
  echo "============ doctor #1: user NOT in docker group (permission denied) ============"
  ssh_root 'su - probe -c "NO_COLOR=1 agentbox doctor --provider docker" || true'
  echo ""
  echo "============ doctor #2: dev user IN docker group (healthy) ============"
  ssh_dev 'sg docker -c "NO_COLOR=1 agentbox doctor --provider docker" || true'
}

cmd_info() {
  [[ -f "$STATE_FILE" ]] || { echo "no VM (state file absent)"; return 0; }
  IP="$(state_get ip)"
  echo "server_id : $(state_get server_id)"
  echo "ip        : $IP"
  echo "ssh       : ssh -i $KEY dev@$IP"
  echo "state     : $STATE_FILE"
}

cmd_down() {
  resolve_token
  [[ -f "$STATE_FILE" ]] || { echo "no VM to delete"; return 0; }
  local sid kid; sid="$(state_get server_id)"; kid="$(state_get ssh_key_id)"
  echo ">> deleting server $sid + ssh key $kid"
  [[ -n "$sid" ]] && api DELETE "/servers/$sid" >/dev/null 2>&1 || true
  [[ -n "$kid" ]] && api DELETE "/ssh_keys/$kid" >/dev/null 2>&1 || true
  rm -rf "$STATE_DIR"
  echo ">> done"
}

case "${1:-}" in
  up) shift; cmd_up "$@" ;;
  deploy) shift; cmd_deploy "$@" ;;
  ssh) shift; cmd_ssh "$@" ;;
  doctor) shift; cmd_doctor "$@" ;;
  info) shift; cmd_info "$@" ;;
  down) shift; cmd_down "$@" ;;
  *) echo "usage: $0 {up|deploy|ssh|doctor|info|down} [args]" >&2; exit 2 ;;
esac
