// HU #14114 (Feature C2 #14092, Épica #13758, ADR-0030 C3a) — registrar traslado.
// HU #14122: destino `flit` (motivo activo + precio `logistica_flit`) y salida de FLIT
// (`destino: cliente` + `origen: flit`). El ciclo vive en `flito-logistica-traslados-ciclo.service.ts`.
//
// En una transacción: bloquea las LT (`ORDER BY id FOR UPDATE`), exige trámite resuelto (C1.8),
// congela precio+vigencia, estampa el proveedor de la compañía, crea traslado + líneas + acta
// y mueve las LT a `en_acta` con evento `destino_registrado`.

import { and, eq, inArray, sql } from 'drizzle-orm';
import { EstadoActaLogistica, EstadoDocumentoLogistica } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import {
  clients, flitoLogisticaActaLineas, flitoLogisticaActas, flitoLogisticaDocumentos,
  flitoLogisticaEventos, flitoLogisticaTrasladoLts, flitoLogisticaTraslados,
} from '../../db/schema.js';
import { proveedorDeCompania } from '../flito-parametrizacion/flito-logistica-proveedor-compania.service.js';
import { exigirTramiteResuelto, insertarEvento, log, transicionar, type DbOrTx, type LogisticaCtx } from './flito-logistica.base.js';
import { listarMotivosActivos } from './flito-logistica-motivos.service.js';
import { conceptoPrecioDe, precioTrasladoDe, type DestinoTraslado } from './flito-logistica-precios.js';
import { generarActaPdf } from './flito-logistica.acta-pdf.js';
import {
  CompaniaNoEncontradaTrasladoError, DatosInvalidosTrasladoError, LogisticaAutogestionadaTrasladoError,
  LtAjenaTrasladoError, LtEstadoNoAdmisibleError, LtNoEnFlitError, LtNoEncontradaTrasladoError, LtYaEnTrasladoError,
  MotivoLlegadaRequeridoError, PrecioTrasladoNoConfiguradoError, ProveedorLogisticaRequeridoError,
  TrasladoCompaniaMixtaError, TrasladoOrigenMixtoError,
} from './flito-logistica-traslados.errors.js';

export interface LtEntradaTraslado { documentoId: string; motivoLlegadaId?: string; nota?: string }

export interface RegistrarTrasladoInput {
  companiaId: number;
  destino: DestinoTraslado;
  /** Solo se honra si `destino = 'cliente'`. Omitido = `origenDe` del estado de las LT. */
  origen?: 'organismo' | 'flit';
  lts: LtEntradaTraslado[];
  /** Fallback de cada LT cuando el destino es FLIT. En un viaje a cliente se ignora. */
  motivoLlegadaId?: string;
  mensajeroId?: number;
}

export interface TrasladoLtDto {
  documentoId: string;
  precio: number;
  tarifaVigenciaId: string | null;
  actaOrganismoPendiente: boolean;
  /** Null en un viaje a cliente: el motivo no se persiste. */
  motivoLlegadaId: string | null;
  motivoPorId: number | null;
  motivoEn: Date | null;
}

/** DTO de lectura: sin cédula (completa ni enmascarada). */
export interface TrasladoDetalle {
  id: string;
  companiaId: number;
  destino: DestinoTraslado;
  origen: 'organismo' | 'flit';
  estado: string;
  mensajeroId: number | null;
  actaId: string;
  documentos: number;
  lts: TrasladoLtDto[];
}

const ESTADOS_VIVOS = ['registrado', 'en_ruta', 'entregado'] as const;

function esUnicaViolada(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === '23505' || err?.cause?.code === '23505';
}

function origenDe(estado: string): 'organismo' | 'flit' {
  return estado === 'en_flit' ? 'flit' : 'organismo';
}

function admiteDestinoCliente(estado: string): boolean {
  return estado === EstadoDocumentoLogistica.CLASIFICADO || estado === 'en_flit';
}

