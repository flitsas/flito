// Siigo — parámetros operativos del ambiente (`siigo_config_emision`).
//
// **Este módulo era la «configuración global de emisión» y ya no lo es** (decisión del 2026-08-13).
// Guardaba con qué tipo de comprobante, vendedor, forma de pago y centro de costo nacían TODAS las
// facturas de un ambiente, y la pantalla de parametrización la mantenía. Eso desapareció: los cuatro
// se eligen en cada envío, por empresa, contra los catálogos leídos de Siigo en ese momento.
//
// Por qué desapareció, en una frase: una configuración global significaba que cambiar el vendedor de
// una empresa lo cambiaba para todas, y que una factura podía salir con un vendedor que quien la
// envió nunca vio.
//
// Con ella se fueron también las columnas que sostenían cuatro preguntas de negocio abiertas, porque
// el 2026-08-13 se respondieron y una respuesta no necesita una palanca:
//
//   · Retenciones (p. 7) → se configuran en el TERCERO en Siigo. FLITO no envía `retentions[]`.
//   · Moneda (p. 15) → COP, y en COP no se envía `currency`: el campo es para moneda extranjera.
//   · Numeración (p. 12) → el consecutivo lo asigna Siigo. `number` ni siquiera existe en `InvoiceIn`.
//   · Plazo de vencimiento → no se maneja. No se envía `payments[].due_date`.
//
// **Lo que queda son dos valores operativos del ambiente**, y siguen en tabla y no en el entorno a
// propósito: son por ambiente, quedan historiados y llevan `CHECK`, mientras que una variable de
// entorno se pone mal en un despliegue sin que nadie se entere.
//
// No hay pantalla que los edite ni endpoint que los escriba. Se cambian con una migración, que es
// exactamente la fricción que se busca: `historico_desde` decide desde cuándo se factura y
// `arrendamiento_en_proceso_min` decide cuándo una factura a medias se da por huérfana.

import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { siigoConfigEmision } from '../../db/schema.js';
import type { SiigoAmbiente } from './credenciales.service.js';

/**
 * Los dos valores operativos del ambiente.
 *
 * Se leen juntos porque salen de la misma fila vigente y porque un segundo lector de esta tabla
 * acabaría discrepando sobre cuál es esa fila.
 */
export interface ParametrosOperativos {
  /** Desde qué fecha se factura electrónicamente. Lo anterior no se emite: no hay histórico. */
  historicoDesde: string;
  /** Minutos tras los cuales una factura `en_proceso` se considera huérfana y se reconcilia. */
  arrendamientoEnProcesoMin: number;
}

/**
 * Parámetros operativos vigentes del ambiente. `null` si nunca se guardó una fila.
 *
 * `null` explícito y no unos valores por defecto: quien llama tiene que poder distinguir «no hay
 * nada configurado en este ambiente» de «hay una fila y dice esto».
 */
export async function parametrosOperativos(
  ambiente: SiigoAmbiente,
): Promise<ParametrosOperativos | null> {
  const [fila] = await db.select().from(siigoConfigEmision)
    .where(and(
      eq(siigoConfigEmision.ambiente, ambiente),
      eq(siigoConfigEmision.vigente, true),
    ))
    .limit(1);
  if (!fila) return null;
  return {
    historicoDesde: fila.historicoDesde,
    arrendamientoEnProcesoMin: fila.arrendamientoEnProcesoMin,
  };
}
