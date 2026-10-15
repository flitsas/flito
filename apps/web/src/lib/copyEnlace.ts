// HU #13452 (corrección de la sesión de evidencias) — Copy de estado vacío para un usuario CON enlace.
//
// El vacío de siempre manda a «Sincroniza desde el Tablero / desde FLIT»: es una instrucción interna
// de Operaciones que el usuario de una compañía, de un proveedor o de un organismo no puede seguir
// (la sincronización le queda cerrada por su enlace, ADR-0024). Con enlace el vacío dice de quién son
// los datos que faltan, en usted, una frase. Sin enlace (`ninguno`) o sin saberlo aún (`null`) →
// `null`: la pantalla conserva su copy de siempre.
import type { TipoEnlace } from '@operaciones/shared-types';

const DE_QUIEN: Record<Exclude<TipoEnlace, 'ninguno'>, string> = {
  compania: 'de su compañía',
  proveedor: 'asignados a su proveedor',
  organismos_transito: 'de sus secretarías',
};

/** ¿Tiene el usuario un enlace que restringe lo que ve? `null` (aún no llegó) cuenta como no. */
export function conEnlace(enlace: TipoEnlace | null | undefined): enlace is Exclude<TipoEnlace, 'ninguno'> {
  return !!enlace && enlace !== 'ninguno';
}

/** «No hay SOAT de su compañía en esta vista.» · `null` sin enlace. */
export function vacioConEnlace(que: string, enlace: TipoEnlace | null | undefined): string | null {
  return conEnlace(enlace) ? `No hay ${que} ${DE_QUIEN[enlace]} en esta vista.` : null;
}
