// Backend error strings a route maps to a specific status. Kept free of imports:
// a route that pulled them from a backend slice would bundle @agentbox/relay (and
// its dynamic cloud-provider imports) into the Next route, which cannot resolve them.

/**
 * A host with no tmux cannot run the tmux carrier: 503, not a bad request.
 * Still the refusal for the paths that are tmux by nature — the Claude
 * background attach, and typing into a detected session's pane.
 */
export const TMUX_MISSING =
  'tmux is not installed on the hub host; that session lives in a tmux session (brew install tmux)';

/**
 * Neither carrier can run here: no pty host in this install (the optional
 * terminal prebuild is missing) and no tmux to fall back to.
 */
export const MANAGER_CARRIER_MISSING =
  'this host cannot run a manager session: no pty host in this AgentBox install, and tmux is not installed to fall back to (brew install tmux)';

/** `manager.carrier: pty` was asked for by name, and this install has no pty host. */
export const PTY_CARRIER_MISSING =
  'manager.carrier is set to pty, but this AgentBox install has no pty host (the optional terminal prebuild is missing); set manager.carrier to auto or tmux';
