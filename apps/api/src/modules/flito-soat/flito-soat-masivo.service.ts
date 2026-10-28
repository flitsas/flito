// FLITO — SOAT, canal Cliente: carga masiva sin trámite, lado API de recibir/validar (HU #14131, Feature
// #14013, ADR-0032). Habla con `flito-soat` (NO el `soat/` legacy).
//
//   · Alta: valida compañía (alcance + canal abierto + cliente operable), un lote activo por compañía,
//     lee el XLSX y deja el lote `en_cola` con una fila por registro. NO lo procesa: el worker es la
//     HU #14132. Filas con formato inválido o repetidas nacen `rechazada` con su motivo (diseño §4.1).
//   · Avance: contadores por estado de fila, SIN PII, solo para la compañía dueña (404 fuera de alcance).
//
// PII (AGENTS.md §14/§16): las filas guardan lo tecleado (efímero, ADR-0032); nada de eso entra en logs,
// en mensajes de error ni en la respuesta del avance. El Excel no se persiste (solo su sha256).

import { createHash } from 'node:crypto';
import { and, count, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoSoatIncompletas, flitoSoatMasivoFilas, flitoSoatMasivoLotes, users } from '../../db/schema.js';
import { canalDeLaCompania } from './flito-soat-cliente.service.js';
import { exigirClienteOperable } from '../clients/cliente-operable.js';
import type { SoatCtx } from './flito-soat.service.js';
import { falloMasivo } from './flito-soat-masivo.errors.js';
import { parsearXlsxRenovacion } from './flito-soat-masivo-parse.js';
import { parsearXlsxInicial } from './flito-soat-masivo-parse-inicial.js';
import { textoMotivo } from './flito-soat-masivo-motivos.js';
import { descargaVencida, purgarPiiRechazadas } from './flito-soat-masivo-purga.js';

export interface LoteCreado {
  loteId: string;
  tipo: 'renovacion' | 'inicial';
  total: number;
  aceptadasEnCola: number;
  rechazadasDeEntrada: number;
}

export interface AvanceLote {
  loteId: string;
  estado: string;
  tipo: string;
  total: number;
  pendientes: number;
  procesando: number;
  aceptadas: number;
  porValidar: number;
  rechazadas: number;
  motivosRechazo: Array<{ codigo: string; mensaje: string; cantidad: number }>;
  creadoEn: string;
  /** HU #14133 (AC1): solo con el lote terminado; creadas + porValidar + rechazadas = total (contadores congelados). */
  resumen: {
    total: number; creadas: number; porValidar: number; rechazadas: number;
    /** HU #14135 (AC2): de las «por validar», las que esperan la factura de venta y las que esperan los datos del propietario. */
    porValidarFactura: number; porValidarPropietario: number;
  } | null;
  /** HU #14133 (AC4/AC5): ¿se ofrece la descarga de las rechazadas? Nunca con el lote sin terminar. */
  descargaRechazadas: boolean;
}

const MENSAJE_LOTE_ACTIVO = 'Ya hay una carga masiva en curso para esta compañía. Espera a que termine para subir otra.';
const esViolacionUnica = (e: unknown): boolean => {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return err?.code === '23505' || err?.cause?.code === '23505';
};

async function loteActivoDe(companiaId: number): Promise<string | null> {
  const [l] = await db.select({ id: flitoSoatMasivoLotes.id }).from(flitoSoatMasivoLotes)
    .where(and(eq(flitoSoatMasivoLotes.companiaId, companiaId), inArray(flitoSoatMasivoLotes.estado, ['en_cola', 'procesando'])))
    .limit(1);
  return l?.id ?? null;
}

export async function crearLoteMasivo(
  buffer: Buffer, tipo: string, ctx: SoatCtx, companiaIdPedida: number | null,
): Promise<LoteCreado> {
  if (tipo !== 'renovacion' && tipo !== 'inicial') throw falloMasivo(400, 'tipo_invalido', 'El tipo de plantilla no es válido.');
  // AC7: alcance (403 sin compañía / ajena, 400 admin sin elegir), canal abierto (403) y cliente operable (409).
  const canal = await canalDeLaCompania(ctx, companiaIdPedida);
  await exigirClienteOperable(db, canal.companiaId, 'SOAT');
  // AC6: un lote activo por compañía (pre-chequeo barato; la carrera la cierra el índice único parcial).
  const activo = await loteActivoDe(canal.companiaId);
  if (activo) throw falloMasivo(409, 'lote_activo', MENSAJE_LOTE_ACTIVO, { loteId: activo });

  // Filas homogéneas para el INSERT: Renovación (placa/doc/nombre/correo/celular) o Inicial (solo VIN).
  const filas: Array<{ nFila: number; motivoRechazo: string | null; placa?: string; documento?: string; nombre?: string; correo?: string; celular?: string; vin?: string }> =
    tipo === 'inicial' ? (await parsearXlsxInicial(buffer)).filas : (await parsearXlsxRenovacion(buffer)).filas;
  const hash = createHash('sha256').update(buffer).digest('hex');
  const [u] = await db.select({ nombre: users.name }).from(users).where(eq(users.id, ctx.userId)).limit(1);
  const creadoPorNombre = (u?.nombre || ctx.username || 'usuario').slice(0, 150);

  try {
    const loteId = await db.transaction(async (tx) => {
      const [lote] = await tx.insert(flitoSoatMasivoLotes).values({
        companiaId: canal.companiaId, creadoPorId: ctx.userId, creadoPorNombre, tipoSoat: tipo,
        estado: 'en_cola', totalFilas: filas.length, archivoHash: hash,
      }).returning({ id: flitoSoatMasivoLotes.id });
      await tx.insert(flitoSoatMasivoFilas).values(filas.map((f) => ({
        loteId: lote!.id, nFila: f.nFila,
        estado: f.motivoRechazo ? 'rechazada' : 'pendiente', motivoRechazo: f.motivoRechazo,
        placa: f.placa || null, documento: f.documento || null, nombre: f.nombre || null,
        correo: f.correo || null, celular: f.celular || null, vin: f.vin || null,
      })));
      return lote!.id;
    });
    const rechazadas = filas.filter((f) => f.motivoRechazo).length;
    return { loteId, tipo, total: filas.length, aceptadasEnCola: filas.length - rechazadas, rechazadasDeEntrada: rechazadas };
  } catch (e) {
    if (esViolacionUnica(e)) {
      throw falloMasivo(409, 'lote_activo', MENSAJE_LOTE_ACTIVO, { loteId: await loteActivoDe(canal.companiaId) });
    }
    throw e;
  }
}

