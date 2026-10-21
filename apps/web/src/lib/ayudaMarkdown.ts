// Parser mínimo de Markdown → AST. Sin HTML embebido, sin imágenes, sin tablas. Avisos `> [!TIPO]` (HU #13706).
// El renderer (AyudaMarkdown) solo crea elementos React: cero dangerouslySetInnerHTML.

export type MdInline =
  | { type: 'text'; value: string }
  | { type: 'strong'; children: MdInline[] }
  | { type: 'code'; value: string }
  | { type: 'a'; href: string; children: MdInline[] };

export type MdBlock =
  | { type: 'h1' | 'h2' | 'h3'; id: string; children: MdInline[] }
  | { type: 'p'; children: MdInline[] }
  | { type: 'ul'; items: MdInline[][] }
  | { type: 'ol'; items: MdInline[][] }
  | { type: 'pre'; lang: string; code: string }
  // HU #13706 (diseño slim §7 · UX HU-4): `> [!NOTA|IMPORTANTE|PRECAUCION]` en la 1.ª línea del bloque
  // `>`. Cada párrafo del cuerpo (separado por una línea `>` vacía) es un `MdInline[]`.
  | { type: 'callout'; tipo: TipoAviso; parrafos: MdInline[][] }
  // `> texto` o `> [!OTRO] …`: cita simple, texto tal cual (AC2). Nunca HTML.
  | { type: 'quote'; parrafos: MdInline[][] };

export type TipoAviso = 'nota' | 'importante' | 'precaucion';

const AVISO = /^\[!(NOTA|IMPORTANTE|PRECAUCION)\]\s*(.*)$/;

function esCita(line: string): boolean {
  return line.startsWith('>');
}

/** Bloque `>` ya sin el marcador → aviso (tipo conocido en la 1.ª línea) o cita simple. */
function bloqueDeCita(lineas: string[]): MdBlock {
  const m = AVISO.exec(lineas[0].trim());
  const cuerpo = m ? [m[2], ...lineas.slice(1)] : lineas;
  const parrafos: MdInline[][] = [];
  let actual: string[] = [];
  const cerrar = (): void => {
    if (actual.length) parrafos.push(parseInline(actual.join(' ')));
    actual = [];
  };
  for (const l of cuerpo) {
    if (l.trim()) actual.push(l.trim());
    else cerrar();
  }
  cerrar();
  if (m) return { type: 'callout', tipo: m[1].toLowerCase() as TipoAviso, parrafos };
  return { type: 'quote', parrafos };
}

/** Texto visible de una línea inline (sin marcas). Base de las anclas y de la tabla de contenido. */
export function textoPlano(nodes: MdInline[]): string {
  return nodes.map((n) => (n.type === 'text' || n.type === 'code' ? n.value : textoPlano(n.children))).join('');
}

/**
 * Ancla de un encabezado (Feature #13691 · HU #13705, diseño slim §4). Contrato hacia Dr. Flit:
 * `/flito/ayuda/<clave>#<ancla>`. Solo depende del texto: NFD, sin diacríticos, minúsculas,
 * `[^a-z0-9]+` → `-`, sin `-` en los extremos; vacío → `seccion`. Los repetidos los numera
 * `parseMarkdown` (`x`, `x-2`, `x-3`…), en orden de aparición.
 */
export function anclaDeEncabezado(texto: string): string {
  const slug = texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'seccion';
}

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
  const usadas = new Map<string, number>();
  let i = 0;

  const encabezado = (type: 'h1' | 'h2' | 'h3', raw: string): MdBlock => {
    const children = parseInline(raw);
    const base = anclaDeEncabezado(textoPlano(children));
    const n = (usadas.get(base) ?? 0) + 1;
    usadas.set(base, n);
    return { type, id: n === 1 ? base : `${base}-${n}`, children };
  };

  const tomarParrafo = (primera: string): MdInline[] => {
    const partes = [primera];
    while (i < lines.length) {
      const n = lines[i];
      if (!n.trim() || n.startsWith('#') || esUl(n) || esOl(n) || n.startsWith('```') || esTabla(n) || esCita(n)) break;
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

    if (esCita(line)) {
      const lineas = [line.replace(/^> ?/, '')];
      while (i < lines.length && esCita(lines[i])) {
        lineas.push(lines[i].replace(/^> ?/, ''));
        i += 1;
      }
      blocks.push(bloqueDeCita(lineas));
      continue;
    }

    if (esTabla(line)) {
      const celdas = line.split('|').map((c) => c.trim()).filter(Boolean);
      blocks.push({ type: 'p', children: parseInline(celdas.join(' · ')) });
      while (i < lines.length && esTabla(lines[i])) i += 1;
      continue;
    }

    if (line.startsWith('### ')) {
      blocks.push(encabezado('h3', line.slice(4)));
      continue;
    }
    if (line.startsWith('## ')) {
      blocks.push(encabezado('h2', line.slice(3)));
      continue;
    }
    if (line.startsWith('# ')) {
      blocks.push(encabezado('h1', line.slice(2)));
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
