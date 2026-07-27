#!/usr/bin/env bash
#
# hub-test-vm.sh — manage a *persistent, always-on* clean Ubuntu VM on Hetzner
# that plays the role of "a user's PC" for testing AgentBox end-to-end, and in
# particular the **remote hub / control box** flow.
#
# It is NOT an agentbox box: it is a bare VPS with node + docker + git + gh, the
# published CLI installed from npm (`nightly` by default), and a credential
# **vault** that survives wiping `~/.agentbox`. That wipe is the point — every
# test starts from a virgin AgentBox state (no registry, no bakes, no hub
# config) while the credentials it needs are re-seeded in one second.
#
# Subcommands:
#   up          create the VM if absent (cx33 / nbg1 / ubuntu-24.04) with node 20,
#               docker, git, gh, tmux and a non-root `dev` user. Idempotent.
#   creds       push the credential vault from this host: provider keys (the same
#               filtered set the hub deploy copies), the *test account's* gh
#               token, git identity, and the agent-login backups. Then apply it.
#   install     npm i -g @madarco/agentbox@<tag>   (default: nightly)
#   deploy      ship the CLI built in THIS checkout (pnpm build + npm pack) —
#               use it to test unreleased code. `--no-build` to skip the build.
#   testrepo    create a small non-LFS repo on the test account and clone it on
#               the VM (git-LFS repos break hub-side clones).
#   reset       destroy the VM's boxes + its deployed control box, wipe
#               ~/.agentbox, re-apply the vault. Run this before every test.
#   ssh         interactive shell as `dev` (or: `hub-test-vm.sh ssh -- <cmd…>`)
#   run         run a long command detached in tmux on the VM, from the test
#               project dir (an `ssh -- nohup … &` dies with the session)
#   log         tail ~/.agentbox/logs/latest.log on the VM
#   info        print server id / ip / ssh command / vault status
#   down        destroy the VM + SSH key + local state (stops the billing)
#
# State (server id, ip, key) lives in ~/.agentbox/hub-test-vm/ on this host.
#
# HCLOUD_TOKEN is read from env, else .env.local, else ~/.agentbox/secrets.env.
#
# WARNING: the VM shares YOUR cloud provider accounts. Never run
# `agentbox prune --provider <cloud>` on it — after a reset its state.json is
# empty, so prune would treat *your laptop's* sandboxes as orphans and delete
# them. `reset` destroys the VM's own boxes by name instead.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="https://api.hetzner.cloud/v1"
STATE_DIR="$HOME/.agentbox/hub-test-vm"
STATE_FILE="$STATE_DIR/state.json"
KEY="$STATE_DIR/id_ed25519"
# The test account's GitHub PAT (NOT your own token) — see docs/hub-testing.md.
GH_TOKEN_FILE="${AGENTBOX_TEST_GH_TOKEN_FILE:-$STATE_DIR/gh-token}"
GIT_EMAIL="${AGENTBOX_TEST_GIT_EMAIL:-madawaldos@gmail.com}"
GIT_NAME="${AGENTBOX_TEST_GIT_NAME:-AgentBox Test}"
NAME="agentbox-hub-test"
SERVER_TYPE="${AGENTBOX_TESTVM_TYPE:-cx33}"
LOCATION="${AGENTBOX_TESTVM_LOCATION:-nbg1}"
IMAGE="ubuntu-24.04"
VAULT="/home/dev/testkit"
SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8 -o LogLevel=ERROR)

# Provider credentials copied into the vault. Mirrors PROVIDER_SECRET_KEYS in
# packages/sandbox-hetzner/src/control-plane-deploy.ts — the exact set the hub
# deploy carries to a control box. Never copy the whole secrets.env.
PROVIDER_KEYS=(
  HCLOUD_TOKEN HCLOUD_ENDPOINT
  E2B_API_KEY E2B_DOMAIN
  DAYTONA_API_KEY DAYTONA_JWT_TOKEN DAYTONA_ORGANIZATION_ID DAYTONA_API_URL DAYTONA_TARGET
  VERCEL_TOKEN VERCEL_OIDC_TOKEN VERCEL_TEAM_ID VERCEL_PROJECT_ID
  DIGITALOCEAN_TOKEN DIGITALOCEAN_API_URL
)
AGENT_CRED_FILES=(claude-credentials.json codex-credentials.json opencode-credentials.json)

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
ssh_dev_tty() { ssh -tt -i "$KEY" "${SSH_OPTS[@]}" "dev@$IP" "$@"; }
ssh_root() { ssh -i "$KEY" "${SSH_OPTS[@]}" "root@$IP" "$@"; }

