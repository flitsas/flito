// HU #14132 (Feature #14013, ADR-0032) — procesa UNA fila reclamada de un lote de Renovación.
//
// Orden (cada paso corta el siguiente):
//   1. Idempotencia (AC9): si el id reservado ya tiene SOAT o incompleta, la fila solo se marca; no se crea otra.
//   2. Validación de campos (AC8): las reglas del alta (A1) otra vez, SIN llamar al RUNT.
//   3. Guarda barata: otra incompleta abierta de la placa → «ya tiene un SOAT en gestión» (AC6).
//   4. RUNT (placa + documento) por el servicio, no por la ruta de preconsulta (límite 15/15 min por usuario).
//   5. `decidir` (pura): crear · rechazar · reintentar (1.ª caída) · aparcar (2.ª) · límite (429).
//
// Los colaboradores se inyectan (`DepsFila`) para probar la orquestación sin base ni RUNT; las implementaciones
// reales están abajo. Nada de PII en logs: solo ids de lote/fila y el desenlace.

import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoSoat, flitoSoatIncompletas, users } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import {
  canalDeLaCompania, normalizarId, SolicitudSoatError, verificarIncompletaAbierta, type CanalCompania,
} from './flito-soat-cliente.service.js';
import { CodigoErrorSolicitudSoat } from '@operaciones/shared-types';
import { consultarYClasificar, type DesenlaceRunt } from './flito-soat-cliente-runt.js';
import type { EntradaConsultaRunt } from './flito-soat-cliente-consulta.js';
import { contextoSoat, type SoatCtx } from './flito-soat.service.js';
import { validarFila } from './flito-soat-masivo-parse.js';
import { decidir, MAX_INTENTOS_FILA, REINTENTO_CAIDA_MS, type MotivoRechazoWorker } from './flito-soat-masivo-motivos.js';
import type { FilaReclamada } from './flito-soat-masivo-reclamo.js';
import { aparcarFila, crearRenovacionDeFila, FilaYaNoVigenteError, marcarFila } from './flito-soat-masivo-crear.js';

const log = loggerFor('flito-soat-masivo-worker');

export type ResultadoFila = 'aceptada' | 'por_validar' | 'rechazada' | 'reintento' | 'limite';

export interface DepsFila {
  yaCreado(reservado: string): Promise<{ soatId?: string; incompletaId?: string } | null>;
  contexto(f: FilaReclamada): Promise<{ ctx: SoatCtx; canal: CanalCompania }>;
  incompletaAbierta(placa: string, companiaId: number): Promise<void>;
  consultar(c: EntradaConsultaRunt): Promise<DesenlaceRunt>;
  crear(p: Parameters<typeof crearRenovacionDeFila>[0]): Promise<string>;
  aparcar(p: Parameters<typeof aparcarFila>[0]): Promise<'aparcada' | 'ocupada'>;
  marcar(f: FilaReclamada, cambios: Parameters<typeof marcarFila>[2], terminal: boolean): Promise<boolean>;
}

/** Contexto de la API del usuario que subió el lote: sus permisos de HOY, su compañía (misma regla que el alta). */
async function contextoReal(f: FilaReclamada): Promise<{ ctx: SoatCtx; canal: CanalCompania }> {
  const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, f.creadoPorId as number)).limit(1);
  if (!u) throw new SolicitudSoatError(403, CodigoErrorSolicitudSoat.SIN_COMPANIA, 'Usuario no disponible');
  const ctx = await contextoSoat({ sub: f.creadoPorId as number, username: f.creadoPorNombre, role: u.role });
  return { ctx, canal: await canalDeLaCompania(ctx, f.companiaId) };
}

export const depsReales: DepsFila = {
  async yaCreado(reservado) {
    const [s] = await db.select({ id: flitoSoat.id }).from(flitoSoat).where(eq(flitoSoat.id, reservado)).limit(1);
    if (s) return { soatId: s.id };
    const [i] = await db.select({ id: flitoSoatIncompletas.id }).from(flitoSoatIncompletas)
      .where(eq(flitoSoatIncompletas.soatIdReservado, reservado)).limit(1);
    return i ? { incompletaId: i.id } : null;
  },
  contexto: contextoReal,
  incompletaAbierta: (placa, companiaId) => verificarIncompletaAbierta({ placa }, companiaId),
  consultar: (c) => consultarYClasificar(c, 'renovacion'),
  crear: crearRenovacionDeFila,
  aparcar: aparcarFila,
  marcar: (f, cambios, terminal) => marcarFila(f.id, f.loteId, cambios, terminal),
};

const CODIGOS_YA_EXISTE: string[] = [
  CodigoErrorSolicitudSoat.VIN_YA_TIENE_SOAT, CodigoErrorSolicitudSoat.SOLICITUD_INCOMPLETA_EXISTENTE,
];

