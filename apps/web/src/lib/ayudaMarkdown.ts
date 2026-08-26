// Parser mínimo de Markdown → AST. Sin HTML embebido, sin imágenes, sin tablas.
// El renderer (AyudaMarkdown) solo crea elementos React: cero dangerouslySetInnerHTML.

export type MdInline =
  | { type: 'text'; value: string }
  | { type: 'strong'; children: MdInline[] }
  | { type: 'code'; value: string }
  | { type: 'a'; href: string; children: MdInline[] };

export type MdBlock =
  | { type: 'h1' | 'h2' | 'h3'; children: MdInline[] }
  | { type: 'p'; children: MdInline[] }
  | { type: 'ul'; items: MdInline[][] }
  | { type: 'ol'; items: MdInline[][] }
  | { type: 'pre'; lang: string; code: string };

const HREF_OK = /^(https?:\/\/|\/)/i;

export function hrefPermitido(href: string): boolean {
  if (!HREF_OK.test(href)) return false;
  if (href.startsWith('/api/') || href.includes('/api/')) return false;
  const lower = href.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('vbscript:')) {
    return false;
  }
  return true;
}

export function parseInline(raw: string): MdInline[] {
  const out: MdInline[] = [];
  let i = 0;
  let buf = '';

  const flush = (): void => {
    if (buf) {
      out.push({ type: 'text', value: buf });
      buf = '';
    }
  };

  while (i < raw.length) {
    if (raw.startsWith('![', i)) {
      const cierre = raw.indexOf(']', i + 2);
      const paren = cierre >= 0 && raw[cierre + 1] === '(' ? raw.indexOf(')', cierre + 2) : -1;
      if (cierre >= 0 && paren > cierre) {
        flush();
        const alt = raw.slice(i + 2, cierre);
        if (alt) out.push({ type: 'text', value: alt });
        i = paren + 1;
        continue;
      }
    }

    if (raw[i] === '`' ) {
      const end = raw.indexOf('`', i + 1);
      if (end > i) {
        flush();
        out.push({ type: 'code', value: raw.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (raw.startsWith('**', i)) {
      const end = raw.indexOf('**', i + 2);
      if (end > i + 1) {
        flush();
        out.push({ type: 'strong', children: parseInline(raw.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }

    if (raw[i] === '[') {
      const cierre = raw.indexOf(']', i + 1);
      if (cierre > i && raw[cierre + 1] === '(') {
        const paren = raw.indexOf(')', cierre + 2);
        if (paren > cierre) {
          const texto = raw.slice(i + 1, cierre);
          const href = raw.slice(cierre + 2, paren).trim();
          flush();
          if (hrefPermitido(href)) {
            out.push({ type: 'a', href, children: parseInline(texto) });
          } else {
            out.push(...parseInline(texto));
          }
          i = paren + 1;
          continue;
        }
      }
    }

    buf += raw[i];
    i += 1;
  }
  flush();
  return out;
}

function esTabla(line: string): boolean {
  return line.trimStart().startsWith('|');
}

function esUl(line: string): boolean {
  return /^[-*] /.test(line);
}

function esOl(line: string): boolean {
  return /^\d+\. /.test(line);
}

export function parseMarkdown(source: string): MdBlock[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let i = 0;

  const tomarParrafo = (primera: string): MdInline[] => {
    const partes = [primera];
    while (i < lines.length) {
      const n = lines[i];
      if (!n.trim() || n.startsWith('#') || esUl(n) || esOl(n) || n.startsWith('```') || esTabla(n)) break;
      partes.push(n);
      i += 1;
    }
    return parseInline(partes.join(' '));
  };

  while (i < lines.length) {
    const line = lines[i];
    i += 1;

    if (!line.trim()) continue;

    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const body: string[] = [];
      while (i < lines.length && !lines[i].startsWith('```')) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length && lines[i].startsWith('```')) i += 1;
      blocks.push({ type: 'pre', lang, code: body.join('\n') });
      continue;
    }

    if (esTabla(line)) {
      const celdas = line.split('|').map((c) => c.trim()).filter(Boolean);
      blocks.push({ type: 'p', children: parseInline(celdas.join(' · ')) });
      while (i < lines.length && esTabla(lines[i])) i += 1;
      continue;
    }

    if (line.startsWith('### ')) {
      blocks.push({ type: 'h3', children: parseInline(line.slice(4)) });
      continue;
    }
    if (line.startsWith('## ')) {
      blocks.push({ type: 'h2', children: parseInline(line.slice(3)) });
      continue;
    }
    if (line.startsWith('# ')) {
      blocks.push({ type: 'h1', children: parseInline(line.slice(2)) });
      continue;
    }

    if (esUl(line)) {
      const items = [parseInline(line.replace(/^[-*] /, ''))];
      while (i < lines.length && esUl(lines[i])) {
        items.push(parseInline(lines[i].replace(/^[-*] /, '')));
        i += 1;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    if (esOl(line)) {
      const items = [parseInline(line.replace(/^\d+\. /, ''))];
      while (i < lines.length && esOl(lines[i])) {
        items.push(parseInline(lines[i].replace(/^\d+\. /, '')));
        i += 1;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }

    blocks.push({ type: 'p', children: tomarParrafo(line) });
  }

  return blocks;
}