# --- cloud-init: node 20 + docker + git + gh + tmux, non-root `dev` user ------
cloud_init() {
cat <<'EOF'
#cloud-config
package_update: true
runcmd:
  - curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  - apt-get install -y nodejs docker.io git tmux unzip rsync ca-certificates curl
  - install -d -m 755 /etc/apt/keyrings
  - curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
  - chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  - echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list
  - apt-get update
  - apt-get install -y gh
  - systemctl enable --now docker
  - id dev >/dev/null 2>&1 || useradd -m -s /bin/bash dev
  - usermod -aG docker dev
  - echo 'dev ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-dev
  - install -d -m 700 -o dev -g dev /home/dev/.ssh
  - install -d -m 700 -o dev -g dev /home/dev/testkit
  - install -d -m 755 -o dev -g dev /home/dev/projects
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
  body="$(node -e 'console.log(JSON.stringify({name:process.argv[1],server_type:process.argv[2],location:process.argv[3],image:process.argv[4],ssh_keys:[Number(process.argv[5])],user_data:process.argv[6],labels:{"agentbox.managed":"true","agentbox.role":"test-host"},public_net:{enable_ipv4:true,enable_ipv6:false}}))' "$NAME" "$SERVER_TYPE" "$LOCATION" "$IMAGE" "$key_id" "$(cloud_init)")"
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
  echo ">> waiting for cloud-init (node + docker + gh + dev user)"
  ssh -i "$KEY" "${SSH_OPTS[@]}" "root@$ip" 'cloud-init status --wait >/dev/null 2>&1 || true; until [ -f /var/lib/cloud/agentbox-ready ]; do sleep 3; done'
  echo ">> ready:"
  ssh -i "$KEY" "${SSH_OPTS[@]}" "root@$ip" 'echo "   node=$(node -v) docker=$(docker --version|cut -d, -f1) gh=$(gh --version|head -1)"'
  cmd_info
  echo ""
  echo "next: $0 creds   then   $0 install"
}

# --- credential vault ---------------------------------------------------------
# Everything the VM needs that must survive `rm -rf ~/.agentbox` lives in
# /home/dev/testkit. `apply_vault` copies it back into place.
build_secrets_env() {
  local src="$HOME/.agentbox/secrets.env"
  [[ -f "$src" ]] || die "no ~/.agentbox/secrets.env on this host — log into a provider first"
  local out="$1" k line
  : > "$out"
  for k in "${PROVIDER_KEYS[@]}"; do
    line="$(grep -E "^${k}=" "$src" | tail -1 || true)"
    [[ -n "$line" ]] && printf '%s\n' "$line" >> "$out"
  done
  [[ -s "$out" ]] || die "none of the provider keys were found in $src"
}

