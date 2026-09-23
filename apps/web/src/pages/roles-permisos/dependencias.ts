// HU #12717 (Feature #12072) — Las acciones de un módulo dependen de su pantalla (ficha UX §14).
//
// Todo se calcula del catálogo (`tipo: 'pagina'` + el grupo) y del borrador `Set<string>` que ya
// están en memoria: ningún dato nuevo del API, nada nuevo en el `PUT` (decisión 37). Las reglas de
// producto (cerradas el 20/09/2026, §14) que estas funciones calcan:
//   1. Sin ninguna pantalla del módulo marcada, sus acciones no se pueden marcar (`disabled`).
//   2. Marcar una pantalla habilita las acciones; no las marca.
//   3. Con dos pantallas basta una marcada.
//   4. Desmarcar la última pantalla marcada desmarca TODAS las acciones del módulo en el mismo gesto.
//   5. Desmarcar una de dos pantallas quedando la otra no toca las acciones.
//   6. Un módulo sin pantalla no tiene dependencia (Catálogos compartidos).
//   7. Una inconsistencia heredada (acciones marcadas sin pantalla) se pinta marcada y bloqueada,
//      con aviso; la dependencia NUNCA borra nada por su cuenta al cargar ni al guardar (AC8).
//
// Vive aparte de `modulos.ts` para no engordarlo; el copy (§14.5) se exporta desde aquí para que
// la pantalla y el spec E2E lean el mismo literal.

import type { FuncionDeGrupo, GrupoDeFunciones } from '../../lib/api';

export const COPY_MARCA_PRIMERO_PANTALLA = 'Marca primero la pantalla para poder marcar estas acciones.';
export const COPY_MARCA_PRIMERO_UNA_PANTALLA = 'Marca primero una de las dos pantallas para poder marcar estas acciones.';

/** Las funciones `tipo: 'pagina'` del grupo, en el orden en que llegan. */
export function pantallasDe(grupo: GrupoDeFunciones): FuncionDeGrupo[] {
  return grupo.funciones.filter((f) => f.tipo === 'pagina');
}

/** Las funciones que no son pantalla, en el orden en que llegan. */
export function accionesDe(grupo: GrupoDeFunciones): FuncionDeGrupo[] {
  return grupo.funciones.filter((f) => f.tipo !== 'pagina');
}

/** `true` si el módulo no tiene pantalla (regla 6) o al menos una de sus pantallas está marcada (reglas 1 y 3). */
export function moduloHabilitado(grupo: GrupoDeFunciones, borrador: ReadonlySet<string>): boolean {
  const pantallas = pantallasDe(grupo);
  return pantallas.length === 0 || pantallas.some((p) => borrador.has(p.codigo));
}

/**
 * Desmarca `codigoPantalla` y, si con eso el módulo se queda sin ninguna pantalla marcada, desmarca
 * también todas sus acciones (regla 4). Si queda otra pantalla marcada no toca nada más (regla 5).
 * Devuelve un Set nuevo; no muta `borrador`.
 */
export function desmarcarPantalla(grupo: GrupoDeFunciones, borrador: ReadonlySet<string>, codigoPantalla: string): Set<string> {
  const s = new Set(borrador);
  s.delete(codigoPantalla);
  if (!moduloHabilitado(grupo, s)) for (const a of accionesDe(grupo)) s.delete(a.codigo);
  return s;
}

/**
 * Códigos de las acciones marcadas en un módulo que tiene pantalla y ninguna marcada (regla 7).
 * Vacío si el módulo no tiene pantalla, si alguna está marcada, o si no hay acciones marcadas.
 */
export function accionesSinPantalla(grupo: GrupoDeFunciones, borrador: ReadonlySet<string>): string[] {
  if (pantallasDe(grupo).length === 0 || moduloHabilitado(grupo, borrador)) return [];
  return accionesDe(grupo).map((a) => a.codigo).filter((c) => borrador.has(c));
}

/** Lo que «Marcar todas» del módulo marca: pantalla(s) Y acciones, nunca solo las acciones. */
export function marcarModulo(grupo: GrupoDeFunciones): string[] {
  return grupo.funciones.map((f) => f.codigo);
}

/** La línea «Marca primero…» del módulo (§14.2): una por módulo, según tenga una o varias pantallas; `null` si no tiene. */
export function explicacionModulo(grupo: GrupoDeFunciones): string | null {
  const n = pantallasDe(grupo).length;
  if (n === 0) return null;
  return n === 1 ? COPY_MARCA_PRIMERO_PANTALLA : COPY_MARCA_PRIMERO_UNA_PANTALLA;
}

const entreComillas = (nombre: string) => `«${nombre}»`;

/** El aviso de carga inconsistente (§14.5): nombra la(s) pantalla(s) por su nombre de negocio, nunca por el código. */
export function avisoSinPantalla(grupo: GrupoDeFunciones, n: number): string {
  const pantallas = pantallasDe(grupo).map((p) => entreComillas(p.nombreNegocio));
  const verbo = n === 1 ? 'desmárcala' : 'desmárcalas';
  const cuenta = n === 1 ? '1 acción marcada' : `${n} acciones marcadas`;
  if (pantallas.length <= 1) return `${cuenta} sin la pantalla. Marca ${pantallas[0] ?? ''} o ${verbo}.`;
  return `${cuenta} sin ninguna de sus pantallas. Marca ${pantallas.join(' o ')}, o ${verbo}.`;
}

/** «Desmarcarlas» / «Desmarcarla» (botón del aviso). */
export function botonDesmarcar(n: number): string {
  return n === 1 ? 'Desmarcarla' : 'Desmarcarlas';
}

/** «· 4 sin pantalla» (sufijo del encabezado del acordeón mientras hay aviso, decisión 33). */
export function sufijoSinPantalla(n: number): string {
  return `· ${n} sin pantalla`;
}
