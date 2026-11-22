/**
 * Read `name` and `description` from a SKILL.md YAML frontmatter block. Just
 * enough YAML for those two scalars: plain, quoted, and folded/literal block
 * values (`description: >`), which real skills use.
 */
export interface SkillFrontmatter {
  name?: string;
  description?: string;
}

function unquote(v: string): string {
  const t = v.trim();
  if (
    t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

export function parseSkillFrontmatter(text: string): SkillFrontmatter | null {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) return null;
  const body = lines.slice(1, end);
  const out: SkillFrontmatter = {};
  for (let i = 0; i < body.length; i++) {
    const m = /^(name|description):\s*(.*)$/.exec(body[i]!);
    if (!m) continue;
    const key = m[1] as 'name' | 'description';
    let value = m[2]!;
    if (/^[>|][+-]?\s*$/.test(value)) {
      const parts: string[] = [];
      while (i + 1 < body.length && (/^\s+\S/.test(body[i + 1]!) || body[i + 1]!.trim() === '')) {
        parts.push(body[++i]!.trim());
      }
      value = parts.filter((p) => p.length > 0).join(value.startsWith('|') ? '\n' : ' ');
    } else {
      value = unquote(value);
    }
    out[key] = value;
  }
  return out;
}
