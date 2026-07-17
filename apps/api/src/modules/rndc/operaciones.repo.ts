import { eq, and, desc } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { rndcOperaciones } from '../../db/schema.js';

// ============================================================================
// Repo WORM rndc_operaciones — solo expone insert() y query().
// La capa BD también lo enforza con triggers + permisos GRANT.
// Defensa en 3 capas: app + triggers + permisos.
// ============================================================================

export interface OperacionInput {
  tipoOp: 'ingresarRemesa' | 'ingresarManifiesto' | 'anularManifiesto'
        | 'anularRemesa' | 'consultarEstadoIngreso' | 'cumplirManifiesto';
  entidadTipo: 'remesa' | 'manifiesto';
  entidadId: number;
  intento?: number;
  modo: 'mock' | 'real';
  requestXml?: string | null;
  responseXml?: string | null;
  resultado: 'ok' | 'error_negocio' | 'error_tecnico' | 'timeout';
  codigoResultado?: string | null;
  consecutivoRndc?: string | null;
  mensaje?: string | null;
  duracionMs?: number;
  ipOrigen?: string | null;
  createdBy?: number | null;
}

export async function logOperacion(input: OperacionInput): Promise<void> {
  await db.insert(rndcOperaciones).values({
    tipoOp: input.tipoOp,
    entidadTipo: input.entidadTipo,
    entidadId: input.entidadId,
    intento: input.intento ?? 1,
    modo: input.modo,
    requestXml: input.requestXml ?? null,
    responseXml: input.responseXml ?? null,
    resultado: input.resultado,
    codigoResultado: input.codigoResultado ?? null,
    consecutivoRndc: input.consecutivoRndc ?? null,
    mensaje: input.mensaje ?? null,
    duracionMs: input.duracionMs,
    ipOrigen: input.ipOrigen ?? null,
    createdBy: input.createdBy ?? null,
  });
}

export interface ListOperacionesOptions {
  entidadTipo: 'remesa' | 'manifiesto';
  entidadId: number;
  incluirXml?: boolean;
  limit?: number;
}

export async function listOperaciones(opts: ListOperacionesOptions) {
  const limit = Math.min(opts.limit ?? 50, 200);
  const cols = {
    id: rndcOperaciones.id,
    tipoOp: rndcOperaciones.tipoOp,
    intento: rndcOperaciones.intento,
    modo: rndcOperaciones.modo,
    resultado: rndcOperaciones.resultado,
    codigoResultado: rndcOperaciones.codigoResultado,
    consecutivoRndc: rndcOperaciones.consecutivoRndc,
    mensaje: rndcOperaciones.mensaje,
    duracionMs: rndcOperaciones.duracionMs,
    createdAt: rndcOperaciones.createdAt,
    createdBy: rndcOperaciones.createdBy,
    ...(opts.incluirXml ? {
      requestXml: rndcOperaciones.requestXml,
      responseXml: rndcOperaciones.responseXml,
    } : {}),
  };

  return await db.select(cols)
    .from(rndcOperaciones)
    .where(and(
      eq(rndcOperaciones.entidadTipo, opts.entidadTipo),
      eq(rndcOperaciones.entidadId, opts.entidadId),
    ))
    .orderBy(desc(rndcOperaciones.createdAt))
    .limit(limit);
}