apply_vault() {
  # Re-seed ~/.agentbox + gh + git identity from the vault. Idempotent.
  ssh_dev bash -s <<EOF
set -e
mkdir -p ~/.agentbox
install -m 600 $VAULT/secrets.env ~/.agentbox/secrets.env
for f in $VAULT/agent-creds/*.json; do [ -e "\$f" ] || continue; install -m 600 "\$f" ~/.agentbox/\$(basename "\$f"); done
if [ -s $VAULT/gh-token ]; then
  gh auth login --with-token < $VAULT/gh-token
  gh auth setup-git
fi
git config --global user.email '$GIT_EMAIL'
git config --global user.name '$GIT_NAME'
git config --global init.defaultBranch main
echo "   secrets: \$(grep -c . ~/.agentbox/secrets.env) keys | gh: \$(gh api user -q .login 2>/dev/null || echo 'NOT LOGGED IN')"
EOF
}

cmd_creds() {
  require_vm
  local with_agent=1
  for a in "$@"; do [[ "$a" == "--no-agent-creds" ]] && with_agent=0; done

  local tmp; tmp="$(mktemp -d)"
  build_secrets_env "$tmp/secrets.env"
  echo ">> provider keys: $(cut -d= -f1 < "$tmp/secrets.env" | tr '\n' ' ')"

  mkdir -p "$tmp/agent-creds"
  if [[ "$with_agent" == "1" ]]; then
    local f
    for f in "${AGENT_CRED_FILES[@]}"; do
      [[ -f "$HOME/.agentbox/$f" ]] && cp "$HOME/.agentbox/$f" "$tmp/agent-creds/$f"
    done
    echo ">> agent logins: $(ls "$tmp/agent-creds" 2>/dev/null | tr '\n' ' ')"
  fi

  if [[ -s "$GH_TOKEN_FILE" ]]; then
    cp "$GH_TOKEN_FILE" "$tmp/gh-token"
  else
    : > "$tmp/gh-token"
    echo "!! no test-account GitHub token at $GH_TOKEN_FILE — gh will stay logged out."
    echo "   Create a PAT for the test account (repo + workflow scopes) and:"
    echo "     printf %s '<token>' > $GH_TOKEN_FILE && chmod 600 $GH_TOKEN_FILE && $0 creds"
  fi

  echo ">> uploading vault to $VAULT"
  ssh_dev "mkdir -p $VAULT/agent-creds && chmod 700 $VAULT $VAULT/agent-creds"
  scp -q -i "$KEY" "${SSH_OPTS[@]}" "$tmp/secrets.env" "$tmp/gh-token" "dev@$IP:$VAULT/"
  if compgen -G "$tmp/agent-creds/*.json" > /dev/null; then
    scp -q -i "$KEY" "${SSH_OPTS[@]}" "$tmp"/agent-creds/*.json "dev@$IP:$VAULT/agent-creds/"
  fi
  # Files 0600, dirs 0700 — chmod 600 on agent-creds/ would lock the next upload out.
  ssh_dev "chmod 600 $VAULT/secrets.env $VAULT/gh-token 2>/dev/null || true; chmod 600 $VAULT/agent-creds/* 2>/dev/null || true; chmod 700 $VAULT $VAULT/agent-creds"
  rm -rf "$tmp"

  echo ">> applying vault"
  apply_vault
}

cmd_install() {
  require_vm
  local tag="${1:-nightly}"
  echo ">> npm i -g @madarco/agentbox@$tag"
  ssh_dev "sudo npm install -g --no-fund --no-audit @madarco/agentbox@$tag && agentbox --version"
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
  scp -q -i "$KEY" "${SSH_OPTS[@]}" "$tmp/$tarball" "dev@$IP:/home/dev/$tarball"
  ssh_dev "sudo npm install -g --no-fund --no-audit /home/dev/$tarball && rm -f /home/dev/$tarball && echo \"installed agentbox \$(agentbox --version)\""
  rm -rf "$tmp"
}

cmd_testrepo() {
  require_vm
  local repo="${1:-agentbox-hubtest}"
  ssh_dev bash -s <<EOF
set -e
gh auth status >/dev/null 2>&1 || { echo "gh is not logged in — run \`$0 creds\` with a token first" >&2; exit 1; }
owner=\$(gh api user -q .login)
cd ~/projects
if [ -d "$repo/.git" ]; then echo ">> ~/projects/$repo already exists"; cd "$repo"; git pull --ff-only || true; exit 0; fi
if gh repo view "\$owner/$repo" >/dev/null 2>&1; then
  gh repo clone "\$owner/$repo" "$repo"
  echo ">> cloned \$owner/$repo"
  exit 0
fi
mkdir "$repo" && cd "$repo"
git init -q
printf '# %s\n\nTiny non-LFS repo for AgentBox hub tests.\n' "$repo" > README.md
cat > agentbox.yaml <<'YAML'
version: 1
services:
  web:
    command: python3 -m http.server 8080
    ready_when:
      port: 8080
    expose:
      port: 8080
      as: 80
YAML
git add -A
git commit -qm "init test repo"
gh repo create "$repo" --private --source=. --push
echo ">> created \$owner/$repo and cloned at ~/projects/$repo"
EOF
}

# Delete the control box this VM deployed (ids read from its own deploy.json),
# never anything else — the label `agentbox.role=control-plane` is also worn by
# a control box deployed from your laptop.
destroy_test_control_box() {
  local rec sid fid
  rec="$(ssh_dev 'cat ~/.agentbox/control-plane/deploy.json 2>/dev/null || true')"
  [[ -n "$rec" ]] || { echo ">> no control box deployed from the VM"; return 0; }
  sid="$(printf '%s' "$rec" | jget serverId)"
  fid="$(printf '%s' "$rec" | jget firewallId)"
  resolve_token
  if [[ -n "$sid" ]]; then
    echo ">> deleting the VM's control box (server $sid, ip $(printf '%s' "$rec" | jget ip))"
    api DELETE "/servers/$sid" >/dev/null 2>&1 || echo "   (server already gone)"
  fi
  # The firewall can't be deleted while it is still applied to the dying server.
  if [[ -n "$fid" ]]; then
    local i code
    for i in 1 2 3 4 5 6; do
      code="$(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "Authorization: Bearer $HCLOUD_TOKEN" "$API/firewalls/$fid")"
      if [[ "$code" == "204" || "$code" == "404" ]]; then echo "   firewall $fid gone"; return 0; fi
      sleep 5
    done
    echo "   (firewall $fid still in use — delete it from the Hetzner console)"
  fi
}

cmd_reset() {
  require_vm
  local keep_hub=0
  for a in "$@"; do [[ "$a" == "--keep-hub" ]] && keep_hub=1; done

  echo ">> destroying the VM's boxes"
  # By name, not `prune` — prune on a wiped state.json would treat your laptop's
  # cloud sandboxes as orphans.
  ssh_dev 'command -v agentbox >/dev/null || exit 0
    names=$(agentbox ls -g -j 2>/dev/null | node -e "let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>{try{for(const b of JSON.parse(s))if(b.name)console.log(b.name)}catch{}})" || true)
    for n in $names; do echo "   destroy $n"; agentbox destroy "$n" -y >/dev/null 2>&1 || echo "   (failed: $n)"; done'

  [[ "$keep_hub" == "1" ]] || destroy_test_control_box

  echo ">> wiping ~/.agentbox (and stopping the local hub/relay)"
  # `[a]gentbox-relay`: a plain pattern also matches the ssh command line running
  # it, so pkill kills its own session and the reset aborts half-done.
  ssh_dev 'agentbox hub stop >/dev/null 2>&1 || true; agentbox relay stop >/dev/null 2>&1 || true; pkill -f "[a]gentbox-relay" >/dev/null 2>&1 || true; rm -rf ~/.agentbox'

  echo ">> re-applying the vault"
  apply_vault
  echo ">> clean. agentbox: $(ssh_dev 'agentbox --version 2>/dev/null || echo not-installed')"
}

cmd_ssh() {
  require_vm
  if [[ "${1:-}" == "--" ]]; then shift; ssh_dev_tty "$@"; else ssh_dev_tty "$@"; fi
}

# Long commands must not die with the ssh session: `nohup … &` over ssh loses the
# CLI's docker children mid-pull. tmux is the reliable detach.
cmd_run() {
  require_vm
  [[ $# -gt 0 ]] || die "usage: $0 run '<command>'"
  local session="${AGENTBOX_TESTVM_SESSION:-work}"
  local proj="${AGENTBOX_TESTVM_PROJECT:-agentbox-hubtest}"
  ssh_dev "tmux kill-session -t $session 2>/dev/null; tmux new -d -s $session 'cd ~/projects/$proj && $*'"
  echo ">> running in tmux session '$session' (cwd ~/projects/$proj)"
  echo "   follow: $0 log      attach: $0 ssh -- tmux attach -t $session"
}

cmd_log() {
  require_vm
  ssh_dev_tty "tail -f ~/.agentbox/logs/${1:-latest.log}"
}

cmd_info() {
  [[ -f "$STATE_FILE" ]] || { echo "no VM (state file absent)"; return 0; }
  IP="$(state_get ip)"
  echo "server_id : $(state_get server_id)"
  echo "ip        : $IP"
  echo "ssh       : ssh -i $KEY dev@$IP"
  echo "state     : $STATE_FILE"
  echo "gh token  : $([[ -s "$GH_TOKEN_FILE" ]] && echo "present ($GH_TOKEN_FILE)" || echo "MISSING ($GH_TOKEN_FILE)")"
  ssh_dev 'echo "vault     : $(ls ~/testkit 2>/dev/null | tr "\n" " ")"; echo "agentbox  : $(agentbox --version 2>/dev/null || echo not-installed)"; echo "hub url   : $(agentbox config get relay.controlPlaneUrl 2>/dev/null || echo none)"' 2>/dev/null || true
}

cmd_down() {
  resolve_token
  [[ -f "$STATE_FILE" ]] || { echo "no VM to delete"; return 0; }
  IP="$(state_get ip)"
  destroy_test_control_box || true
  local sid kid; sid="$(state_get server_id)"; kid="$(state_get ssh_key_id)"
  echo ">> deleting server $sid + ssh key $kid"
  [[ -n "$sid" ]] && api DELETE "/servers/$sid" >/dev/null 2>&1 || true
  [[ -n "$kid" ]] && api DELETE "/ssh_keys/$kid" >/dev/null 2>&1 || true
  rm -rf "$STATE_DIR"
  echo ">> done"
}

case "${1:-}" in
  up) shift; cmd_up "$@" ;;
  creds) shift; cmd_creds "$@" ;;
  install) shift; cmd_install "$@" ;;
  deploy) shift; cmd_deploy "$@" ;;
  testrepo) shift; cmd_testrepo "$@" ;;
  reset) shift; cmd_reset "$@" ;;
  ssh) shift; cmd_ssh "$@" ;;
  run) shift; cmd_run "$@" ;;
  log) shift; cmd_log "$@" ;;
  info) shift; cmd_info "$@" ;;
  down) shift; cmd_down "$@" ;;
  *) echo "usage: $0 {up|creds|install|deploy|testrepo|reset|ssh|run|log|info|down} [args]" >&2; exit 2 ;;
esac
