import { defineDocs, defineConfig } from 'fumadocs-mdx/config';
import { rehypeCodeDefaultOptions } from 'fumadocs-core/mdx-plugins';

// `.md` and `.mdx` sources under content/docs are the public docs.
export const docs = defineDocs({
  dir: 'content/docs',
});

// Terminal *session* fences render as the dark "terminal" card (see global.css).
// Matches the mockup: plain commands (```bash) stay light code cards; an
// interactive transcript (```console / ```ansi) becomes the black terminal.
const terminalLangs = new Set([
  'console',
  'shell-session',
  'shellsession',
  'ansi',
]);

export default defineConfig({
  mdxOptions: {
    rehypeCodeOptions: {
      ...rehypeCodeDefaultOptions,
      transformers: [
        ...(rehypeCodeDefaultOptions.transformers ?? []),
        {
          name: 'agb-terminal-flag',
          pre(node) {
            if (terminalLangs.has(this.options.lang)) {
              node.properties['data-terminal'] = '';
            }
            // Box-drawing / block-element art (the Claude Code welcome panel)
            // needs a font that renders those glyphs at a single cell width —
            // IBM Plex Mono lacks them and falls back per-glyph, breaking
            // alignment. Flag such blocks so the CSS swaps in a system mono.
            if (/[─-▟]/.test(this.source)) {
              node.properties['data-monoart'] = '';
            }
          },
        },
      ],
    },
  },
});