function aNumeric(n: number): string {
  return (Math.round(n * 100) / 100).toFixed(2);
}

/**
 * Viaje a cliente. `origen` omitido = el de hoy (`origenDe`). `origen: 'flit'` solo arma la salida
 * de FLIT: una LT que no está `en_flit` es 409, y no se come el viaje directo.
 */
function origenClienteDe(
  docs: Array<{ id: string; estado: string }>,
  pedido: 'organismo' | 'flit' | undefined,
): 'organismo' | 'flit' {
  if (pedido === 'flit') {
    const fuera = docs.filter((d) => d.estado !== 'en_flit').map((d) => d.id);
    if (fuera.length) throw new LtNoEnFlitError(fuera);
    return 'flit';
  }
  if (pedido === 'organismo') {
    const fuera = docs.filter((d) => d.estado !== EstadoDocumentoLogistica.CLASIFICADO).map((d) => d.id);
    if (fuera.length) throw new LtEstadoNoAdmisibleError(fuera);
    return 'organismo';
  }
  const fuera = docs.filter((d) => !admiteDestinoCliente(d.estado)).map((d) => d.id);
  if (fuera.length) throw new LtEstadoNoAdmisibleError(fuera);
  const origenes = new Set(docs.map((d) => origenDe(d.estado)));
  if (origenes.size !== 1) throw new TrasladoOrigenMixtoError();
  return [...origenes][0]!;
}

async function lineasVivas(tx: DbOrTx, ids: string[], destino: DestinoTraslado): Promise<string[]> {
  const vivos = await tx.select({ documentoId: flitoLogisticaTrasladoLts.documentoId })
    .from(flitoLogisticaTrasladoLts)
    .where(and(
      inArray(flitoLogisticaTrasladoLts.documentoId, ids),
      eq(flitoLogisticaTrasladoLts.destino, destino),
      inArray(flitoLogisticaTrasladoLts.estado, [...ESTADOS_VIVOS]),
    ));
  return vivos.map((v) => v.documentoId);
}