/** Error DETERMINISTA → motivo de rechazo; `null` = transitorio (se reintenta hasta `MAX_INTENTOS_FILA`). */
export function motivoDeError(e: unknown): MotivoRechazoWorker | null {
  if ((e as { code?: string })?.code === '23505') return 'solicitud_existente';
  if (e instanceof SolicitudSoatError) return CODIGOS_YA_EXISTE.includes(e.codigo) ? 'solicitud_existente' : 'no_procesada';
  return null;
}

export async function procesarFila(f: FilaReclamada, deps: DepsFila = depsReales): Promise<ResultadoFila> {
  const rechazar = async (motivo: MotivoRechazoWorker, vigenteHasta?: string | null): Promise<ResultadoFila> => {
    await deps.marcar(f, { estado: 'rechazada', motivoRechazo: motivo, vigenteHasta: vigenteHasta ?? null }, true);
    log.info({ loteId: f.loteId, filaId: f.id, resultado: 'rechazada', motivo }, 'carga masiva SOAT: fila rechazada');
    return 'rechazada';
  };
  try {
    // 1. AC9 — ya creada antes de que el proceso muriera: solo se marca.
    const previo = await deps.yaCreado(f.soatIdReservado);
    if (previo?.soatId) {
      await deps.marcar(f, { estado: 'aceptada', soatId: previo.soatId }, true);
      return 'aceptada';
    }
    if (previo?.incompletaId) {
      await deps.marcar(f, { estado: 'por_validar', incompletaId: previo.incompletaId }, true);
      return 'por_validar';
    }
    // 2. AC8 — campos, sin RUNT.
    const v = validarFila({
      placa: f.placa ?? '', documento: f.documento ?? '', nombre: f.nombre ?? '', correo: f.correo ?? '', celular: f.celular ?? '',
    });
    if (v.motivo) return await rechazar(v.motivo as MotivoRechazoWorker);
    if (f.creadoPorId === null) return await rechazar('no_procesada');

    const { ctx, canal } = await deps.contexto(f);
    const placa = normalizarId(f.placa ?? '');
    // 3. AC6 — una incompleta abierta de la placa.
    await deps.incompletaAbierta(placa, canal.companiaId);
    // 4. RUNT.
    const desenlace = await deps.consultar({ modalidad: 'placa', placa, documento: f.documento ?? '' });
    // 5. Decisión.
    const accion = decidir(desenlace, f.intentos);
    switch (accion.tipo) {
      case 'rechazar':
        return await rechazar(accion.motivo, accion.vigenteHasta);
      case 'limite':
        // 429: sin gastar intento. El worker pausa el proceso; la fila espera el mismo backoff mínimo.
        await deps.marcar(f, { estado: 'pendiente', proximoIntentoEn: new Date(Date.now() + 5_000) }, false);
        return 'limite';
      case 'reintentar':
        await deps.marcar(f, {
          estado: 'pendiente', intentos: accion.intentos, ultimaCausa: accion.causa,
          proximoIntentoEn: new Date(Date.now() + accion.enMs),
        }, false);
        log.info({ loteId: f.loteId, filaId: f.id, resultado: 'reintento', causa: accion.causa }, 'carga masiva SOAT: RUNT caído, se reintenta');
        return 'reintento';
      case 'aparcar': {
        const r = await deps.aparcar({ fila: f, canal, ctx, intentos: accion.intentos, causa: accion.causa });
        if (r === 'ocupada') return await rechazar('solicitud_existente');
        log.info({ loteId: f.loteId, filaId: f.id, resultado: 'por_validar' }, 'carga masiva SOAT: fila en Por validar (RUNT sin respuesta)');
        return 'por_validar';
      }
      case 'crear': {
        await deps.crear({ fila: f, canal, ctx, desenlace: desenlace as Extract<DesenlaceRunt, { clase: 'ok' | 'renovacion_anticipada' }> });
        log.info({ loteId: f.loteId, filaId: f.id, resultado: 'aceptada' }, 'carga masiva SOAT: Renovación creada');
        return 'aceptada';
      }
    }
  } catch (e) {
    return await manejarError(f, e, deps, rechazar);
  }
}

async function manejarError(
  f: FilaReclamada, e: unknown, deps: DepsFila,
  rechazar: (m: MotivoRechazoWorker) => Promise<ResultadoFila>,
): Promise<ResultadoFila> {
  // Solo el NOMBRE del error: el mensaje puede traer datos del RUNT o de la base.
  const nombre = e instanceof Error ? e.name : 'error';
  if (e instanceof FilaYaNoVigenteError) return 'rechazada'; // la cerró el vigilante; nada que marcar
  const motivo = motivoDeError(e);
  if (motivo) return rechazar(motivo);
  const intentos = f.intentos + 1;
  log.error({ loteId: f.loteId, filaId: f.id, err: nombre, intentos }, 'carga masiva SOAT: fallo transitorio procesando la fila');
  if (intentos >= MAX_INTENTOS_FILA) return rechazar('no_procesada');
  await deps.marcar(f, {
    estado: 'pendiente', intentos, ultimaCausa: 'otro', proximoIntentoEn: new Date(Date.now() + REINTENTO_CAIDA_MS),
  }, false);
  return 'reintento';
}
