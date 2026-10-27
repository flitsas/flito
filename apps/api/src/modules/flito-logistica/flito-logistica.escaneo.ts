// FLITO Logística — escaneo y validación de la LT (HU #14108, ADR-0030 §11). Ver cabecera del service.

import { and, eq, sql } from 'drizzle-orm';
import { EstadoDocumentoLogistica, parseLicenciaTransito } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { clients, flitoLogisticaDocumentos, flitoLogisticaEventos, flitoTramites, vehicles } from '../../db/schema.js';
import { uploadEntityDocument } from '../../services/storage.js';
import { LT, LogisticaError, aprobadoSql, log, normPlaca, transicionar, type LogisticaCtx } from './flito-logistica.base.js';

// ── Escaneo de la LT (mensajero en el organismo) ─────────────────────────────

export interface ResultadoEscaneo {
  resultado: 'recogido' | 'novedad' | 'duplicado' | 'sin_match' | 'no_gestionable';
  documentoId?: string;
  placa: string; vin: string;
  idFlit?: string; numeroLicencia?: string; propietarioNombre?: string | null; motivo?: string | null;
}

/**
 * Registra la recogida de una LT desde su código PDF417. Empareja por PLACA contra un trámite
 * aprobado (la placa es la llave; el VIN valida el resto). Coincide → documento 'recogido' + auto
 * clasificación (CA-03). VIN distinto → 'novedad' con motivo (RN-04). Sin trámite → 'sin_match' (no
 * persiste). Idempotente por (trámite, tipo): re-escanear la misma LT no duplica. El n.º de LT no
 * viaja en el código: llega por `numeroLt` (manual ahora, OCR después).
 */
export async function escanearLt(rawValue: string, numeroLt: string | null, evidencia: { lat?: string | null; lng?: string | null }, ctx: LogisticaCtx): Promise<ResultadoEscaneo> {
  const p = parseLicenciaTransito(rawValue);
  if (!p) throw new LogisticaError('No se pudo leer el código de la licencia. Reintenta el escaneo.');
  const placa = normPlaca(p.placa);
  const vin = p.vin.toUpperCase();

  const [t] = await db.select({
    tramiteId: flitoTramites.id, idFlit: flitoTramites.idFlit, organismoCodigo: flitoTramites.organismoCodigo,
    companiaId: flitoTramites.companiaId, companiaNit: flitoTramites.companiaNit,
    vehiculoId: flitoTramites.vehiculoId, vin: vehicles.vin,
    autogestionable: clients.logisticaAutogestionable,
  }).from(flitoTramites)
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .leftJoin(clients, eq(flitoTramites.companiaId, clients.id))
    .where(and(aprobadoSql, sql`upper(replace(${vehicles.plate}, '-', '')) = ${placa}`))
    .limit(1);

  if (!t) return { resultado: 'sin_match', placa, vin, motivo: 'No hay ningún trámite aprobado con esta placa.' };
  // Parametrización por compañía (RN-05): si la compañía autogestiona su logística, FLITO no la gestiona.
  if (t.autogestionable) return { resultado: 'no_gestionable', placa, vin, idFlit: t.idFlit, motivo: 'La logística de esta compañía es autogestionada por el cliente; FLITO no la gestiona.' };
  if (!t.companiaId) return { resultado: 'sin_match', placa, vin, idFlit: t.idFlit, motivo: 'El trámite de esta placa aún no tiene compañía FLITO asignada.' };
  if (!t.organismoCodigo) return { resultado: 'sin_match', placa, vin, idFlit: t.idFlit, motivo: 'El trámite de esta placa no tiene organismo emparejado.' };

  const vinCoincide = vin === (t.vin ?? '').toUpperCase();
  const estado = vinCoincide ? EstadoDocumentoLogistica.RECOGIDO : EstadoDocumentoLogistica.NOVEDAD;
  const motivo = vinCoincide ? null : `El VIN del código (${vin}) no coincide con el del trámite (${t.vin ?? '—'}).`;

  const salida = await db.transaction(async (tx) => {
    const [creado] = await tx.insert(flitoLogisticaDocumentos).values({
      tramiteId: t.tramiteId, tipo: LT, estado,
      organismoCodigo: t.organismoCodigo!, companiaId: t.companiaId, companiaNit: t.companiaNit,
      vehiculoId: t.vehiculoId, identificador: placa,
      numeroLicencia: p.numeroLicencia, numeroLt: numeroLt?.trim() || null,
      propietarioNombre: p.propietarioNombre, propietarioDocumento: p.propietarioDocumento,
      combustible: p.combustible, motivo,
      flitRaw: { raw: rawValue, parsed: { ...p, fotoBase64: p.fotoBase64 ? '<jpeg>' : null } },
    }).onConflictDoNothing({ target: [flitoLogisticaDocumentos.tramiteId, flitoLogisticaDocumentos.tipo] })
      .returning({ id: flitoLogisticaDocumentos.id });

    if (!creado) {
      // Ya se había escaneado esta LT (idempotente). Completa el n.º de LT si ahora sí llegó.
      const [existente] = await tx.select({ id: flitoLogisticaDocumentos.id })
        .from(flitoLogisticaDocumentos)
        .where(and(eq(flitoLogisticaDocumentos.tramiteId, t.tramiteId), eq(flitoLogisticaDocumentos.tipo, LT))).limit(1);
      if (numeroLt?.trim() && existente) {
        await tx.update(flitoLogisticaDocumentos).set({ numeroLt: numeroLt.trim(), updatedAt: new Date() }).where(eq(flitoLogisticaDocumentos.id, existente.id));
      }
      return { documentoId: existente?.id, duplicado: true };
    }

    await tx.insert(flitoLogisticaEventos).values({
      documentoId: creado.id, estadoAnterior: null, estadoNuevo: estado, actorId: ctx.userId,
      lat: evidencia.lat ?? null, lng: evidencia.lng ?? null, motivo, origen: 'usuario',
    });
    // Clasificación automática: la empresa destino ya vive en el trámite (CA-03), si el VIN cuadra.
    if (vinCoincide && t.companiaId) {
      await transicionar(tx, { id: creado.id, estado }, EstadoDocumentoLogistica.CLASIFICADO, ctx, { origen: 'api' });
    }
    return { documentoId: creado.id, duplicado: false };
  });

  // Foto del propietario embebida en el código (best-effort, fuera de la transacción).
  if (salida.documentoId && !salida.duplicado && p.fotoBase64) {
    try {
      const key = await uploadEntityDocument('flito-logistica-lt-fotos', salida.documentoId, 'foto.jpg', Buffer.from(p.fotoBase64, 'base64'), 'image/jpeg');
      await db.update(flitoLogisticaDocumentos).set({ fotoStorageKey: key }).where(eq(flitoLogisticaDocumentos.id, salida.documentoId));
    } catch (e) { log.warn({ err: (e as Error).message }, 'no se pudo guardar la foto de la LT'); }
  }

  const resultado: ResultadoEscaneo['resultado'] = salida.duplicado ? 'duplicado' : (vinCoincide ? 'recogido' : 'novedad');
  return { resultado, documentoId: salida.documentoId, placa, vin, idFlit: t.idFlit, numeroLicencia: p.numeroLicencia, propietarioNombre: p.propietarioNombre, motivo };
}

