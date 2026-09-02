import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildVncUrls, generateVncPassword, VNC_CONTAINER_PORT } from '../src/vnc.js';

describe('generateVncPassword', () => {
  it('returns exactly 8 characters', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateVncPassword()).toHaveLength(8);
    }
  });

  it('uses only [A-Za-z0-9]', () => {
    const alphabet = /^[A-Za-z0-9]+$/;
    for (let i = 0; i < 50; i++) {
      expect(generateVncPassword()).toMatch(alphabet);
    }
  });

  it('produces distinct values across calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(generateVncPassword());
    // 50 samples from 62^8 ≈ 218 trillion → collisions are astronomically unlikely.
    expect(seen.size).toBe(50);
  });
});

describe('buildVncUrls', () => {
  const enabledRecord = {
    container: 'agentbox-foo',
    vncEnabled: true,
    vncHostPort: 54321,
    vncContainerPort: VNC_CONTAINER_PORT,
    vncPassword: 'aB3xZ9Q1',
  };

  it('returns {} when VNC is disabled', () => {
    expect(buildVncUrls({ ...enabledRecord, vncEnabled: false }, 'orbstack')).toEqual({});
  });

  it('returns {} when the password is missing (mid-create or stale record)', () => {
    expect(buildVncUrls({ ...enabledRecord, vncPassword: undefined }, 'orbstack')).toEqual({});
  });

  it('produces an orb.local URL on orbstack', () => {
    const urls = buildVncUrls(enabledRecord, 'orbstack');
    expect(urls.orbUrl).toBe(
      'http://agentbox-foo.orb.local:6080/vnc.html?autoconnect=1&password=aB3xZ9Q1',
    );
  });

  it('omits the orb.local URL off orbstack', () => {
    expect(buildVncUrls(enabledRecord, 'docker-desktop').orbUrl).toBeUndefined();
    expect(buildVncUrls(enabledRecord, 'other').orbUrl).toBeUndefined();
  });

  it('produces a loopback URL whenever vncHostPort is known', () => {
    expect(buildVncUrls(enabledRecord, 'orbstack').loopbackUrl).toBe(
      'http://127.0.0.1:54321/vnc.html?autoconnect=1&password=aB3xZ9Q1',
    );
    expect(buildVncUrls(enabledRecord, 'docker-desktop').loopbackUrl).toBe(
      'http://127.0.0.1:54321/vnc.html?autoconnect=1&password=aB3xZ9Q1',
    );
  });

  it('omits the loopback URL when host port is unknown', () => {
    expect(
      buildVncUrls({ ...enabledRecord, vncHostPort: undefined }, 'orbstack').loopbackUrl,
    ).toBeUndefined();
  });

  it('URL-encodes the password so query string special chars stay safe', () => {
    // generateVncPassword sticks to [A-Za-z0-9], but the field is plain text
    // on BoxRecord and could be hand-edited; guard against future breakage.
    const urls = buildVncUrls({ ...enabledRecord, vncPassword: 'a&b=c d' }, 'orbstack');
    expect(urls.orbUrl).toContain('password=a%26b%3Dc%20d');
  });
});

