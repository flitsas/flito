// Kit FLIT — opciones de un selector de entidades que pueden estar INACTIVAS (HU #13950).
//
// Lo usan los desplegables de compañía (usuarios, tarifas, bolsas, remesas, carga de boletas) y lo
// usará el de proveedores (HU #13963). La regla es una sola y por eso vive aquí y no en cada
// pantalla:
//
//   · **Inactiva = visible pero no elegible.** Sale en la lista con la nota «Inactivo» —en el TEXTO,
//     no solo en el gris nativo de la opción deshabilitada (AC4)— y con `disabled` + `aria-disabled`.
//   · **Eliminada = no sale.** El API ya no la devuelve (#13953); aquí no hay nada que filtrar.
//   · **Lo ya asignado se conserva** (AC3). Si el valor actual es una inactiva, su opción queda
//     habilitada —es la seleccionada; deshabilitarla dejaría al navegador mostrando otra— y con la
//     nota. Si el valor actual ni siquiera viene en la lista, se añade como «no disponible» para que
//     el campo no se vacíe en silencio y el resto del formulario se pueda guardar igual. En cuanto el
//     usuario elige otra, la inactiva queda deshabilitada y no se puede volver a ella.

import type { FlitSelectOpcion } from './FlitSelect';

export const NOTA_INACTIVO = 'Inactivo';
export const NOTA_NO_DISPONIBLE = 'No disponible';

/** Lo mínimo que hace falta de cada entidad. `activo` ausente se trata como activo. */
export interface EntidadConEstado {
  id: number | string;
  nombre: string;
  activo?: boolean;
}

/** `true` solo si el API dijo explícitamente que está inactiva. */
export const esInactivo = (e: { activo?: boolean }): boolean => e.activo === false;

export interface OpcionesConEstadoConfig {
  /** Primera opción vacía («Elige una compañía…»). Se omite si no viene. */
  placeholder?: string;
  /** Etiqueta del valor asignado que ya no viene en la lista. Por defecto, «Asignado actualmente». */
  etiquetaAusente?: string;
}

/**
 * Opciones de `FlitSelect` (o de un `<select>` del kit) con el estado de cada entidad aplicado.
 *
 * @param valorActual el `value` del control, en string (`''` = nada elegido).
 */
export function opcionesConEstado(
  entidades: readonly EntidadConEstado[],
  valorActual: string,
  config: OpcionesConEstadoConfig = {},
): FlitSelectOpcion[] {
  const opciones: FlitSelectOpcion[] = [];
  if (config.placeholder !== undefined) opciones.push({ valor: '', etiqueta: config.placeholder });

  let actualPresente = valorActual === '';
  for (const e of entidades) {
    const valor = String(e.id);
    const esActual = valor === valorActual;
    if (esActual) actualPresente = true;
    const inactiva = esInactivo(e);
    opciones.push({
      valor,
      etiqueta: e.nombre,
      nota: inactiva ? NOTA_INACTIVO : undefined,
      deshabilitada: inactiva && !esActual,
    });
  }

  if (!actualPresente) {
    // Va justo tras el placeholder: es lo que el campo muestra, no una opción más del catálogo.
    opciones.splice(config.placeholder !== undefined ? 1 : 0, 0, {
      valor: valorActual,
      etiqueta: config.etiquetaAusente ?? 'Asignado actualmente',
      nota: NOTA_NO_DISPONIBLE,
    });
  }
  return opciones;
}
