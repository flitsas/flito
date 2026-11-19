// FLITO — SOAT, canal Cliente: COMPLETAR una pendiente de la carga masiva (HU #14136, Feature #14014, Épica #13760).
// Diseño: docs/diseno-feature-14013-14014-carga-masiva-soat.md; ADR-0019 (la pendiente vive en `flito_soat_incompletas`).
//
// Dos operaciones sobre una incompleta con `motivo_pendiente` ∈ {falta_factura_venta, faltan_datos_propietario}:
//
//   · `adjuntarFactura` — lee la factura con el OCR del formulario individual (`extraerFacturaVenta`), exige un PDF REAL
//     (bytes) y, en Inicial, que el VIN de la factura sea el de la solicitud (AC4). La factura queda guardada donde el alta
//     la busca (`<carpeta>/soat/facturas-venta`, nombrada con el `soat_id_reservado`) y referenciada en la incompleta. La
//     solicitud SIGUE pendiente (AC1): nada pasa a `solicitado` aquí. El documento ya consultado manda sobre el de la
//     factura: si difiere se AVISA sin sobrescribir.
//   · `confirmarIncompleta` — exige confirmación explícita (la ruta, AC5), repite la compuerta del RUNT (VIN en Inicial;
//     placa + documento en Renovación, AC3) y completa por el MISMO camino del reintento (`completar`): despacho con
//     `soat_id_reservado`, propietario y factura, todo en una transacción con `SELECT … FOR UPDATE` de la incompleta que
//     re-comprueba el estado. Dos confirmaciones simultáneas: gana una; la otra espera el bloqueo y sale con 409 (AC9).
//
// Alcance: 404 sin revelar existencia fuera de la compañía (AC7). Logs: solo uuid, compañía y desenlace; nunca VIN,
// placa, documento ni el mensaje de un error (AGENTS.md §14).

import { createHash } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoCompradores, flitoSoatIncompletas } from '../../db/schema.js';
import {
  CodigoErrorSolicitudSoat, EstadoSoat, EstadoSolicitudIncompletaSoat,
  type ExtraccionFacturaVenta, type ProcedenciaCompradorPersistida,
} from '@operaciones/shared-types';
import { loggerFor } from '../../shared/logger.js';
import { uploadEntityDocument } from '../../services/storage.js';
import { extraerFacturaVenta, OcrNoDisponibleError } from '../flito-ocr/flito-ocr.service.js';
import { carpetaDe, umbralPara } from '../flito-parametrizacion/flito-parametrizacion.service.js';
import type { SoatCtx } from './flito-soat.service.js';
import { actualEstaAbierto, soatActualDelVin } from './flito-soat-actual.js';
import {
  canalDeLaCompania, normalizarId, SolicitudSoatError, verificarPdfReal, verificarRuntCompuerta,
  type ArchivoSolicitud, type DestinoCanalCliente, type PropietarioSolicitud,
} from './flito-soat-cliente.service.js';
import type { ConsultaRunt } from './flito-soat-cliente-consulta.js';
import { condicionAlcance } from './flito-soat-incompletas.service.js';
import { completar, IncompletaYaResueltaError } from './flito-soat-incompletas-reintento.service.js';

const log = loggerFor('flito-soat-incompletas');

const UNIQUE_VIOLATION = '23505';

/** Los dos motivos que se resuelven completando (los pone el worker de la carga masiva, HU #14135). */
const MOTIVOS_COMPLETABLES = ['falta_factura_venta', 'faltan_datos_propietario'] as const;

export const CODIGO_VIN_FACTURA_NO_COINCIDE = 'vin_factura_no_coincide';
export const MENSAJE_VIN_FACTURA_NO_COINCIDE = 'El VIN de la factura no coincide con el de la solicitud';

/** AC4: 422 con código propio; la solicitud no cambia. */
export class VinFacturaNoCoincideError extends Error {
  readonly status = 422;
  readonly codigo = CODIGO_VIN_FACTURA_NO_COINCIDE;
  constructor() { super(MENSAJE_VIN_FACTURA_NO_COINCIDE); this.name = 'VinFacturaNoCoincideError'; }
}

interface PendienteLeida {
  id: string; estado: string; vin: string | null; placa: string | null; tipoSoat: string;
  motivoPendiente: string; companiaId: number; soatIdReservado: string;
  facturaStorageKey: string | null;
}

