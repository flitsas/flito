// FLITO — Servicios adicionales: helpers de la página del catálogo (HU #12542, Feature #12540).
// Diseño: `docs/ux/flito-servicios-adicionales-catalogo.md` §6–§7 (R1).
//
// Lo que aquí vive es lo que la página y el formulario comparten sin ser UI: la ruta, el formato
// del importe del AC2 («$ 85.000», con espacio), la validación del nombre, el diff del PATCH y a qué
// campo pertenece un 400 del servidor. La validación del VALOR no se reescribe: es
// `validarValorTarifa` de `lib/tarifas.ts`, la misma columna `numeric(14,2)` y las mismas reglas.

import {
  SERVICIO_ADICIONAL_DESCRIPCION_MAX, SERVICIO_ADICIONAL_NOMBRE_MAX,
  type EditarServicioAdicionalInput, type ServicioAdicionalTipo,
} from '@operaciones/shared-types';

export type { ServicioAdicionalTipo, ServicioAdicionalNombreDuplicado } from '@operaciones/shared-types';

export const RUTA_SERVICIOS_ADICIONALES = '/flito/parametrizacion/servicios-adicionales';

const FORMATO_PESOS = new Intl.NumberFormat('es-CO', {
  style: 'currency', currency: 'COP', minimumFractionDigits: 0, maximumFractionDigits: 2,
});

/**
 * «$ 85.000», «$ 0», «$ 1.500,50»: el literal del AC2, CON espacio entre el signo y la cifra.
 * `Intl` mete un espacio duro (U+00A0) en algunos motores; se normaliza a uno normal para que
 * `getByText('$ 85.000')` lo encuentre. Difiere a propósito de `pesosTarifa` (sin espacio): la
 * unificación es otra HU (UX §12-P2).
 */
export const pesosCatalogo = (n: number): string => FORMATO_PESOS.format(n).replace(/\s/g, ' ');

/** Texto de la línea de cuenta sobre la tabla; `''` con cero (no se pinta). */
export function lineaPorTarifar(n: number): string {
  if (n <= 0) return '';
  return n === 1 ? '1 tipo está a $ 0. Edítalo para ponerle valor.' : `${n} tipos están a $ 0. Edítalos para ponerles valor.`;
}

/** «Tipos (3)» · «Tipos (5 · 1 dado de baja)» · «Tipos (5 · 2 dados de baja)». */
export function tituloTipos(tipos: ServicioAdicionalTipo[]): string {
  const bajas = tipos.filter((t) => !t.activo).length;
  if (bajas === 0) return `Tipos (${tipos.length})`;
  return `Tipos (${tipos.length} · ${bajas} ${bajas === 1 ? 'dado de baja' : 'dados de baja'})`;
}

/** AC3: vacío o solo espacios, o más de 120 caracteres. `null` = válido. */
export function validarNombre(texto: string): string | null {
  const limpio = texto.trim();
  if (limpio === '') return 'Escribe el nombre.';
  if (limpio.length > SERVICIO_ADICIONAL_NOMBRE_MAX) return `El nombre admite hasta ${SERVICIO_ADICIONAL_NOMBRE_MAX} caracteres.`;
  return null;
}

/** La descripción es opcional; solo se acota el largo. `null` = válido. */
export function validarDescripcion(texto: string): string | null {
  if (texto.trim().length > SERVICIO_ADICIONAL_DESCRIPCION_MAX) return 'La descripción admite hasta 2.000 caracteres.';
  return null;
}

/** Lo que el formulario tiene ya validado y listo para enviar. */
export interface FormularioTipo { nombre: string; descripcion: string; valor: number }

/**
 * AC4: el cuerpo del PATCH lleva SOLO lo que cambió, o `null` si nada cambió (y entonces no se
 * envía nada: el 400 «Nada que actualizar» no llega a producirse). Vaciar la descripción viaja
 * como `null`, no como `''`.
 */
export function cambiosDe(tipo: ServicioAdicionalTipo, f: FormularioTipo): EditarServicioAdicionalInput | null {
  const cuerpo: EditarServicioAdicionalInput = {};
  const nombre = f.nombre.trim();
  const descripcion = f.descripcion.trim() || null;
  if (nombre !== tipo.nombre) cuerpo.nombre = nombre;
  if (descripcion !== tipo.descripcion) cuerpo.descripcion = descripcion;
  if (f.valor !== tipo.valor) cuerpo.valor = f.valor;
  return Object.keys(cuerpo).length === 0 ? null : cuerpo;
}

export type CampoTipo = 'nombre' | 'descripcion' | 'valor';

/** Un 400 del servidor con el formato de `mensajeDe` («valor admite a lo sumo…») va bajo ese campo. */
export function campoDelError400(texto: string): CampoTipo | null {
  const m = /^(nombre|descripcion|valor)\b/i.exec(texto.trim());
  return m ? (m[1].toLowerCase() as CampoTipo) : null;
}
