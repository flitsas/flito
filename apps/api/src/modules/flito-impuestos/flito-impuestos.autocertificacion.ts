// FLITO Impuestos — paso «autocertificacion» del análisis post-envío (HU #12828, Épica #12809,
// Feature #12822). Tercer paso de la cola de la HU 12825, después de `comparacion`.
//
//   AC1  Con la MISMA respuesta RUNT del análisis (`job.consultaRunt`, la dejó la 12827) se compara
//        FLITO contra RUNT con `compararConRunt`; si es certificable se crea la fila vigente en
//        `flito_impuesto_certificaciones` igual que `POST /:id/certificar` (misma función,
//        `certificarConRespuestaRunt`) y motor/serie van a `vehicles`. NO se vuelve a consultar el RUNT.
//   AC2  No certificable → sin fila nueva. El semáforo factura vs RUNT ya lo calculó `comparacion`.
//   AC3  «Reintentar validación» re-ejecuta el análisis completo (ruta de reanálisis de la 12825), así
//        que este paso corre de nuevo con la única consulta RUNT de esa corrida.
//
// No hace nada (y no lanza) si no hay consulta o no fue `ok`: el rojo por RUNT ya lo dejó la 12827 y
// el análisis queda `completado`. Idempotente: con certificación vigente no crea otra. Tampoco
// certifica fuera de los estados certificables (como el endpoint) ni si el análisis dejó de estar
// `en_curso` (una fila reseteada mientras el job corría).
//
// Carrera con una certificación manual (23505 del índice único parcial) = ya certificada: no lanza.
//
// Actor: el sistema (`certificado_por_id` NULL, nombre fijo). PII: se leen placa, documento, VIN y
// nombre del propietario y se persiste el snapshot RUNT → `pii_access_log` de sistema. Los logs llevan
// solo id, resultado y conteos.

import { and, eq } from 'drizzle-orm';
import {
  AnalisisEstadoImpuesto, ESTADOS_IMPUESTO_CERTIFICABLES, EstadoImpuesto, NOMBRE_CERTIFICADOR_AUTOMATICO,
  ResultadoCertificacion,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoImpuestoCertificaciones, flitoImpuestos } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import { errorSinPii, type PasoAnalisis } from './flito-impuestos.analisis.service.js';
import { certificarConRespuestaRunt, datosDelVehiculo, type ActorCertificacion } from './certificacion.service.js';
import { registrarAccesoSistema } from './flito-impuestos.extraccion.js';

const log = loggerFor('flito-impuestos.autocertificacion');

/** SQLSTATE de `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/** Firma de la certificación automática: sin usuario (FK nullable) y un nombre que el certificado imprime. */
export const ACTOR_AUTOCERTIFICACION: ActorCertificacion = {
  userId: null,
  // Una sola copia del literal: la cola (HU #12830) lo usa para distinguir la certificación automática.
  username: NOMBRE_CERTIFICADOR_AUTOMATICO,
};

/** Paso `autocertificacion` de la cola de la HU 12825. */
export const pasoAutocertificacion: PasoAnalisis = async ({ impuestoId, job }) => {
  const consulta = job.consultaRunt;
  if (!consulta || consulta.estado !== 'ok') {
    log.info({ impuestoId, consulta: consulta?.estado ?? 'ausente' }, 'autocertificacion: sin respuesta RUNT válida, no aplica');
    return;
  }

  const [imp] = await db.select({ estado: flitoImpuestos.estado, analisisEstado: flitoImpuestos.analisisEstado })
    .from(flitoImpuestos).where(eq(flitoImpuestos.id, impuestoId)).limit(1);
  if (!imp || imp.analisisEstado !== AnalisisEstadoImpuesto.EN_CURSO
    || !ESTADOS_IMPUESTO_CERTIFICABLES.includes(imp.estado as EstadoImpuesto)) {
    log.info({ impuestoId }, 'autocertificacion: impuesto no certificable ahora, no aplica');
    return;
  }

  const [vigente] = await db.select({ id: flitoImpuestoCertificaciones.id }).from(flitoImpuestoCertificaciones)
    .where(and(eq(flitoImpuestoCertificaciones.impuestoId, impuestoId), eq(flitoImpuestoCertificaciones.vigente, true)))
    .limit(1);
  if (vigente) {
    log.info({ impuestoId }, 'autocertificacion: ya tiene certificación vigente');
    return;
  }

  const datos = await datosDelVehiculo(impuestoId);
  // La certificación guarda con QUÉ se consultó; si el vehículo cambió entre la consulta y ahora
  // (documento que aparece o desaparece), la respuesta ya no corresponde a ese identificador.
  const via = datos?.ownerDocument?.trim() ? 'documento' : 'vin';
  if (!datos?.placa?.trim() || via !== consulta.via) {
    log.info({ impuestoId }, 'autocertificacion: datos del vehículo cambiaron desde la consulta, no aplica');
    return;
  }

  let r: Awaited<ReturnType<typeof certificarConRespuestaRunt>>;
  try {
    r = await certificarConRespuestaRunt(impuestoId, datos, consulta.data, ACTOR_AUTOCERTIFICACION);
  } catch (e) {
    // Una certificación manual concurrente ganó la carrera del índice único parcial (0121): el
    // impuesto YA está certificado. No es un fallo del análisis → sin lanzar, queda `completado`.
    if (errorSinPii(e).code === UNIQUE_VIOLATION) {
      log.info({ impuestoId }, 'autocertificacion: ya certificada por otro en paralelo');
      return;
    }
    throw e;
  }
  await registrarAccesoSistema(
    impuestoId, ['placa', 'documento_propietario', 'vin', 'nombre_propietario'], `autocertificación RUNT · resultado=${r.resultado}`,
  );
  log.info({
    impuestoId,
    resultado: r.resultado,
    bloqueantes: r.resultado === ResultadoCertificacion.CON_DIFERENCIAS ? r.diferenciasBloqueantes.length : 0,
  }, 'autocertificacion: evaluada');
};