export async function registrarTraslado(input: RegistrarTrasladoInput, ctx: LogisticaCtx): Promise<TrasladoDetalle> {
  // El CHECK de ruta haría 500. El servicio lo rechaza antes de cualquier INSERT.
  if (input.destino === 'flit' && input.origen === 'flit') throw new DatosInvalidosTrasladoError();
  const ids = [...new Set(input.lts.map((l) => l.documentoId))].sort();
  const destino = input.destino;
  const ahora = new Date();
  const porEntrada = new Map(input.lts.map((l) => [l.documentoId, l]));

  try {
    const res = await db.transaction(async (tx) => {
      const docs = await tx.select({
        id: flitoLogisticaDocumentos.id,
        estado: flitoLogisticaDocumentos.estado,
        companiaId: flitoLogisticaDocumentos.companiaId,
        actaOrganismoPendiente: flitoLogisticaDocumentos.actaOrganismoPendiente,
      }).from(flitoLogisticaDocumentos)
        .where(inArray(flitoLogisticaDocumentos.id, ids))
        .orderBy(flitoLogisticaDocumentos.id)
        .for('update');

      const hallados = new Set(docs.map((d) => d.id));
      const faltan = ids.filter((i) => !hallados.has(i));
      if (faltan.length) throw new LtNoEncontradaTrasladoError(faltan);

      await exigirTramiteResuelto(tx, ids);

      const ajenasCompania = docs.filter((d) => d.companiaId !== input.companiaId).map((d) => d.id);
      if (ajenasCompania.length) throw new TrasladoCompaniaMixtaError(ajenasCompania);

      // FLIT: el vivo corre ANTES que el estado, para que la LT ya llegada responda
      // LT_YA_EN_TRASLADO y no LT_ESTADO_NO_ADMISIBLE. Cliente: el orden de hoy (estado, luego vivo).
      let origen: 'organismo' | 'flit';
      if (destino === 'flit') {
        const vivos = await lineasVivas(tx, ids, destino);
        if (vivos.length) throw new LtYaEnTrasladoError(vivos);
        const fuera = docs.filter((d) => d.estado !== EstadoDocumentoLogistica.CLASIFICADO).map((d) => d.id);
        if (fuera.length) throw new LtEstadoNoAdmisibleError(fuera);
        origen = 'organismo';
      } else {
        origen = origenClienteDe(docs, input.origen);
      }

      if (!ctx.operaAjenas) {
        const propias = await tx.select({ id: flitoLogisticaEventos.documentoId }).from(flitoLogisticaEventos)
          .where(and(
            inArray(flitoLogisticaEventos.documentoId, ids),
            eq(flitoLogisticaEventos.actorId, ctx.userId),
            sql`${flitoLogisticaEventos.estadoAnterior} IS NULL`,
          ));
        const mias = new Set(propias.map((p) => p.id));
        if (ids.some((i) => !mias.has(i))) throw new LtAjenaTrasladoError();
      }

      const [compania] = await tx.select({
        id: clients.id,
        nombre: clients.name,
        autogestionable: clients.logisticaAutogestionable,
        direccion: clients.address,
        contactoDoc: clients.document,
      }).from(clients).where(eq(clients.id, input.companiaId)).limit(1);
      if (!compania) throw new CompaniaNoEncontradaTrasladoError();
      if (compania.autogestionable) throw new LogisticaAutogestionadaTrasladoError();

      if (destino === 'cliente') {
        const vivos = await lineasVivas(tx, ids, destino);
        if (vivos.length) throw new LtYaEnTrasladoError(vivos);
      }

      const motivos = new Map<string, { id: string; nota: string | null }>();
      if (destino === 'flit') {
        const activos = new Set((await listarMotivosActivos()).map((m) => m.id));
        for (const id of ids) {
          const entrada = porEntrada.get(id);
          const motivoId = entrada?.motivoLlegadaId ?? input.motivoLlegadaId;
          if (!motivoId || !activos.has(motivoId)) throw new MotivoLlegadaRequeridoError();
          const nota = entrada?.nota?.trim();
          motivos.set(id, { id: motivoId, nota: nota ? nota : null });
        }
      }

      const precio = await precioTrasladoDe(input.companiaId, destino, ahora);
      if (precio == null) throw new PrecioTrasladoNoConfiguradoError(destino);

      const proveedorId = await proveedorDeCompania(tx, input.companiaId);
      if (proveedorId == null) throw new ProveedorLogisticaRequeridoError();

      const mensajeroId = input.mensajeroId ?? ctx.userId;
      const punto = destino === 'flit' ? 'flit' : 'cliente';
      const [traslado] = await tx.insert(flitoLogisticaTraslados).values({
        companiaId: input.companiaId, destino, origen, estado: 'registrado',
        mensajeroId, registradoPorId: ctx.userId, registradoEn: ahora,
      }).returning({ id: flitoLogisticaTraslados.id });

      const concepto = conceptoPrecioDe(destino);
      const lineas = await tx.insert(flitoLogisticaTrasladoLts).values(docs.map((d) => {
        const motivo = motivos.get(d.id);
        return {
          trasladoId: traslado.id, destino, documentoId: d.id, estado: 'registrado',
          conceptoPrecio: concepto, precio: aNumeric(precio.valor), tarifaVigenciaId: precio.vigenciaId,
          ...(motivo ? {
            motivoLlegadaId: motivo.id, motivoPorId: ctx.userId, motivoEn: ahora, motivoNota: motivo.nota,
          } : {}),
        };
      })).returning({ id: flitoLogisticaTrasladoLts.id, documentoId: flitoLogisticaTrasladoLts.documentoId });

      const [acta] = await tx.insert(flitoLogisticaActas).values({
        companiaId: input.companiaId, punto, estado: EstadoActaLogistica.GENERADA,
        permiteParcial: true, proveedorLogisticaId: proveedorId, trasladoId: traslado.id,
        mensajeroId, direccionEntrega: compania.direccion, contactoNombre: compania.nombre,
        contactoDocumento: compania.contactoDoc,
      }).returning({ id: flitoLogisticaActas.id });

      await tx.insert(flitoLogisticaActaLineas).values(lineas.map((l) => ({
        actaId: acta.id, documentoId: l.documentoId, punto,
        trasladoLtId: l.id, companiaId: input.companiaId,
      })));

      const tipoActa = destino === 'flit' ? 'acta_flit' : 'acta_cliente';
      const payloadRegistro = { trasladoId: traslado.id, actaId: acta.id, destino };
      // El acta de cliente conserva el payload de #14114. FLIT usa el mismo literal en los dos eventos.
      const payloadActa = destino === 'flit' ? payloadRegistro : { actaId: acta.id, trasladoId: traslado.id, destino };
      for (const d of docs) {
        await transicionar(tx, d, EstadoDocumentoLogistica.EN_ACTA, ctx, {
          tipo: 'destino_registrado', trasladoId: traslado.id, actaId: acta.id, destino, payload: payloadRegistro,
        });
        // Evento sin cambio de estado (calco de acta_organismo); mismo tx que destino_registrado.
        await insertarEvento(tx, { id: d.id, estado: EstadoDocumentoLogistica.EN_ACTA }, EstadoDocumentoLogistica.EN_ACTA, ctx, {
          tipo: tipoActa, trasladoId: traslado.id, actaId: acta.id, destino, payload: payloadActa,
        });
      }

      log.info({ trasladoId: traslado.id, actaId: acta.id, documentos: docs.length, destino }, 'traslado registrado');
      return {
        id: traslado.id, companiaId: input.companiaId, destino, origen, estado: 'registrado',
        mensajeroId, actaId: acta.id, documentos: docs.length,
        lts: docs.map((d) => {
          const motivo = motivos.get(d.id);
          return {
            documentoId: d.id, precio: precio.valor, tarifaVigenciaId: precio.vigenciaId,
            actaOrganismoPendiente: d.actaOrganismoPendiente,
            motivoLlegadaId: motivo?.id ?? null,
            motivoPorId: motivo ? ctx.userId : null,
            motivoEn: motivo ? ahora : null,
          };
        }),
      };
    });
    try { await generarActaPdf(res.actaId); }
    catch (e) { log.warn({ actaId: res.actaId, err: (e as Error).message }, 'no se pudo generar el PDF base del acta'); }
    return res;
  } catch (e) {
    if (esUnicaViolada(e)) throw new LtYaEnTrasladoError();
    throw e;
  }
}

/**
 * Adaptador de `POST /cerrar-lote` (ADR-0030 §3): equivale a registrar un viaje a cliente con
 * todas las LT `clasificado` de la compañía. Se deprecia: la web nueva usa `POST /traslados`.
 */
export async function idsClasificadosDe(companiaId: number): Promise<string[]> {
  const filas = await db.select({ id: flitoLogisticaDocumentos.id }).from(flitoLogisticaDocumentos)
    .where(and(
      eq(flitoLogisticaDocumentos.companiaId, companiaId),
      eq(flitoLogisticaDocumentos.estado, EstadoDocumentoLogistica.CLASIFICADO),
    ));
  return filas.map((f) => f.id);
}

export async function exigirCompaniaRegistrable(companiaId: number): Promise<void> {
  const [c] = await db.select({
    id: clients.id, autogestionable: clients.logisticaAutogestionable,
  }).from(clients).where(eq(clients.id, companiaId)).limit(1);
  if (!c) throw new CompaniaNoEncontradaTrasladoError();
  if (c.autogestionable) throw new LogisticaAutogestionadaTrasladoError();
}
