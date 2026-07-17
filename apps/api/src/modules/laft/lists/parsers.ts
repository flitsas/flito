// Helpers compartidos para parser CSV y extracción de nodos XML simples.
// XML: usamos regex porque las listas UN/EU tienen estructura plana sin nesting profundo
// y agregar una librería de parsing por una decena de tags no se justifica.

export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      out.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function parseCsv(content: string, options: { headerRow?: boolean } = {}): { headers: string[]; rows: string[][] } {
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = options.headerRow !== false ? parseCsvLine(lines[0]) : [];
  const startIdx = options.headerRow !== false ? 1 : 0;
  const rows: string[][] = [];
  for (let i = startIdx; i < lines.length; i++) {
    rows.push(parseCsvLine(lines[i]));
  }
  return { headers, rows };
}

/** Devuelve el contenido de un tag (primera ocurrencia). Sin atributos, sin namespaces. */
export function getXmlText(block: string, tagName: string): string | null {
  const re = new RegExp(`<${escapeRe(tagName)}(?:\\s[^>]*)?>([^<]*)</${escapeRe(tagName)}>`, 'i');
  const m = block.match(re);
  return m ? decodeXmlEntities(m[1].trim()) : null;
}

/** Devuelve TODAS las ocurrencias del texto de un tag dentro del bloque. */
export function getXmlAllTexts(block: string, tagName: string): string[] {
  const re = new RegExp(`<${escapeRe(tagName)}(?:\\s[^>]*)?>([^<]*)</${escapeRe(tagName)}>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) out.push(decodeXmlEntities(m[1].trim()));
  return out;
}

/** Extrae todos los bloques `<TAG>...</TAG>` del XML completo. */
export function extractXmlBlocks(xml: string, tagName: string): string[] {
  const re = new RegExp(`<${escapeRe(tagName)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeRe(tagName)}>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
}
