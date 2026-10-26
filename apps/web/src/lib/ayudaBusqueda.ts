// Búsqueda del índice de Ayuda FLITO (HU #11901; relevancia: Feature #13691 · HU #13704, diseño
// slim §3). Separado de ayudaFlito.ts: no toca el gate ni sabe de permisos — el llamador pasa solo
// `capitulosVisibles(user)`. Módulo puro: Playwright lo importa desde `src`.

import type { EntradaAyuda } from '../content/ayuda/catalogo';
import type { FichaParseada } from './ayudaFicha';

/** Minúsculas, sin diacríticos (NFD) y la puntuación (`·`, `/`, …) como espacio. */
export function normalizarBusquedaAyuda(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Subtítulo de la entrada (HU #13703): el `resumen` del encabezado si hay `.md`; si no, el
 * `resumenPendiente` del catálogo. Encabezado inválido en runtime → cadena vacía (tolerante).
 */
export function resumenDeEntrada(entrada: EntradaAyuda, ficha: FichaParseada | null | undefined): string {
  if (ficha) return ficha.encabezado?.resumen ?? '';
  return entrada.resumenPendiente ?? '';
}

export interface DocumentoAyuda {
  clave: string;
  /** Etiqueta del catálogo (= nombre del ítem del menú). */
  titulo: string;
  palabrasClave: readonly string[];
  consultas: readonly string[];
  resumen: string;
  /** Markdown sin encabezado. */
  cuerpo: string;
}

/** Documento buscable de una entrada del catálogo y su ficha (`null` = pendiente). */
export function documentoDeEntrada(
  entrada: EntradaAyuda,
  ficha: FichaParseada | null | undefined,
): DocumentoAyuda & { entrada: EntradaAyuda } {
  return {
    clave: entrada.clave,
    titulo: entrada.etiqueta,
    palabrasClave: ficha?.encabezado?.palabrasClave ?? [],
    consultas: ficha?.encabezado?.consultas ?? [],
    resumen: resumenDeEntrada(entrada, ficha),
    cuerpo: ficha?.cuerpo ?? '',
    entrada,
  };
}

// Pesos del diseño (§3). Cada término suma una sola vez por nivel: presencia, no frecuencia.
const PESO = {
  tituloIgual: 100,
  tituloContiene: 30,
  titulo: 8,
  palabrasClave: 4,
  consultas: 2,
  resumen: 2,
  cuerpo: 1,
} as const;

/**
 * Filtra (cada palabra de la consulta debe aparecer en algún campo) y ordena por relevancia.
 * Consulta vacía → `docs` tal cual. Desempate: posición en `docs`. No muta. Determinista.
 */
export function ordenarPorRelevancia<T extends DocumentoAyuda>(docs: readonly T[], consulta: string): T[] {
  const q = normalizarBusquedaAyuda(consulta);
  if (!q) return [...docs];
  const terminos = q.split(' ');

  const puntuados: { doc: T; puntos: number; pos: number }[] = [];
  docs.forEach((doc, pos) => {
    const titulo = normalizarBusquedaAyuda(doc.titulo);
    const campos: [string, number][] = [
      [titulo, PESO.titulo],
      [normalizarBusquedaAyuda(doc.palabrasClave.join(' | ')), PESO.palabrasClave],
      [normalizarBusquedaAyuda(doc.consultas.join(' | ')), PESO.consultas],
      [normalizarBusquedaAyuda(doc.resumen), PESO.resumen],
      [normalizarBusquedaAyuda(doc.cuerpo), PESO.cuerpo],
    ];
    let puntos = 0;
    for (const termino of terminos) {
      let aparece = false;
      for (const [texto, peso] of campos) {
        if (texto.includes(termino)) {
          puntos += peso;
          aparece = true;
        }
      }
      if (!aparece) return;
    }
    if (titulo === q) puntos += PESO.tituloIgual;
    if (titulo.includes(q)) puntos += PESO.tituloContiene;
    puntuados.push({ doc, puntos, pos });
  });

  return puntuados
    .sort((a, b) => b.puntos - a.puntos || a.pos - b.pos)
    .map((p) => p.doc);
}
