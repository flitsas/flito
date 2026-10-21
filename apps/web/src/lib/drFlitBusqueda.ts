// Dr. Flit — búsqueda por sección de las fichas de Ayuda (HU #13766, Feature #13694, slim §3).
// Puro: solo importa `./ayudaMarkdown`, `./ayudaBusqueda` y tipos; nada de React, `api` ni
// `import.meta`, para que Playwright lo importe desde `src`. No sabe de permisos: el llamador pasa
// SOLO fichas visibles (como `ordenarPorRelevancia`). La consulta nunca sale de aquí (ni a consola).

import type { EntradaAyuda } from '../content/ayuda/catalogo';
import type { FichaParseada } from './ayudaFicha';
import { parseMarkdown, textoPlano, type MdInline } from './ayudaMarkdown';
import { normalizarBusquedaAyuda, PESO } from './ayudaBusqueda';

export const MAX_CITAS = 3;

export interface SeccionAyuda {
  /** Clave de la ficha. */
  clave: string;
  /** `id` del encabezado h1–h3 tal como lo emite `parseMarkdown` (incluye `-2`, `-3`). */
  ancla: string;
  /** `EntradaAyuda.etiqueta`. */
  tituloFicha: string;
  tituloSeccion: string;
  /** Texto de p/ul/ol/callout/quote hasta el siguiente encabezado; sin `pre`. */
  texto: string;
  palabrasClave: readonly string[];
  consultas: readonly string[];
}

export interface CitaSeccion {
  clave: string;
  ancla: string;
  tituloFicha: string;
  tituloSeccion: string;
}

export interface FichaBuscable {
  entrada: EntradaAyuda;
  ficha: FichaParseada | null;
}

/** Lista cerrada de palabras vacías (slim §3): no cuentan como término de búsqueda. */
const PALABRAS_VACIAS: ReadonlySet<string> = new Set([
  'a', 'al', 'de', 'del', 'el', 'la', 'las', 'lo', 'los', 'en', 'y', 'o', 'u', 'un', 'una', 'unos', 'unas',
  'por', 'para', 'con', 'que', 'se', 'me', 'mi', 'es',
]);

const lineas = (items: MdInline[][]): string => items.map(textoPlano).join(' ');

/** Secciones de UNA ficha, en orden de aparición. `ficha === null` (pendiente) → []. */
export function seccionesDeFicha(entrada: EntradaAyuda, ficha: FichaParseada | null): SeccionAyuda[] {
  if (!ficha) return [];
  const palabrasClave = ficha.encabezado?.palabrasClave ?? [];
  const consultas = ficha.encabezado?.consultas ?? [];
  const secciones: SeccionAyuda[] = [];
  let actual: SeccionAyuda | null = null;
  // El texto previo al primer encabezado no es citable (lo cubre el resumen de la ficha).
  for (const b of parseMarkdown(ficha.cuerpo)) {
    if (b.type === 'h1' || b.type === 'h2' || b.type === 'h3') {
      actual = {
        clave: entrada.clave, ancla: b.id, tituloFicha: entrada.etiqueta, tituloSeccion: textoPlano(b.children),
        texto: '', palabrasClave, consultas,
      };
      secciones.push(actual);
      continue;
    }
    if (!actual) continue;
    let t = '';
    if (b.type === 'p') t = textoPlano(b.children);
    else if (b.type === 'ul' || b.type === 'ol') t = lineas(b.items);
    else if (b.type === 'callout' || b.type === 'quote') t = lineas(b.parrafos);
    if (t) actual.texto = actual.texto ? `${actual.texto} ${t}` : t;
  }
  return secciones;
}

/** ¿El ancla existe hoy en esa ficha? (rehidratación, HU #13767). */
export function anclaExiste(ficha: FichaParseada | null, ancla: string): boolean {
  if (!ficha) return false;
  return parseMarkdown(ficha.cuerpo).some((b) => (b.type === 'h1' || b.type === 'h2' || b.type === 'h3') && b.id === ancla);
}

/** Términos útiles de la consulta: normalizados, sin palabras vacías ni repetidos. */
export function terminosDeConsulta(consulta: string): string[] {
  const q = normalizarBusquedaAyuda(consulta);
  if (!q) return [];
  return [...new Set(q.split(' ').filter((t) => t && !PALABRAS_VACIAS.has(t)))];
}

/**
 * Hasta `n` citas. Entra la sección con AL MENOS un término en algún campo. Orden: (1) más términos
 * distintos cubiertos, (2) más puntos, (3) orden de la ficha en `fichas`, (4) orden de la sección.
 * Determinista, no muta.
 */
export function buscarSecciones(fichas: readonly FichaBuscable[], consulta: string, n = MAX_CITAS): CitaSeccion[] {
  const terminos = terminosDeConsulta(consulta);
  if (!terminos.length || n <= 0) return [];
  const frase = terminos.join(' ');

  const puntuadas: { s: SeccionAyuda; cubiertos: number; puntos: number; ficha: number; orden: number }[] = [];
  fichas.forEach(({ entrada, ficha }, iFicha) => {
    seccionesDeFicha(entrada, ficha).forEach((s, orden) => {
      const tituloSeccion = normalizarBusquedaAyuda(s.tituloSeccion);
      const campos: [string, number][] = [
        [tituloSeccion, PESO.titulo],
        [normalizarBusquedaAyuda(s.tituloFicha), PESO.palabrasClave],
        [normalizarBusquedaAyuda(s.palabrasClave.join(' | ')), PESO.consultas],
        [normalizarBusquedaAyuda(s.consultas.join(' | ')), PESO.consultas],
        [normalizarBusquedaAyuda(s.texto), PESO.cuerpo],
      ];
      let cubiertos = 0;
      let puntos = 0;
      for (const t of terminos) {
        let aparece = false;
        for (const [texto, peso] of campos) {
          if (texto.includes(t)) {
            puntos += peso;
            aparece = true;
          }
        }
        if (aparece) cubiertos += 1;
      }
      if (!cubiertos) return;
      if (tituloSeccion.includes(frase)) puntos += PESO.tituloContiene;
      puntuadas.push({ s, cubiertos, puntos, ficha: iFicha, orden });
    });
  });

  return puntuadas
    .sort((a, b) => b.cubiertos - a.cubiertos || b.puntos - a.puntos || a.ficha - b.ficha || a.orden - b.orden)
    .slice(0, n)
    .map(({ s }) => ({ clave: s.clave, ancla: s.ancla, tituloFicha: s.tituloFicha, tituloSeccion: s.tituloSeccion }));
}
