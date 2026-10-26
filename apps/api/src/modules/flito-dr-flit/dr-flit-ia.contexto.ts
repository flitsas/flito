// Dr. Flit IA — contexto de fichas para el modelo (HU #13853, Feature #13696 · IA-1, ADR-0027).
//
// RN-DRF-IA1 (visibilidad): una ficha es visible si `pagina.<permiso>` DEL CATÁLOGO está en el conjunto
//   efectivo del usuario (motor de permisos), nunca por nombre de rol. `soat` → `flito_soat`,
//   `privacy_log_pii` → `privacy` (el `permiso` ya viene así en el artefacto). `funcionesConcedidas` se
//   consulta UNA vez por petición con los códigos de todas las fichas. Ficha sin `.md` = no está en el
//   artefacto = nunca visible. HU #13941 (AC5): la IA además exige «Ver los manuales» (`manualesDisponibles`).
// RN-DRF-IA2 (presupuesto): el índice (clave, etiqueta, resumen) de las visibles va siempre. Si el texto
//   de todas las secciones visibles cabe en `DRFLIT_IA_CONTEXTO_MAX_CHARS`, van todas. Si no, se rankean
//   con la réplica de `buscarSecciones` del web (F3) y se toman en orden hasta llenar el presupuesto,
//   recortando cada una a `DRFLIT_IA_SECCION_MAX_CHARS`.
// Réplica del ranking: `normalizarBusquedaAyuda`, `PESO` (`lib/ayudaBusqueda.ts`), `terminosDeConsulta` y
// `buscarSecciones` (`lib/drFlitBusqueda.ts`). La paridad la vigila `ia-contexto.test.ts`; si cambia el
// algoritmo del web, cambia aquí. La consulta del usuario no se loguea.
import type { Request } from 'express';
import { env } from '../../config/env.js';
import { funcionesConcedidas } from '../../shared/middleware/exigir-funcion.js';
import { FICHAS_AYUDA, type FichaAyudaApi } from './ayuda/fichas-ayuda.generated.js';

export type { FichaAyudaApi } from './ayuda/fichas-ayuda.generated.js';

/** Códigos `pagina.<permiso>` de todas las fichas del artefacto, sin repetidos. */
export const CODIGOS_PAGINA_FICHAS: readonly string[] = Object.freeze(
  [...new Set(FICHAS_AYUDA.map((f) => `pagina.${f.permiso}`))],
);

/** Puro: fichas cuyo `pagina.<permiso>` está concedido, en el orden del catálogo. */
export function filtrarFichasVisibles(
  concedidas: ReadonlySet<string>,
  fichas: readonly FichaAyudaApi[] = FICHAS_AYUDA,
): FichaAyudaApi[] {
  return fichas.filter((f) => concedidas.has(`pagina.${f.permiso}`));
}

/** Fichas visibles para quien hace la petición. Una sola consulta al motor de permisos. */
export async function fichasVisibles(req: Request): Promise<FichaAyudaApi[]> {
  return filtrarFichasVisibles(await funcionesConcedidas(req, CODIGOS_PAGINA_FICHAS));
}

/** HU #13941: la operación de «Ver los manuales» de Dr. Flit (literal: es la de `FUNCIONES_DRFLIT.verManuales`). */
export const OPERACION_VER_MANUALES = 'drflit.manuales.ver';

/**
 * HU #13941 (AC5) — Los manuales con los que puede responder la IA: los de las fichas visibles, y solo si el
 * usuario tiene «Ver los manuales». UNA consulta al motor (`funcionesConcedidas`, sonda: no escribe denegado).
 * Sin la función, o sin ninguna ficha visible, `[]`.
 */
export async function manualesDisponibles(req: Request): Promise<FichaAyudaApi[]> {
  const concedidas = await funcionesConcedidas(req, [OPERACION_VER_MANUALES, ...CODIGOS_PAGINA_FICHAS]);
  return concedidas.has(OPERACION_VER_MANUALES) ? filtrarFichasVisibles(concedidas) : [];
}

// ── Réplica del ranking del web ─────────────────────────────────────────────────────────────────

const PESO = { tituloContiene: 30, titulo: 8, palabrasClave: 4, consultas: 2, cuerpo: 1 } as const;

const PALABRAS_VACIAS: ReadonlySet<string> = new Set([
  'a', 'al', 'de', 'del', 'el', 'la', 'las', 'lo', 'los', 'en', 'y', 'o', 'u', 'un', 'una', 'unos', 'unas',
  'por', 'para', 'con', 'que', 'se', 'me', 'mi', 'es',
]);

