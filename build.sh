#!/bin/sh
# AgentBox Herdr plugin bootstrap — runs during `herdr plugin install`.
# (Local installs via `agentbox install herdr` set things up directly instead.)
AGB="$(command -v agentbox || true)"
if [ -z "$AGB" ]; then
  echo "AgentBox CLI not found — the Herdr plugin is installed but inert."
  echo "Install it and finish setup:"
  echo "  npm i -g @madarco/agentbox && agentbox install herdr"
  exit 0
fi
"$AGB" install herdr --plugin-keys || \
  echo "AgentBox plugin setup hit an issue; finish with: agentbox install herdr"
exit 0
