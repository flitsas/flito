// FLITO Impuestos — paso «comparacion» del análisis post-envío: semáforo factura vs RUNT (HU #12827,
// Épica #12809, Feature #12822). Segundo paso de la cola de la HU 12825, después de `extraccion`.
//
//   AC1  Extracción + RUNT válido → comparación campo a campo (función pura en
//        `flito-impuestos.comparacion-factura-runt.ts`) → verde/naranja en `semaforo` y el detalle en
//        `comparacion_factura_runt`. `completado` + `analizado_en` los pone la cola.
//   AC2  RUNT sin respuesta, sin registro, traspaso en sincronización o sin datos para consultar →
//        rojo `runt_sin_respuesta` (la causa fina va en `detalleRunt`), y el análisis queda
//        `completado`. Factura leída pero sin ningún campo comparable fiable → rojo
//        `error_lectura_factura`, SIN consultar el RUNT, y el paso LANZA `FacturaIlegibleError` para
//        que la cola deje `error_analisis` (y la 12828 no corra).
//   AC4  Ni la conciliación de recibos ni el recibo de caja leen el semáforo: no bloquea el pago.
//
// Un fallo técnico (sin factura, descarga u OCR caído) ya lo lanzó `extraccion`: este paso no corre
// y `semaforo` queda NULL (reintentable).
//
// Una consulta RUNT por análisis: queda en `job.consultaRunt` para la 12828.
// PII: se leen placa, documento del propietario y VIN para consultar, y se persiste el VIN en el jsonb →
// `pii_access_log` de sistema. Los logs llevan solo id, semáforo, motivo, causa y conteos.

import { and, eq } from 'drizzle-orm';
import {
  AnalisisEstadoImpuesto, MotivoSemaforoRojo, SemaforoImpuesto,
  type ComparacionFacturaRunt, type DetalleRuntSemaforo,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoImpuestos } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import type { PasoAnalisis } from './flito-impuestos.analisis.service.js';
import { compararFacturaConRunt, facturaIlegible } from './flito-impuestos.comparacion-factura-runt.js';
import { registrarAccesoSistema } from './flito-impuestos.extraccion.js';
import { consultarRuntDeImpuesto } from './flito-impuestos.runt-consulta.js';

const log = loggerFor('flito-impuestos.comparacion');

/** La factura se leyó pero no trae ningún campo comparable fiable. El paso lanza → `error_analisis`. */
export class FacturaIlegibleError extends Error {
  constructor() {
    super('Factura de venta ilegible: ningún campo comparable con el RUNT');
    this.name = 'FacturaIlegibleError';
  }
}

/** La extracción no está (no debería pasar: `extraccion` habría lanzado). */
export class SinExtraccionFacturaError extends Error {
  constructor() {
    super('El impuesto no tiene extracción de la factura de venta');
    this.name = 'SinExtraccionFacturaError';
  }
}

const rojo = (motivo: MotivoSemaforoRojo, ahora: Date, detalleRunt?: DetalleRuntSemaforo): ComparacionFacturaRunt => ({
  version: 1,
  motivo,
  ...(detalleRunt ? { detalleRunt } : {}),
  campos: [],
  resumen: { coinciden: 0, difieren: 0, noVerificables: 0 },
  calculadoEn: ahora.toISOString(),
});

/** Solo si sigue `en_curso`: no pisa una fila que se reseteó mientras el job corría. */
async function persistir(impuestoId: string, semaforo: SemaforoImpuesto, comparacion: ComparacionFacturaRunt): Promise<void> {
  await db.update(flitoImpuestos).set({ semaforo, comparacionFacturaRunt: comparacion })
    .where(and(eq(flitoImpuestos.id, impuestoId), eq(flitoImpuestos.analisisEstado, AnalisisEstadoImpuesto.EN_CURSO)));
  log.info({
    impuestoId, semaforo, motivo: comparacion.motivo, detalleRunt: comparacion.detalleRunt, resumen: comparacion.resumen,
  }, 'comparacion: semáforo calculado');
}

/** Paso `comparacion` de la cola de la HU 12825. */
export const pasoComparacion: PasoAnalisis = async ({ impuestoId, runt, job }) => {
  const [fila] = await db.select({ extraccion: flitoImpuestos.extraccionFacturaVenta })
    .from(flitoImpuestos).where(eq(flitoImpuestos.id, impuestoId)).limit(1);
  const extraccion = fila?.extraccion;
  if (!extraccion) throw new SinExtraccionFacturaError();

  const ahora = new Date();
  if (facturaIlegible(extraccion)) {
    // Sin consultar el RUNT: ahorra cupo del limitador y no hay nada con qué comparar.
    await persistir(impuestoId, SemaforoImpuesto.ROJO, rojo(MotivoSemaforoRojo.ERROR_LECTURA_FACTURA, ahora));
    throw new FacturaIlegibleError();
  }

  const consulta = await consultarRuntDeImpuesto(impuestoId, runt);
  job.consultaRunt = consulta;
  await registrarAccesoSistema(
    impuestoId, ['placa', 'documento_propietario', 'vin'], `comparación factura vs RUNT · consulta=${consulta.estado}`,
  );

  if (consulta.estado !== 'ok') {
    // AC2: el traspaso en sincronización no tiene motivo propio.
    await persistir(impuestoId, SemaforoImpuesto.ROJO, rojo(MotivoSemaforoRojo.RUNT_SIN_RESPUESTA, ahora, consulta.estado));
    return;
  }
  const { semaforo, comparacion } = compararFacturaConRunt(extraccion, consulta.vehiculo, ahora);
  await persistir(impuestoId, semaforo, comparacion);
};