describe('agentbox-vnc-start ~/.jwmrc generation', () => {
  const script = readFileSync(
    fileURLToPath(new URL('../scripts/agentbox-vnc-start', import.meta.url)),
    'utf8',
  );
  const jwmrc = script.slice(
    script.indexOf('cat > "$HOME/.jwmrc" <<JWMRC'),
    script.indexOf('\nJWMRC\n'),
  );

  it('has a body to check', () => {
    expect(jwmrc).toContain('<Tray valign="bottom"');
    expect(jwmrc).toContain('$browser_button');
  });

  it('never command-substitutes inside the config body', () => {
    // The delimiter is unquoted so the config can interpolate the paths probed
    // on the box, which means a backtick or $(...) anywhere in the body — an
    // XML comment included — is a command bash runs at VNC start. One that
    // blocks (a comment once held `xterm -name agentbox-launch`) hangs the
    // heredoc, and with it Xvnc's whole startup: no window manager, no
    // websockify, no desktop.
    expect(jwmrc).not.toContain('`');
    expect(jwmrc).not.toContain('$(');
  });

  it('dresses the window chrome in the wallpaper palette', () => {
    // The focused titlebar is the wallpaper's own paper colour, the same one
    // the dock paints, so a window's chrome belongs to the desktop behind it.
    const style = jwmrc.slice(jwmrc.indexOf('<WindowStyle'), jwmrc.indexOf('</WindowStyle>'));
    const backgrounds = style.match(/<Background>#[0-9a-f]{6}<\/Background>/g) ?? [];
    expect(backgrounds).toEqual([
      '<Background>#e9e7e4</Background>', // unfocused: the next grey down
      '<Background>#f5f3f0</Background>', // focused: the wallpaper's paper
    ]);
  });

  it('leaves the browser and the progress window undecorated', () => {
    // A titlebar on an always-maximized browser is ~30px of an 800px-tall
    // desktop spent repeating the title the tab strip already shows, and the
    // progress window is a status card, not a window to manage. Each WM_CLASS
    // spelling needs its own Group, so all three browser groups must carry it.
    const groups = jwmrc.match(/<Group>[\s\S]*?<\/Group>/g) ?? [];
    const undecorated = ['agentbox-launch', 'Chromium-browser', 'Chromium', 'Google-chrome'];
    for (const name of undecorated) {
      const group = groups.find((g) => g.includes(`>${name}<`));
      expect(group, name).toBeDefined();
      expect(group, name).toContain('<Option>notitle</Option>');
      expect(group, name).toContain('<Option>noborder</Option>');
    }
  });

  it('writes the desktop launcher from a quoted heredoc', () => {
    // The launcher is bash of its own, full of $vars and $(...) that must reach
    // the file intact.
    expect(script).toContain(`cat > "$DESKTOP_LAUNCHER" <<'LAUNCHER'`);
  });
});

describe('agentbox-vnc-start desktop launcher', () => {
  const script = readFileSync(
    fileURLToPath(new URL('../scripts/agentbox-vnc-start', import.meta.url)),
    'utf8',
  );
  const launcher = script.slice(
    script.indexOf(`cat > "$DESKTOP_LAUNCHER" <<'LAUNCHER'`),
    script.indexOf('\nLAUNCHER\n'),
  );

  it('opens the desktop terminal light, with a palette to match', () => {
    // Paper background over the wallpaper, and its own sixteen colours: xterm's
    // defaults are picked for a black background, where bright white on paper
    // is invisible.
    expect(script).toContain('-bg "#f5f3f0" -fg "#1d1e20"');
    const colors = script.match(/-xrm XTerm\.vt100\.color\d+:#[0-9a-f]{6}/g) ?? [];
    expect(colors).toHaveLength(16);
  });

  it('takes a per-session lock so two launches cannot race', () => {
    expect(launcher).toContain('flock -n 9');
  });

  it('closes the lock fd on every agent-browser call', () => {
    // The browser is a daemon that outlives the launcher: inheriting fd 9 keeps
    // the lock held for as long as the daemon lives, and every later launch then
    // finds it taken and exits silently — a dock button that stops working.
    const calls = launcher.match(/agent-browser --session "\$session" open --headed[^\n]*/g);
    expect(calls).toHaveLength(2);
    for (const call of calls ?? []) expect(call).toContain('9>&-');
  });

  it('places itself low on the screen with the window ops enabled', () => {
    // The window sits three quarters down so the wallpaper logo stays visible
    // behind it, and re-centres from its own measurements because the desktop
    // can be any size (a noVNC viewer can resize it). Both the queries and the
    // move are xterm window ops, which do nothing unless allowWindowOps is set.
    expect(launcher).toContain('-xrm "XTerm*allowWindowOps:true"');
    expect(launcher).toContain('\\033[15t'); // screen size
    expect(launcher).toContain('\\033[14t'); // own text-area size
    expect(launcher).toContain('\\033[3;%d;%dt'); // move
    expect(launcher).toContain('$(( sh * 3 / 4 - wh / 2 ))');
    expect(launcher).toContain('$(( (sw - ww) / 2 ))');
  });
});
