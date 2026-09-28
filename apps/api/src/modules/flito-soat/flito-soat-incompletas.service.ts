// FLITO — SOAT, canal Cliente: solicitudes INCOMPLETAS por RUNT caído. Feature #12841, HU #12996.
// Diseño: docs/diseno-feature-12841-solicitud-incompleta-runt.md (§11 manda sobre §4).
// Decisión: docs/adr/ADR-0019-flito-soat-solicitud-incompleta-runt-caido.md (opción A, Aceptado).
//
// ── Qué hace ─────────────────────────────────────────────────────────────────────────────────────
//
// Cuando el alta del canal Cliente (`crearSolicitud`) consulta el RUNT y el registro no responde, la
// solicitud NO se pierde y NO se despacha: se APARCA en `flito_soat_incompletas` con su factura y su
// propietario. La pantalla recibe un 202 y le dice al usuario que quedó «pendiente de validar».
//
// ── Lo que este módulo NO hace, y por qué eso es la HU entera ───────────────────────────────────
//
//   · No escribe en `flito_soat` ni en `vehicles`. La incompleta no es un SOAT (CF-02): la cola, sus
//     facetas, el Excel, el ZIP de soportes, el envío al gestor y el cron de vigencia leen
//     `flito_soat` y por eso no la ven — sin un solo filtro nuevo que alguien pueda olvidar.
//   · No reutiliza `flito_soat_solicitud.verificacion_estado = 'caido'` (ADR-0019): ese valor es el
//     residuo histórico del intervalo #11935–#11966 y significa «despachada sin RUNT».
//   · No guarda nada del RUNT: el RUNT no respondió. Placa, marca, línea… llegan en el reintento.
//
// ── La clave de la factura se nombra con el id que TENDRÁ el SOAT ────────────────────────────────
//
// `soat_id_reservado` se genera aquí y nombra el objeto en S3 igual que el alta normal lo nombra con
// el `soatId`. Cuando el reintento complete la solicitud, el SOAT nacerá con ese mismo uuid y la
// factura ya estará donde el resto del sistema la busca, sin mover bytes.
//
// ── Logs (AC10) ──────────────────────────────────────────────────────────────────────────────────
//
// Solo el uuid de la incompleta y la compañía. Ni VIN, ni placa, ni documento, ni el mensaje crudo
// de ningún error: el desenlace del RUNT ya lo registra `consultarYClasificar` con un token de causa.

import { createHash, randomUUID } from 'crypto';
import { db } from '../../db/client.js';
import { flitoCompradores, flitoSoatIncompletas } from '../../db/schema.js';
import { EstadoSolicitudIncompletaSoat } from '@operaciones/shared-types';
import { carpetaDe } from '../flito-parametrizacion/flito-parametrizacion.service.js';
import { uploadEntityDocument } from '../../services/storage.js';
import { loggerFor } from '../../shared/logger.js';
import type { SoatCtx } from './flito-soat.service.js';
import type {
  ArchivoSolicitud,
  PropietarioSolicitud,
} from './flito-soat-cliente.service.js';
import type { ProcedenciaComprador } from '@operaciones/shared-types';

const log = loggerFor('flito-soat-incompletas');

/** Código de violación de unicidad de PostgreSQL: aquí, el índice parcial del VIN abierto. */
const UNIQUE_VIOLATION = '23505';

/**
 * El texto que acompaña al 202 (AC1). Constante exportada para que los tests la nombren en vez de
 * copiarla. No menciona el VIN: el mensaje explica qué pasó, no con qué vehículo.
 */
export const MENSAJE_SOLICITUD_INCOMPLETA =
  'El RUNT no respondió. Su solicitud quedó guardada, pendiente de validar, y no se enviará al gestor hasta que el RUNT confirme el vehículo.';

/** Lo que el alta ya validó y resolvió antes de aparcar: nada de esto se vuelve a decidir aquí. */
export interface EntradaAparcar {
  /** VIN tecleado y normalizado (`normalizarId`): el RUNT no respondió, no hay VIN efectivo. */
  vin: string;
  companiaId: number;
  carpetaStorage: string | null;
  propietario: PropietarioSolicitud;
  /** Nombre derivado (`nombreCompletoDe`), el mismo que escribe el alta normal. */
  nombreCompleto: string;
  /** Mapa completo (`procedenciaCompleta`), igual que el alta normal. */
  procedencia: ProcedenciaComprador;
  archivo: ArchivoSolicitud;
}