// ── Validación de una LT (sin persistir) ─────────────────────────────────────

export interface ResultadoValidacion {
  resultado: 'relacionada' | 'novedad' | 'sin_match' | 'no_gestionable' | 'ya_registrada';
  placa: string; vin: string;
  idFlit?: string; numeroLicencia?: string; propietarioNombre?: string | null; motivo?: string | null;
}

/**
 * Valida una LT contra los trámites aprobados SIN cambiar ningún estado. La usa el mensajero mientras
 * escanea en lote: ve al instante si cada LT se relaciona con un trámite, pero nada se registra hasta que
 * pulsa «Confirmar recogida» (ahí se llama a escanearLt por cada LT relacionada). Espejo de la búsqueda
 * de escanearLt, pero de solo lectura: 'relacionada' (placa+VIN OK), 'novedad' (VIN distinto), 'sin_match',
 * 'no_gestionable' (compañía autogestionada) o 'ya_registrada' (ya existe documento para ese trámite).
 */
export async function validarLt(rawValue: string): Promise<ResultadoValidacion> {
  const p = parseLicenciaTransito(rawValue);
  if (!p) throw new LogisticaError('No se pudo leer el código de la licencia. Reintenta el escaneo.');
  const placa = normPlaca(p.placa);
  const vin = p.vin.toUpperCase();

  const [t] = await db.select({
    tramiteId: flitoTramites.id, idFlit: flitoTramites.idFlit, organismoCodigo: flitoTramites.organismoCodigo,
    companiaId: flitoTramites.companiaId, vin: vehicles.vin, autogestionable: clients.logisticaAutogestionable,
  }).from(flitoTramites)
    .innerJoin(vehicles, eq(flitoTramites.vehiculoId, vehicles.id))
    .leftJoin(clients, eq(flitoTramites.companiaId, clients.id))
    .where(and(aprobadoSql, sql`upper(replace(${vehicles.plate}, '-', '')) = ${placa}`))
    .limit(1);

  if (!t) return { resultado: 'sin_match', placa, vin, motivo: 'No hay ningún trámite aprobado con esta placa.' };
  if (t.autogestionable) return { resultado: 'no_gestionable', placa, vin, idFlit: t.idFlit, motivo: 'La logística de esta compañía es autogestionada por el cliente; FLITO no la gestiona.' };
  if (!t.companiaId) return { resultado: 'sin_match', placa, vin, idFlit: t.idFlit, motivo: 'El trámite de esta placa aún no tiene compañía FLITO asignada.' };
  if (!t.organismoCodigo) return { resultado: 'sin_match', placa, vin, idFlit: t.idFlit, motivo: 'El trámite de esta placa no tiene organismo emparejado.' };

  const [existe] = await db.select({ id: flitoLogisticaDocumentos.id }).from(flitoLogisticaDocumentos)
    .where(and(eq(flitoLogisticaDocumentos.tramiteId, t.tramiteId), eq(flitoLogisticaDocumentos.tipo, LT))).limit(1);
  if (existe) return { resultado: 'ya_registrada', placa, vin, idFlit: t.idFlit, numeroLicencia: p.numeroLicencia, propietarioNombre: p.propietarioNombre, motivo: 'Esta LT ya fue registrada.' };

  const vinCoincide = vin === (t.vin ?? '').toUpperCase();
  return {
    resultado: vinCoincide ? 'relacionada' : 'novedad',
    placa, vin, idFlit: t.idFlit, numeroLicencia: p.numeroLicencia, propietarioNombre: p.propietarioNombre,
    motivo: vinCoincide ? null : `El VIN del código (${vin}) no coincide con el del trámite (${t.vin ?? '—'}).`,
  };
}