/**
 * AC8: el avance solo lo ve la compañía dueña. Alcance `compania` → su `companiaId`; `todo` (operación FLIT
 * sin enlace) → cualquiera, como el resto del módulo; proveedor / nada → nada. Todo lo demás es `null`
 * (la ruta responde 404, nunca 403: no se confirma que el lote exista).
 */
export async function cargarLoteEnAlcance(loteId: string, ctx: SoatCtx): Promise<typeof flitoSoatMasivoLotes.$inferSelect | null> {
  if (ctx.alcance === 'proveedor' || ctx.alcance === 'nada') return null;
  if (ctx.alcance === 'compania' && !ctx.companiaId) return null;
  const [lote] = await db.select().from(flitoSoatMasivoLotes).where(eq(flitoSoatMasivoLotes.id, loteId)).limit(1);
  if (!lote) return null;
  if (ctx.alcance === 'compania' && lote.companiaId !== ctx.companiaId) return null;
  return lote;
}

export async function avanceLote(loteId: string, ctx: SoatCtx): Promise<AvanceLote | null> {
  const lote = await cargarLoteEnAlcance(loteId, ctx);
  if (!lote) return null;
  const ahora = new Date();
  const terminado = lote.estado === 'terminado';
  // Purga perezosa: aunque el worker esté apagado, el plazo se cumple al consultar.
  if (terminado && descargaVencida(lote, ahora)) await purgarPiiRechazadas(ahora, lote.id);

  const porEstado = await db.select({ estado: flitoSoatMasivoFilas.estado, n: count() })
    .from(flitoSoatMasivoFilas).where(eq(flitoSoatMasivoFilas.loteId, loteId)).groupBy(flitoSoatMasivoFilas.estado);
  const motivos = await db.select({ codigo: flitoSoatMasivoFilas.motivoRechazo, n: count() })
    .from(flitoSoatMasivoFilas)
    .where(and(eq(flitoSoatMasivoFilas.loteId, loteId), eq(flitoSoatMasivoFilas.estado, 'rechazada')))
    .groupBy(flitoSoatMasivoFilas.motivoRechazo);
  // AC2 (HU #14135): las «por validar» se distinguen por el motivo de su pendiente (factura vs datos del propietario).
  const pv = terminado ? await db.select({ motivo: flitoSoatIncompletas.motivoPendiente, n: count() })
    .from(flitoSoatMasivoFilas).innerJoin(flitoSoatIncompletas, eq(flitoSoatIncompletas.id, flitoSoatMasivoFilas.incompletaId))
    .where(and(eq(flitoSoatMasivoFilas.loteId, loteId), eq(flitoSoatMasivoFilas.estado, 'por_validar')))
    .groupBy(flitoSoatIncompletas.motivoPendiente) : [];
  const nPv = (m: string) => Number(pv.find((r) => r.motivo === m)?.n ?? 0);
  const n = (e: string) => Number(porEstado.find((r) => r.estado === e)?.n ?? 0);
  return {
    loteId: lote.id, estado: lote.estado, tipo: lote.tipoSoat, total: lote.totalFilas,
    pendientes: n('pendiente'), procesando: n('consultando'), aceptadas: n('aceptada'),
    porValidar: n('por_validar'), rechazadas: n('rechazada'),
    motivosRechazo: motivos.filter((m) => m.codigo).map((m) => ({ codigo: m.codigo!, mensaje: textoMotivo(m.codigo!, null, lote.tipoSoat === 'inicial' ? 'inicial' : 'renovacion'), cantidad: Number(m.n) })),
    creadoEn: lote.creadoEn.toISOString(),
    resumen: terminado
      ? { total: lote.totalFilas, creadas: lote.nAceptadas ?? 0, porValidar: lote.nPorValidar ?? 0, rechazadas: lote.nRechazadas ?? 0,
        porValidarFactura: nPv('falta_factura_venta'), porValidarPropietario: nPv('faltan_datos_propietario') }
      : null,
    descargaRechazadas: terminado && (lote.nRechazadas ?? 0) > 0 && !descargaVencida(lote, ahora),
  };
}