export type ResultadoAparcar =
  | { aparcada: true; id: string; soatIdReservado: string }
  /**
   * Otra petición abrió una incompleta para el mismo VIN entre la comprobación de la RN-01 y el
   * INSERT (el índice único parcial saltó). Quien llama decide el 409 volviendo a mirar la RN-01,
   * que sabe distinguir la forma propia de la ajena.
   */
  | { aparcada: false; motivo: 'vin_ocupado' };

/**
 * Aparca la solicitud (AC1): factura en S3 con la clave del `soat_id_reservado`, y en UNA
 * transacción la fila de `flito_soat_incompletas` (intentos = 1, último intento = ahora) y el
 * propietario en `flito_compradores` colgado de ella.
 *
 * El propietario recibe el MISMO tratamiento que en el alta normal (Ley 1581): misma tabla, mismas
 * columnas, mismo nombre derivado y el mismo mapa de procedencia. Así cualquier ejercicio de derechos
 * sobre `flito_compradores` lo encuentra.
 *
 * La subida va FUERA de la transacción (CA-11, igual que el alta): una transacción no puede
 * deshacer un PUT en S3, y retenerla abierta mientras sube el PDF es peor.
 */
export async function aparcarSolicitud(entrada: EntradaAparcar, ctx: SoatCtx): Promise<ResultadoAparcar> {
  const soatIdReservado = randomUUID();
  const { archivo } = entrada;
  const hash = createHash('sha256').update(archivo.buffer).digest('hex');
  const storageKey = await uploadEntityDocument(
    carpetaDe({ id: entrada.companiaId, flitoCarpetaStorage: entrada.carpetaStorage }, 'soat/facturas-venta'),
    soatIdReservado, archivo.originalname, archivo.buffer, archivo.mimetype,
  );

  const ahora = new Date();
  let id!: string;
  try {
    await db.transaction(async (tx) => {
      const [fila] = await tx.insert(flitoSoatIncompletas).values({
        soatIdReservado,
        companiaId: entrada.companiaId,
        vin: entrada.vin,
        estado: EstadoSolicitudIncompletaSoat.INCOMPLETA,
        facturaStorageKey: storageKey,
        facturaHash: hash,
        facturaNombreArchivo: archivo.originalname,
        facturaContentType: archivo.mimetype,
        facturaTamanoBytes: archivo.size,
        solicitadoPorId: ctx.userId,
        solicitadoPorNombre: ctx.username,
        solicitadoEn: ahora,
        // El alta ES el primer intento contra el RUNT (AC1).
        intentos: 1,
        ultimoIntentoEn: ahora,
        ultimoIntentoPorId: ctx.userId,
      }).returning({ id: flitoSoatIncompletas.id });
      id = fila.id;

      await tx.insert(flitoCompradores).values({
        soatIncompletaId: id,
        nombreCompleto: entrada.nombreCompleto,
        nombres: entrada.propietario.nombres,
        apellidos: entrada.propietario.apellidos,
        razonSocial: entrada.propietario.razonSocial,
        numeroDocumento: entrada.propietario.numeroDocumento,
        tipoDocumento: entrada.propietario.tipoDocumento,
        correo: entrada.propietario.correo,
        celular: entrada.propietario.celular,
        direccion: entrada.propietario.direccion,
        municipio: entrada.propietario.municipio,
        departamento: entrada.propietario.departamento,
        procedencia: entrada.procedencia,
        orden: 0,
      });
    });
  } catch (e) {
    if ((e as { code?: string })?.code === UNIQUE_VIOLATION) {
      log.warn({ companiaId: entrada.companiaId, desenlace: 'vin_ocupado' },
        'Solicitud SOAT incompleta no aparcada: el VIN ya tenía una incompleta abierta');
      return { aparcada: false, motivo: 'vin_ocupado' };
    }
    throw e;
  }

  log.info({ incompletaId: id, companiaId: entrada.companiaId },
    'Solicitud SOAT del canal Cliente aparcada como incompleta: el RUNT no respondió');
  return { aparcada: true, id, soatIdReservado };
}
