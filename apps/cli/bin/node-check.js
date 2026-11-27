// Loaded by bin/agentbox.js BEFORE the real bundle. Keep this file to syntax
// every Node from 14 up parses (no optional chaining, no `??`, no top-level
// await, no imports): it is what turns "too old a Node" into one readable line
// instead of a SyntaxError or ERR_REQUIRE_ESM from deep inside a dependency.

// The real floor: the e2b SDK `require()`s ESM-only chalk (needs require(esm),
// unflagged in 22.12), and the hub every command goes through needs node:sqlite
// (22.5+). Keep in sync with package.json `engines.node`.
export var MIN_NODE = '22.12.0';

function parse(v) {
  var parts = String(v).replace(/^v/, '').split('.');
  return [Number(parts[0]) || 0, Number(parts[1]) || 0, Number(parts[2]) || 0];
}

/** True when `version` is at least `min` (both "x.y.z", optional leading v). */
export function nodeSatisfies(version, min) {
  var a = parse(version);
  var b = parse(min || MIN_NODE);
  for (var i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

/** The message to print when `version` is too old, or null when it is fine. */
export function nodeVersionProblem(version) {
  if (nodeSatisfies(version, MIN_NODE)) return null;
  var major = parse(MIN_NODE)[0];
  return (
    'agentbox needs Node.js ' +
    MIN_NODE +
    ' or newer, but this is Node.js ' +
    String(version).replace(/^v/, '') +
    '.\n' +
    'Upgrade Node, then reinstall agentbox:\n' +
    '  nvm install ' +
    major +
    ' && nvm use ' +
    major +
    '   (or the installer from https://nodejs.org)\n' +
    '  npm install -g @madarco/agentbox\n'
  );
}
