/**
 * The "Next steps" guide printed at the end of `agentbox install`.
 *
 * Written for the default macOS Terminal profile (black on white, 80x24): body
 * text stays in the terminal's default foreground (clack's `note` dims it, which
 * is near-illegible on white), colour is limited to bold accents, and nothing is
 * wider than the terminal. Below the box's width it drops to plain indented
 * lines rather than letting the borders wrap.
 */

const ESC = '\x1b[';
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Visible width of a line (ANSI stripped; the guide is ASCII plus box glyphs). */
export function visibleWidth(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

export interface GuideOptions {
  /** Provider the wizard set up; the guide always names it, default or not. */
  provider: string;
  /** Terminal width; undefined (not a TTY) falls back to 80. */
  columns?: number | undefined;
  /** Emit ANSI bold/colour. */
  color: boolean;
}

interface Row {
  /** Left column (a command or keystroke), indented by `depth`. */
  cmd: string;
  depth: number;
  desc: string;
}

function rows(provider: string): Row[] {
  return [
    { cmd: 'cd your-project/', depth: 0, desc: '' },
    { cmd: `agentbox ${provider} claude`, depth: 0, desc: 'start a box (or codex, opencode)' },
    { cmd: 'Setup wizard? Yes', depth: 1, desc: 'installs deps, writes agentbox.yaml' },
    { cmd: 'Ctrl+a d', depth: 1, desc: 'detach; claude keeps running' },
    { cmd: 'agentbox attach', depth: 0, desc: 'go back to it later' },
    { cmd: 'agentbox install', depth: 0, desc: 'set up another provider' },
  ];
}

/** The guide's content lines, without any frame. */
function contentLines(o: GuideOptions): string[] {
  const bold = (s: string): string => (o.color ? `${ESC}1m${s}${ESC}22m` : s);
  const rs = rows(o.provider);
  const left = (r: Row): string => '  '.repeat(r.depth) + r.cmd;
  const colW = Math.max(...rs.map((r) => left(r).length)) + 3;
  return [
    'Get started:',
    ...rs.map((r) => {
      const l = left(r);
      // Commands in bold; the descriptions stay in the default foreground.
      const shown = r.depth === 0 ? bold(r.cmd) : l;
      return r.desc ? `  ${shown}${' '.repeat(colW - l.length)}${r.desc}` : `  ${shown}`;
    }),
    '',
    // Two lines so the longest provider name still fits the 80-column box.
    `Or ask your agent to launch an agentbox in ${o.provider}`,
    `using the ${bold('/agentbox')} skill.`,
  ];
}

/**
 * Render the guide as one string (trailing newline included). Boxed in the
 * clack gutter style when it fits in `columns`, plain lines otherwise.
 */
export function renderNextSteps(o: GuideOptions): string {
  const cols = o.columns && o.columns > 0 ? o.columns : 80;
  const lines = contentLines(o);
  const title = 'Next steps';
  const bold = (s: string): string => (o.color ? `${ESC}1m${s}${ESC}22m` : s);
  const inner = Math.max(...lines.map(visibleWidth), title.length) + 2;
  // "│  " + content padded to `inner` + "│"
  const boxWidth = 3 + inner + 1;

  if (boxWidth > cols) {
    return ['│', `◇  ${bold(title)}`, ...lines.map((l) => `│  ${l}`), ''].join('\n');
  }
  const pad = (l: string): string => l + ' '.repeat(inner - visibleWidth(l));
  const out = [
    '│',
    `◇  ${bold(title)} ${'─'.repeat(inner - title.length - 1)}╮`,
    `│  ${pad('')}│`,
    ...lines.map((l) => `│  ${pad(l)}│`),
    `│  ${pad('')}│`,
    `├${'─'.repeat(inner + 2)}╯`,
    '',
  ];
  return out.join('\n');
}
