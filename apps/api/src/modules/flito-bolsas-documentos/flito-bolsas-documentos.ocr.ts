// FLITO — OCR de la fecha de expedición del expediente de la compañía (HU #13890, ADR-0028 D3/D8/§8).
//
// RN-BDO1  Solo Cámara, RUT y certificado bancario van al motor (Anthropic, vía flito-ocr). La cédula y
//          el adicional NUNCA se envían: nacen con `ocr_estado = 'no_aplica'` y aquí no se reclaman.
// RN-BDO2  Asíncrono: la carga responde primero y luego lanza `procesarOcr(id, buffer)`; el cron de
//          rescate lo llama sin buffer (descarga y descifra). Concurrencia acotada por proceso.
// RN-BDO3  Cada intento suma `ocr_intentos` al EMPEZAR. Motor no disponible (429, timeout, sin API key)
//          con intentos < 3 → sigue `validando` (lo retoma el rescate); con 3 → `fallido`. Cualquier
//          otro error → `fallido`. Sin fecha legible/confiable o fecha futura → `sin_fecha`.
// RN-BDO4  El OCR NUNCA pisa una fecha manual: el UPDATE de la fecha lleva
//          `WHERE fecha_origen IS DISTINCT FROM 'manual'`.
// RN-BDO5  Logs: solo id, tipo, estado y nombre del error. Nunca la fecha leída ni el contenido.
import { and, eq, sql } from 'drizzle-orm';
import { TIPOS_DOCUMENTO_BOLSA_CON_VIGENCIA } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoBolsasDocumentos } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import { crearLimitador } from '../../shared/utils/limitador.js';
import { hoyColombia } from '../../shared/utils/fecha-rango.js';
import { OcrNoDisponibleError } from '../flito-ocr/flito-ocr.service.js';
import { extraerFechaExpedicion, type TipoConFechaExpedicion } from '../flito-ocr/flito-ocr-expedicion.js';
import { archivoDe } from './flito-bolsas-documentos.service.js';

const log = loggerFor('flito-bolsas-documentos.ocr');
const t = flitoBolsasDocumentos;

export const MAX_INTENTOS_OCR = 3;
const CON_OCR = new Set<string>(TIPOS_DOCUMENTO_BOLSA_CON_VIGENCIA);

/** Tope de OCR simultáneos por proceso (D3). Ajustable sin desplegar código. */
const CONCURRENCIA = Math.max(1, Number(process.env.BOLSAS_DOCUMENTOS_OCR_CONCURRENCIA) || 2);
const limitador = crearLimitador(CONCURRENCIA);

export type ResultadoOcr = 'leido' | 'sin_fecha' | 'reintentar' | 'fallido' | 'omitido';

async function marcar(id: string, ocrEstado: 'sin_fecha' | 'fallido' | 'validando'): Promise<void> {
  await db.update(t).set({ ocrEstado, ocrActualizadoEn: new Date() }).where(eq(t.id, id));
}

/**
 * Lee la fecha de expedición de un documento y la persiste. Nunca lanza: el resultado sale en el
 * valor de retorno (lo usan el rescate y los tests) y en el log sin PII.
 */
export async function procesarOcr(id: string, buffer?: Buffer): Promise<ResultadoOcr> {
  let tipo = 'desconocido';
  let intentos = 0;
  try {
    // Reclamo: solo filas aún en `validando` (las `no_aplica` —cédula, adicional— no entran nunca).
    const [fila] = await db.update(t)
      .set({ ocrIntentos: sql`${t.ocrIntentos} + 1`, ocrActualizadoEn: new Date() })
      .where(and(eq(t.id, id), eq(t.ocrEstado, 'validando')))
      .returning({ tipo: t.tipo, mime: t.mime, ocrIntentos: t.ocrIntentos });
    if (!fila) return 'omitido';
    tipo = fila.tipo;
    intentos = fila.ocrIntentos;
    if (!CON_OCR.has(fila.tipo)) return 'omitido'; // D8: defensa en profundidad; el CHECK ya lo impide.
    if (intentos > MAX_INTENTOS_OCR) {
      await marcar(id, 'fallido');
      log.warn({ id, tipo, estado: 'fallido' }, 'OCR de documento: intentos agotados');
      return 'fallido';
    }

    const leido = await limitador.ejecutar(async () => {
      const contenido = buffer ?? (await archivoDe(id)).contenido;
      return extraerFechaExpedicion(
        { nombreArchivo: `${fila.tipo}`, contentType: fila.mime, contenido }, fila.tipo as TipoConFechaExpedicion,
      );
    });

    if (!leido.fecha || !leido.confiable || leido.fecha > hoyColombia()) {
      await marcar(id, 'sin_fecha');
      log.info({ id, tipo, estado: 'sin_fecha' }, 'OCR de documento: sin fecha legible');
      return 'sin_fecha';
    }

    // RN-BDO4: la fecha solo se escribe si no hay una manual; el estado del OCR se cierra igual.
    await db.update(t).set({ fechaExpedicion: leido.fecha, fechaOrigen: 'ocr' })
      .where(and(eq(t.id, id), sql`${t.fechaOrigen} IS DISTINCT FROM ${'manual'}`));
    await db.update(t).set({ ocrEstado: 'leido', ocrActualizadoEn: new Date() }).where(eq(t.id, id));
    log.info({ id, tipo, estado: 'leido' }, 'OCR de documento: fecha leída');
    return 'leido';
  } catch (e) {
    const err = (e as Error)?.name ?? 'Error';
    // Sin reclamo (falló antes del UPDATE inicial) no se toca la fila: sigue `validando` para el rescate.
    const sinReclamo = intentos === 0;
    const reintentable = sinReclamo || (e instanceof OcrNoDisponibleError && intentos < MAX_INTENTOS_OCR);
    const estado = reintentable ? 'validando' : 'fallido';
    try {
      // Reintentable: sigue en `validando` con su marca de tiempo; el rescate lo retoma en ≥ 3 min.
      if (!sinReclamo) await marcar(id, estado);
    } catch (e2) {
      log.error({ id, tipo, err: (e2 as Error)?.name }, 'OCR de documento: no se pudo registrar el fallo');
    }
    log.warn({ id, tipo, estado, err, intentos }, 'OCR de documento: falló');
    return reintentable ? 'reintentar' : 'fallido';
  }
}

/** Lanza el OCR sin esperar (después de responder la carga). Nunca rechaza. */
export function lanzarOcr(id: string, buffer?: Buffer): void {
  void procesarOcr(id, buffer).catch((e: unknown) => {
    log.error({ id, err: (e as Error)?.name }, 'OCR de documento: error inesperado');
  });
}