/** La pendiente dentro del alcance del usuario; `null` = no existe o es de otra compañía (404-no-403, AC7). */
async function cargarPendiente(id: string, ctx: SoatCtx): Promise<PendienteLeida | null> {
  const alcance = condicionAlcance(ctx);
  if (alcance === null) return null;
  const [inc] = await db.select({
    id: flitoSoatIncompletas.id, estado: flitoSoatIncompletas.estado, vin: flitoSoatIncompletas.vin,
    placa: flitoSoatIncompletas.placa, tipoSoat: flitoSoatIncompletas.tipoSoat,
    motivoPendiente: flitoSoatIncompletas.motivoPendiente, companiaId: flitoSoatIncompletas.companiaId,
    soatIdReservado: flitoSoatIncompletas.soatIdReservado, facturaStorageKey: flitoSoatIncompletas.facturaStorageKey,
  }).from(flitoSoatIncompletas).where(and(eq(flitoSoatIncompletas.id, id), alcance)).limit(1);
  return inc ?? null;
}

/** Ya resuelta → 409 con el estado; motivo ajeno a este flujo → 409 `incompleta_no_reintentable`. */
function exigirCompletable(inc: PendienteLeida): void {
  if (inc.estado !== EstadoSolicitudIncompletaSoat.INCOMPLETA) {
    throw new IncompletaYaResueltaError(inc.estado, false, inc.vin, inc.placa);
  }
  if (!(MOTIVOS_COMPLETABLES as readonly string[]).includes(inc.motivoPendiente)) {
    throw new SolicitudSoatError(409, CodigoErrorSolicitudSoat.INCOMPLETA_NO_REINTENTABLE,
      'Esta solicitud no se completa con una factura: tiene otro motivo pendiente.');
  }
}

// ═════════ Adjuntar la factura ═════════════════════════════════════════════════════════════════════

export interface FacturaAdjuntada {
  /** La extracción del OCR para PRELLENAR; cada campo con su confianza. Vacía si el lector no está disponible. */
  extraccion: ExtraccionFacturaVenta;
  /** `no_disponible` = el OCR no pudo leerla (AC6): la factura quedó guardada y se sigue con datos a mano. */
  lectura: 'ok' | 'no_disponible';
  /** `true` si el VIN de la factura se leyó con confianza y coincide; `false` si no se pudo verificar. */
  vinVerificado: boolean;
  /** El documento ya consultado/registrado manda: si la factura trae otro, se avisa y NO se sobrescribe. */
  documentoDifiere: boolean;
  /** La solicitud sigue pendiente (AC1). */
  estado: typeof EstadoSolicitudIncompletaSoat.INCOMPLETA;
}

export async function adjuntarFactura(
  id: string, archivo: ArchivoSolicitud, ctx: SoatCtx,
): Promise<FacturaAdjuntada | null> {
  const inc = await cargarPendiente(id, ctx);
  if (!inc) return null;
  exigirCompletable(inc);
  const canal = await canalDeLaCompania(ctx, inc.companiaId);
  await verificarPdfReal(archivo); // MIME REAL por bytes (AC8), antes de mandar nada al OCR

  let extraccion: ExtraccionFacturaVenta = {};
  let lectura: 'ok' | 'no_disponible' = 'ok';
  try {
    extraccion = await extraerFacturaVenta({
      nombreArchivo: archivo.originalname, contentType: 'application/pdf', contenido: archivo.buffer, umbral: umbralPara(null),
    });
  } catch (e) {
    if (!(e instanceof OcrNoDisponibleError)) throw e;
    lectura = 'no_disponible'; // AC6: igual que el formulario individual, se sigue a mano
  }

  // AC4: solo un VIN leído con confianza puede RECHAZAR; uno dudoso no se verifica y lo revisa la persona.
  const leidoVin = extraccion.vin;
  const vinFactura = leidoVin?.confiable && leidoVin.valor ? normalizarId(leidoVin.valor) : null;
  if (vinFactura && inc.vin && vinFactura !== normalizarId(inc.vin)) throw new VinFacturaNoCoincideError();

  const documentoDifiere = await documentoDifiereDe(inc.id, extraccion);

  const carpeta = carpetaDe({ id: canal.companiaId, flitoCarpetaStorage: canal.carpetaStorage }, 'soat/facturas-venta');
  const storageKey = await uploadEntityDocument(carpeta, inc.soatIdReservado, archivo.originalname, archivo.buffer, 'application/pdf');
  const guardada = await db.update(flitoSoatIncompletas).set({
    facturaStorageKey: storageKey,
    facturaHash: createHash('sha256').update(archivo.buffer).digest('hex'),
    facturaNombreArchivo: archivo.originalname.slice(0, 255),
    facturaContentType: 'application/pdf',
    facturaTamanoBytes: archivo.size,
    updatedAt: new Date(),
  }).where(and(
    eq(flitoSoatIncompletas.id, inc.id), eq(flitoSoatIncompletas.estado, EstadoSolicitudIncompletaSoat.INCOMPLETA),
  )).returning({ id: flitoSoatIncompletas.id });
  // Otra petición la resolvió mientras se leía: la fila no se tocó.
  if (guardada.length === 0) throw new IncompletaYaResueltaError(EstadoSolicitudIncompletaSoat.COMPLETADA, false, inc.vin, inc.placa);

  log.info({ incompletaId: inc.id, companiaId: inc.companiaId, lectura }, 'Factura adjuntada a una solicitud SOAT pendiente');
  return {
    extraccion, lectura, vinVerificado: vinFactura !== null, documentoDifiere,
    estado: EstadoSolicitudIncompletaSoat.INCOMPLETA,
  };
}

