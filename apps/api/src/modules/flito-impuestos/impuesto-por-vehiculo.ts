// El impuesto se paga por VEHÍCULO y por año gravable, no por trámite.
//
// El SOAT lo tenía resuelto desde siempre por el modelo: `flito_soat.vin` es UNIQUE, así que anular
// un trámite y crear otro para el mismo vehículo reengancha el SOAT existente y nunca lo re-adquiere.
// El impuesto no tuvo esa suerte: `flito_impuestos.tramite_id` es UNIQUE, hay una fila POR TRÁMITE,
// y nada impedía que el trámite nuevo generara un impuesto `pendiente` —solicitable y pagable— para
// un vehículo cuyo impuesto del año ya estaba pagado. Es decir, un segundo desembolso real.
//
// Cambiar el modelo a «una fila por vehículo» sería lo simétrico, pero arrastra una migración de
// datos y toca el módulo entero. Aquí se corrige donde nace el problema: no se crea el registro si
// el vehículo ya tiene su impuesto del año en curso en vuelo o pagado. Es el mismo lugar y el mismo
// criterio con que `resolverSoat` bloquea el reencolado.

import { and, eq, inArray } from 'drizzle-orm';
import { EstadoImpuesto, ESTADOS_TRAMITE_FLITO_TERMINADOS } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoImpuestos, flitoTramites } from '../../db/schema.js';
import { TZ_COLOMBIA } from '../../shared/utils/fecha-rango.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Se consulta indistintamente dentro de la transacción del sync o fuera de ella. */
type DbOrTx = typeof db | Tx;

/**
 * Estados en los que el impuesto del vehículo bloquea crear otro: ya se pidió al gestor o ya se
 * pagó. `pendiente` y `con_novedad` NO bloquean — todavía no ha salido dinero y el trámite nuevo es
 * el que debe llevarlo adelante.
 */
export const ESTADOS_IMPUESTO_BLOQUEAN_POR_VEHICULO: readonly EstadoImpuesto[] = [
  EstadoImpuesto.SOLICITADO,
  EstadoImpuesto.PAGADO,
];

export interface ImpuestoBloqueante {
  id: string;
  tramiteId: string;
  estado: string;
  /** Año gravable con el que se comparó; `null` si no se pudo determinar. */
  anio: number | null;
}

/** Año en curso en Colombia. El huso importa: el 31 de diciembre a las 7 p.m. aún es el año viejo. */
export function anioGravableEnCurso(): number {
  return Number(new Intl.DateTimeFormat('en-CA', { timeZone: TZ_COLOMBIA, year: 'numeric' })
    .format(new Date()));
}

/**
 * Año gravable de un impuesto ya registrado, con la mejor fuente disponible:
 *
 *  1. `extraccion.anioGravable` — el dato real del recibo, pero es un campo OCR opcional que puede
 *     venir vacío, así que no se puede depender solo de él.
 *  2. el año de `pagadoEn` — cuándo se concilió. Aproximación buena: el impuesto se paga dentro de
 *     su vigencia.
 *  3. `null` si no hay ninguno de los dos (un `solicitado` que aún no se ha pagado).
 */
function anioDe(
  extraccion: unknown,
  pagadoEn: Date | string | null,
): number | null {
  const bruto = (extraccion as { anioGravable?: { valor?: unknown } } | null)?.anioGravable?.valor;
  // Mismo listón para texto y número: cuatro dígitos. Un `1` o un `202600` que se cuelen del OCR no
  // son un año, y aceptarlos solo porque llegaron tipados como número sería una asimetría accidental.
  const esAnio = (n: number): boolean => Number.isInteger(n) && n >= 1000 && n <= 9999;
  if (typeof bruto === 'string' && /^\d{4}$/.test(bruto)) return Number(bruto);
  if (typeof bruto === 'number' && esAnio(bruto)) return bruto;

  if (pagadoEn !== null) {
    const d = pagadoEn instanceof Date ? pagadoEn : new Date(pagadoEn);
    if (!Number.isNaN(d.getTime())) {
      return Number(new Intl.DateTimeFormat('en-CA', { timeZone: TZ_COLOMBIA, year: 'numeric' }).format(d));
    }
  }
  return null;
}

/**
 * Impuesto de OTRO trámite del mismo vehículo que impide crear uno nuevo para `anio`, o `undefined`.
 *
 * Ante la duda NO bloquea. Un falso negativo crea un impuesto de más, que una persona ve y descarta;
 * un falso positivo dejaría un vehículo sin poder tramitar su impuesto del año, en silencio y sin
 * que nadie se entere hasta que el cliente reclame. Por eso un `solicitado` sin año determinable se
 * trata como del año en curso —está en vuelo ahora mismo— pero un `pagado` sin año no bloquea nada.
 */
export async function impuestoBloqueantePorVehiculo(
  tx: DbOrTx,
  vehiculoId: number,
  anio: number,
  excluirTramiteId?: string,
): Promise<ImpuestoBloqueante | undefined> {
  const filas = await tx.select({
    id: flitoImpuestos.id,
    tramiteId: flitoImpuestos.tramiteId,
    estado: flitoImpuestos.estado,
    extraccion: flitoImpuestos.extraccion,
    pagadoEn: flitoImpuestos.pagadoEn,
    estadoTramite: flitoTramites.estado,
  })
    .from(flitoImpuestos)
    .innerJoin(flitoTramites, eq(flitoImpuestos.tramiteId, flitoTramites.id))
    .where(and(
      eq(flitoTramites.vehiculoId, vehiculoId),
      inArray(flitoImpuestos.estado, [...ESTADOS_IMPUESTO_BLOQUEAN_POR_VEHICULO]),
    ));

  for (const f of filas) {
    if (excluirTramiteId !== undefined && f.tramiteId === excluirTramiteId) continue;

    // Un `solicitado` que quedó colgando en un trámite ANULADO o RECHAZADO no bloquea: nunca salió
    // dinero por él y su trámite ya no está vivo para llevarlo adelante. Si bloqueara, el vehículo
    // se quedaría sin poder tramitar su impuesto hasta que alguien tocara a mano ese registro
    // muerto — el falso positivo silencioso que esta regla existe para no provocar.
    // Un `pagado`, en cambio, sigue bloqueando aunque su trámite esté anulado: el dinero salió.
    const tramiteMuerto = f.estadoTramite !== null
      && (ESTADOS_TRAMITE_FLITO_TERMINADOS as readonly string[]).includes(f.estadoTramite);
    if (tramiteMuerto && f.estado !== EstadoImpuesto.PAGADO) continue;

    const anioFila = anioDe(f.extraccion, f.pagadoEn);
    // Un `solicitado` sin año determinable está en vuelo ahora: cuenta como del año en curso.
    const efectivo = anioFila ?? (f.estado === EstadoImpuesto.SOLICITADO ? anio : null);
    if (efectivo === anio) {
      return { id: f.id, tramiteId: f.tramiteId, estado: f.estado, anio: anioFila };
    }
  }
  return undefined;
}
