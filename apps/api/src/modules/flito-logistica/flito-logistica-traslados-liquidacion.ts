// FLITO — líneas de traslado que cobran en la liquidación (HU #14118, Feature #14092).
//
// Hermana de `viajesDe`: la liquidación la llama con `db` en la previsualización y con el `tx`
// de `liquidar` DESPUÉS de `bloquearTramite`. No toma otro `FOR UPDATE`: el del trámite ya
// serializa contra la entrega. No llama `precioTrasladoDe` ni `tarifaDe`: el precio es el
// congelado en la línea.
//
// Cobra solo si las cuatro se cumplen (y la LT es de ESTE trámite):
//   - la LÍNEA está `entregado` (una entrega parcial no mete a las otras);
//   - `concepto_precio` es `logistica_cliente` o `logistica_flit`;
//   - `precio` no es null (0 sí cuenta y suma 0);
//   - el traslado tiene `legado = false`.
// `concepto_precio = 'legado'`, `legado = true`, `registrado`, `en_ruta`, `devuelto` y `anulado`
// no suman y no se recalculan. Sin `tramite_id` en el documento, no entra. Una línea de otro
// trámite del mismo traslado tampoco. Dos líneas entregadas del mismo documento (flit y cliente)
// entran las dos.
//
// NQ5: un viaje entregado después de liquidar no abre otra fila ni es cargo de la compañía.
// Entra al volver a liquidar ESE trámite (reverso no facturado): el sello nuevo recalcula
// tarifa + adicionales vivos + todas las líneas que cobran ahora.

import { asc, eq } from 'drizzle-orm';
import type { LineaTrasladoLogistica } from '@operaciones/shared-types';
import {
  flitoLogisticaDocumentos, flitoLogisticaTrasladoLts, flitoLogisticaTraslados,
} from '../../db/schema.js';
import type { Ejecutor } from '../finanzas-servicios-adicionales/finanzas-servicios-adicionales.service.js';

const L = flitoLogisticaTrasladoLts;
const D = flitoLogisticaDocumentos;
const T = flitoLogisticaTraslados;

/** Fila cruda del join. `precio` llega como texto (`numeric`) desde Postgres. */
interface FilaTraslado {
  id: string;
  documentoId: string;
  trasladoId: string;
  destino: string;
  estado: string;
  conceptoPrecio: string | null;
  precio: string | number | null;
  tarifaVigenciaId: string | null;
  createdAt: Date | string;
  tramiteId: string | null;
  legado: boolean;
}

function marca(v: Date | string): number {
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** null si no hay precio congelado. 0 es un precio y se conserva. */
function precioNumero(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function cobra(f: FilaTraslado, tramiteId: string): boolean {
  return f.tramiteId === tramiteId
    && f.estado === 'entregado'
    && (f.destino === 'flit' || f.destino === 'cliente')
    && (f.conceptoPrecio === 'logistica_cliente' || f.conceptoPrecio === 'logistica_flit')
    && precioNumero(f.precio) !== null
    && f.legado === false;
}

function aLinea(f: FilaTraslado): LineaTrasladoLogistica {
  return {
    id: f.id,
    documentoId: f.documentoId,
    trasladoId: f.trasladoId,
    destino: f.destino as 'flit' | 'cliente',
    conceptoPrecio: f.conceptoPrecio as 'logistica_cliente' | 'logistica_flit',
    precio: precioNumero(f.precio) as number,
    tarifaVigenciaId: f.tarifaVigenciaId ?? null,
  };
}

/**
 * Líneas que cobran de este trámite, `created_at ASC, id ASC`. El SQL ata la línea al trámite
 * y trae el legado del traslado; el predicado de arriba descarta lo que no cobra (también cuando
 * el doble de prueba devuelve la mezcla entera, porque no aplica el WHERE).
 */
export async function trasladosDe(ejecutor: Ejecutor, tramiteId: string): Promise<LineaTrasladoLogistica[]> {
  const filas = await ejecutor.select({
    id: L.id,
    documentoId: L.documentoId,
    trasladoId: L.trasladoId,
    destino: L.destino,
    estado: L.estado,
    conceptoPrecio: L.conceptoPrecio,
    precio: L.precio,
    tarifaVigenciaId: L.tarifaVigenciaId,
    createdAt: L.createdAt,
    tramiteId: D.tramiteId,
    legado: T.legado,
  }).from(L)
    .innerJoin(D, eq(D.id, L.documentoId))
    .innerJoin(T, eq(T.id, L.trasladoId))
    .where(eq(D.tramiteId, tramiteId))
    .orderBy(asc(L.createdAt), asc(L.id));
  return (filas as FilaTraslado[])
    .filter((f) => cobra(f, tramiteId))
    .sort((a, b) => marca(a.createdAt) - marca(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(aLinea);
}