export function normalizarBusquedaAyuda(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function terminosDeConsulta(consulta: string): string[] {
  const q = normalizarBusquedaAyuda(consulta);
  if (!q) return [];
  return [...new Set(q.split(' ').filter((t) => t && !PALABRAS_VACIAS.has(t)))];
}

export interface SeccionContexto {
  clave: string;
  etiqueta: string;
  ancla: string;
  titulo: string;
  texto: string;
}

const aSeccion = (f: FichaAyudaApi, s: FichaAyudaApi['secciones'][number]): SeccionContexto => ({
  clave: f.clave, etiqueta: f.etiqueta, ancla: s.ancla, titulo: s.titulo, texto: s.texto,
});

/**
 * TODAS las secciones con al menos un término de la consulta, ordenadas como `buscarSecciones` del web:
 * (1) más términos distintos cubiertos, (2) más puntos, (3) orden de la ficha, (4) orden de la sección.
 */
export function rankearSecciones(fichas: readonly FichaAyudaApi[], consulta: string): SeccionContexto[] {
  const terminos = terminosDeConsulta(consulta);
  if (!terminos.length) return [];
  const frase = terminos.join(' ');

  const puntuadas: { s: SeccionContexto; cubiertos: number; puntos: number; ficha: number; orden: number }[] = [];
  fichas.forEach((f, iFicha) => {
    const etiqueta = normalizarBusquedaAyuda(f.etiqueta);
    const palabrasClave = normalizarBusquedaAyuda(f.palabrasClave.join(' | '));
    const consultas = normalizarBusquedaAyuda(f.consultas.join(' | '));
    f.secciones.forEach((s, orden) => {
      const tituloSeccion = normalizarBusquedaAyuda(s.titulo);
      const campos: [string, number][] = [
        [tituloSeccion, PESO.titulo],
        [etiqueta, PESO.palabrasClave],
        [palabrasClave, PESO.consultas],
        [consultas, PESO.consultas],
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
      puntuadas.push({ s: aSeccion(f, s), cubiertos, puntos, ficha: iFicha, orden });
    });
  });

  return puntuadas
    .sort((a, b) => b.cubiertos - a.cubiertos || b.puntos - a.puntos || a.ficha - b.ficha || a.orden - b.orden)
    .map(({ s }) => s);
}

// ── Presupuesto ─────────────────────────────────────────────────────────────────────────────────

export interface EntradaIndice {
  clave: string;
  etiqueta: string;
  resumen: string;
}

export interface ContextoIa {
  indice: EntradaIndice[];
  secciones: SeccionContexto[];
  /** `true` si las secciones salieron del ranking (no cabían todas). */
  seleccionado: boolean;
}

export interface PresupuestoContexto {
  contextoMaxChars: number;
  seccionMaxChars: number;
}

export function presupuestoDeEnv(): PresupuestoContexto {
  return { contextoMaxChars: env.DRFLIT_IA_CONTEXTO_MAX_CHARS, seccionMaxChars: env.DRFLIT_IA_SECCION_MAX_CHARS };
}

/** Lo que una sección consume del presupuesto: título + texto. */
export const costoSeccion = (s: Pick<SeccionContexto, 'titulo' | 'texto'>): number => s.titulo.length + s.texto.length;

/**
 * Arma el contexto para un mensaje. `consulta` = mensaje + último turno del usuario (lo concatena el
 * llamador). Puro y determinista: no muta `fichas`. Sin fichas visibles → índice y secciones vacíos.
 */
export function armarContexto(
  fichas: readonly FichaAyudaApi[],
  consulta: string,
  presupuesto: PresupuestoContexto = presupuestoDeEnv(),
): ContextoIa {
  const indice = fichas.map((f) => ({ clave: f.clave, etiqueta: f.etiqueta, resumen: f.resumen }));
  const todas = fichas.flatMap((f) => f.secciones.map((s) => aSeccion(f, s)));
  const total = todas.reduce((n, s) => n + costoSeccion(s), 0);
  if (total <= presupuesto.contextoMaxChars) return { indice, secciones: todas, seleccionado: false };

  const secciones: SeccionContexto[] = [];
  let restante = presupuesto.contextoMaxChars;
  for (const s of rankearSecciones(fichas, consulta)) {
    if (restante <= s.titulo.length) break;
    const maxTexto = Math.min(presupuesto.seccionMaxChars, restante) - s.titulo.length;
    if (maxTexto <= 0) continue;
    const texto = s.texto.length > maxTexto ? s.texto.slice(0, maxTexto) : s.texto;
    secciones.push({ ...s, texto });
    restante -= s.titulo.length + texto.length;
  }
  return { indice, secciones, seleccionado: true };
}
