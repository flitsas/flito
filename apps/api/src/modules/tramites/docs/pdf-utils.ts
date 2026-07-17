// Utilidades compartidas para generación PDF traspaso (port CEA transitos.cjs).

export const SANITIZE_WINANSI: Record<string, string> = {
  '—': '-', '–': '-', '−': '-', '\u201C': '"', '\u201D': '"', '\u2018': "'", '\u2019': "'",
  '…': '...', '•': '*', '✓': 'OK', '✗': 'X', '★': '*', '°': 'o', 'º': 'o', 'ª': 'a',
};

export function sanWinAnsi(t: unknown): string {
  if (t == null) return '';
  let s = String(t);
  for (const [k, v] of Object.entries(SANITIZE_WINANSI)) s = s.split(k).join(v);
  return s.replace(/[^\x00-\xFF]/g, '?');
}

export function parseNombreParts(n: unknown): { ap1: string; ap2: string; nom: string } {
  const parts = String(n || '').trim().split(/\s+/);
  if (parts.length <= 2) return { ap1: parts[0] || '', ap2: '', nom: parts[1] || '' };
  const nom = parts.slice(0, -2).join(' ');
  return { ap1: parts[parts.length - 2] || '', ap2: parts[parts.length - 1] || '', nom };
}

export function fmtCOP(n: number): string {
  return '$' + (Number(n) || 0).toLocaleString('es-CO');
}
