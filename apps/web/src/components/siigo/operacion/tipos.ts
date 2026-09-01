// Bandeja de fallidos — tipos de la PANTALLA (HU #11345, Feature #11244).
//
// Aquí solo vive lo que la pantalla inventa: los criterios de filtro y la identidad de una fila.
// Todo lo que describe un caso —fuente, guía, estado nativo, descarte— llega de
// `@operaciones/shared-types` y no se redefine: una segunda copia del ítem sería la que se quedara
// vieja el día que el contrato cambie. Es el mismo reparto que `components/siigo/terceros/tipos.ts`.

import type { SiigoBandejaFuente, SiigoBandejaItem } from '@operaciones/shared-types';

/**
 * Qué se está mirando. **No son «pendientes» y «descartados» como conjuntos disjuntos**, porque el
 * contrato no ofrece eso: `POST /bandeja/buscar` tiene `incluirDescartados`, un interruptor que
 * AÑADE lo dado por perdido a lo pendiente. Rotularlo «Dados por perdido» prometería una vista
 * exclusiva que el servidor no sabe devolver, y la lista mostraría de todo bajo ese título.
 */
export type VistaBandeja = 'pendientes' | 'con_descartados';

/**
 * Los criterios de la consulta. **Ninguno viaja en la dirección del navegador** (AGENTS.md §14):
 * `clienteId` identifica a un titular y los otros cuatro no van solos —un filtro a medias reproduce
 * una vista parecida pero distinta a la que vio quien compartió el enlace, sin decirlo—.
 */
export interface CriteriosBandeja {
  fuente: SiigoBandejaFuente | null;
  /** «Lleva al menos tantos días detenido». `null` = toda la antigüedad. */
  antiguedadDiasMin: number | null;
  /** Código crudo del motivo, tal como lo agrupa `GET /resumen`. Nunca la frase. */
  codigo: string | null;
  clienteId: number | null;
  vista: VistaBandeja;
}

export const CRITERIOS_VACIOS: CriteriosBandeja = {
  fuente: null,
  antiguedadDiasMin: null,
  codigo: null,
  clienteId: null,
  vista: 'pendientes',
};

/**
 * ¿Hay algún criterio puesto?
 *
 * Decide cuál de los DOS vacíos se pinta, y por eso no es una comodidad: celebrar un vacío que solo
 * existe porque hay un filtro puesto es la peor mentira que esta pantalla puede contar —quien filtró
 * por un cliente y lee «no hay nada detenido» cierra la pestaña con catorce facturas paradas—.
 */
export function hayFiltros(c: CriteriosBandeja): boolean {
  return c.fuente !== null || c.antiguedadDiasMin !== null || c.codigo !== null
    || c.clienteId !== null || c.vista !== 'pendientes';
}

/**
 * La identidad de un caso. **`fuente` + `refId`, y no el trámite.**
 *
 * Un mismo trámite puede estar detenido dos veces por motivos distintos —la DIAN rechazó el
 * documento y además el correo no salió—, así que la clave por trámite abriría el caso equivocado.
 * `refId` es el uuid de la fila que originó el caso (la factura, el estado DIAN o el acta).
 */
export function claveCaso(caso: { fuente: SiigoBandejaFuente; refId: string }): string {
  return `${caso.fuente}:${caso.refId}`;
}

/**
 * Cómo se nombra un caso en pantalla. El identificador de FLIT primero, que es con el que quien
 * opera lo busca; el número de factura después. **Nunca el nombre ni el documento del cliente**: un
 * identificador se pega en un chat y en una captura sin arrastrar datos de nadie.
 */
export function etiquetaCaso(item: SiigoBandejaItem): string {
  const idFlit = item.tramites.find((t) => t.idFlit)?.idFlit;
  if (idFlit) return idFlit;
  if (item.facturaNumero) return `Factura ${item.facturaNumero}`;
  return `Caso ${item.refId.slice(0, 8)}`;
}

/** El trámite con el que se pide la línea de tiempo. `null` si el caso no tiene ninguno colgado. */
export function tramiteDe(item: SiigoBandejaItem): string | null {
  return item.tramites[0]?.tramiteId ?? null;
}