async function documentoDifiereDe(incompletaId: string, extraccion: ExtraccionFacturaVenta): Promise<boolean> {
  const deFactura = extraccion.numeroDocumento?.valor;
  if (!deFactura) return false;
  const [p] = await db.select({ numeroDocumento: flitoCompradores.numeroDocumento }).from(flitoCompradores)
    .where(eq(flitoCompradores.soatIncompletaId, incompletaId)).orderBy(asc(flitoCompradores.orden)).limit(1);
  return !!p && normalizarId(p.numeroDocumento) !== normalizarId(deFactura);
}

// ═════════ Confirmar ═══════════════════════════════════════════════════════════════════════════════

export interface ConfirmacionInput {
  propietario: PropietarioSolicitud;
  procedencia: ProcedenciaCompradorPersistida | null;
}

export interface ConfirmacionHecha {
  soatId: string;
  estado: typeof EstadoSoat.SOLICITADO;
  /** Para el rastro de PII de la ruta (se anota como token/HMAC, nunca en claro). */
  vin: string;
  placa: string | null;
  tipoSoat: 'inicial' | 'renovacion';
  destino: DestinoCanalCliente;
}

const vinOcupado = () => new SolicitudSoatError(409, CodigoErrorSolicitudSoat.VIN_YA_TIENE_SOAT,
  'Este vehículo ya tiene una solicitud de SOAT.');

export async function confirmarIncompleta(
  id: string, input: ConfirmacionInput, ctx: SoatCtx,
): Promise<ConfirmacionHecha | null> {
  const inc = await cargarPendiente(id, ctx);
  if (!inc) return null;
  exigirCompletable(inc);
  await canalDeLaCompania(ctx, inc.companiaId);

  const renovacion = inc.tipoSoat === 'renovacion';
  const tipoSoat = renovacion ? 'renovacion' as const : 'inicial' as const;
  // Inicial: la factura es obligatoria (RN del alta). Renovación: opcional (HU #14018, AC2).
  if (!renovacion && inc.facturaStorageKey === null) {
    throw new SolicitudSoatError(400, CodigoErrorSolicitudSoat.ARCHIVO_NO_PDF, 'Falta la factura de venta (PDF)');
  }
  let consulta: ConsultaRunt;
  if (renovacion) {
    if (!inc.placa) {
      throw new SolicitudSoatError(409, CodigoErrorSolicitudSoat.INCOMPLETA_NO_REINTENTABLE, 'Esta solicitud no tiene placa para consultar el RUNT.');
    }
    consulta = { modalidad: 'placa', placa: inc.placa, documento: input.propietario.numeroDocumento };
  } else {
    consulta = { modalidad: 'vin', vin: normalizarId(inc.vin ?? '') };
  }

  // La compuerta se REPITE aquí (AC2/AC3): 503/422/409 salen tal cual y la pendiente no cambia.
  const runt = await verificarRuntCompuerta(consulta, tipoSoat);
  const vin = runt.vinEfectivo;
  if (inc.vin && normalizarId(inc.vin) !== normalizarId(vin)) {
    throw new SolicitudSoatError(422, CodigoErrorSolicitudSoat.RUNT_NO_CUADRA, 'Los datos no coinciden con los de la solicitud.');
  }
  const actual = await soatActualDelVin(db, vin);
  if (actual && (tipoSoat === 'inicial' || actualEstaAbierto(actual) || actual.companiaId !== inc.companiaId)) throw vinOcupado();

  try {
    const r = await completar(inc, {
      vin, datos: runt.datos, organismoCodigo: runt.organismoCodigo, vigenciaProxima: runt.vigenciaProxima,
      tipoSoat, soatAnteriorId: tipoSoat === 'renovacion' ? actual?.id ?? null : null,
      propietarioNuevo: { propietario: input.propietario, procedencia: input.procedencia },
    }, runt.consultadoEn, ctx);
    log.info({ incompletaId: inc.id, companiaId: inc.companiaId, desenlace: 'confirmada' }, 'Solicitud SOAT pendiente confirmada y despachada');
    return { soatId: r.soatId, estado: EstadoSoat.SOLICITADO, vin, placa: runt.datos.placa, tipoSoat, destino: r.destino };
  } catch (e) {
    if ((e as { code?: string })?.code === UNIQUE_VIOLATION) throw vinOcupado();
    throw e;
  }
}
