// HU #14135 (Feature #14014, ADR-0032) — procesa UNA fila reclamada de un lote INICIAL (solo VIN).
//
// RN-INI1  La fila Inicial NUNCA crea el SOAT: deja una PENDIENTE en `flito_soat_incompletas` (ADR-0019, CF-02;
//          no `flito_soat.estado='pendiente'`) para que el usuario complete lo que el Excel no trae.
//          · VIN sin SOAT en el RUNT  → inicial, «Falta factura de venta» (AC1). No aparece al gestor ni vence.
//          · SOAT vigente que vence dentro de la ventana de 30 días → Renovación, «Faltan datos del propietario»
//            (AC2), con la PLACA que devuelve el RUNT; el documento lo escribe el usuario al completar.
//          · RUNT caído por VIN (decisión del humano) → nace igual «Falta factura de venta»; la consulta se
//            repite al confirmar con la factura. No hay reintento de la fila.
// RN-INI2  Rechazos (AC5–AC8): solicitud abierta/pendiente del VIN, VIN que el RUNT no reconoce, SOAT que vence
//          en más de 30 días (con la fecha) y VIN inválido (sin consultar el RUNT).
// RN-INI3  La pendiente y la fila quedan en UNA transacción: o están las dos o ninguna.
//
// Los colaboradores se inyectan (`DepsFila`). Nada de PII en logs: ni VIN ni placa.

import { db } from '../../db/client.js';
import { flitoSoatIncompletas } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import { EstadoSolicitudIncompletaSoat } from '@operaciones/shared-types';
import { normalizarId, verificarRn01, verificarTenenciaVehiculo, type CanalCompania } from './flito-soat-cliente.service.js';
import type { DesenlaceRunt } from './flito-soat-cliente-runt.js';
import type { SoatCtx } from './flito-soat.service.js';
import type { MotivoRechazoWorker } from './flito-soat-masivo-motivos.js';
import type { FilaReclamada } from './flito-soat-masivo-reclamo.js';
import type { DepsFila, ResultadoFila } from './flito-soat-masivo-procesar-fila.js';
import { FilaYaNoVigenteError, marcarFila } from './flito-soat-masivo-crear.js';
import { esVinValido } from './flito-soat-masivo-parse-inicial.js';

const log = loggerFor('flito-soat-masivo-worker');

export type MotivoPendienteInicial = 'falta_factura_venta' | 'faltan_datos_propietario';

export type DecisionInicial =
  | { tipo: 'rechazar'; motivo: MotivoRechazoWorker; vigenteHasta?: string | null }
  | { tipo: 'pendiente'; motivoPendiente: MotivoPendienteInicial; tipoSoat: 'inicial' | 'renovacion'; placa: string | null; vinRunt: string | null }
  | { tipo: 'limite' };

const ISO_DIA = /^\d{4}-\d{2}-\d{2}$/;

/** Función pura: desenlace del RUNT (consulta por VIN) → qué se hace con la fila. */
export function decidirInicial(d: DesenlaceRunt): DecisionInicial {
  switch (d.clase) {
    case 'revise':
      return { tipo: 'rechazar', motivo: d.codigo };
    case 'vigente':
      return { tipo: 'rechazar', motivo: 'soat_vigente', vigenteHasta: d.fechaVencimiento && ISO_DIA.test(d.fechaVencimiento) ? d.fechaVencimiento : null };
    case 'renovacion_anticipada': {
      const placa = d.datos.placa ? normalizarId(d.datos.placa) : '';
      return { tipo: 'pendiente', motivoPendiente: 'faltan_datos_propietario', tipoSoat: 'renovacion', placa: placa || null, vinRunt: d.vinEfectivo };
    }
    case 'ok':
      return { tipo: 'pendiente', motivoPendiente: 'falta_factura_venta', tipoSoat: 'inicial', placa: null, vinRunt: d.vinEfectivo };
    case 'sin_soat_anterior': // no se produce con la consulta Inicial; por completitud es «sin SOAT»
      return { tipo: 'pendiente', motivoPendiente: 'falta_factura_venta', tipoSoat: 'inicial', placa: null, vinRunt: null };
    case 'caido':
      if (d.httpStatus === 429) return { tipo: 'limite' };
      return { tipo: 'pendiente', motivoPendiente: 'falta_factura_venta', tipoSoat: 'inicial', placa: null, vinRunt: null };
  }
}

const esUnica = (e: unknown): boolean => {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return err?.code === '23505' || err?.cause?.code === '23505';
};

/** Deja la pendiente en `flito_soat_incompletas` y la fila en «Por validar», en una transacción. */
export async function aparcarFilaInicial(p: {
  fila: FilaReclamada; canal: CanalCompania; ctx: SoatCtx; vin: string; decision: Extract<DecisionInicial, { tipo: 'pendiente' }>;
}): Promise<'aparcada' | 'ocupada'> {
  const { fila, canal, ctx, vin, decision } = p;
  const ahora = new Date();
  try {
    await db.transaction(async (tx) => {
      const [i] = await tx.insert(flitoSoatIncompletas).values({
        soatIdReservado: fila.soatIdReservado,
        companiaId: canal.companiaId,
        vin,
        placa: decision.placa,
        tipoSoat: decision.tipoSoat,
        // Con la placa del RUNT (Renovación) la completación consulta por placa + documento; si no, por VIN.
        modalidadConsulta: decision.placa ? 'placa' : 'vin',
        motivoPendiente: decision.motivoPendiente,
        estado: EstadoSolicitudIncompletaSoat.INCOMPLETA,
        solicitadoPorId: ctx.userId,
        solicitadoPorNombre: ctx.username,
        solicitadoEn: ahora,
        intentos: 1,
        ultimoIntentoEn: ahora,
        ultimoIntentoPorId: ctx.userId,
      }).returning({ id: flitoSoatIncompletas.id });
      const ok = await marcarFila(fila.id, fila.loteId, { estado: 'por_validar', incompletaId: i!.id }, true, tx);
      if (!ok) throw new FilaYaNoVigenteError();
    });
    return 'aparcada';
  } catch (e) {
    if (esUnica(e)) return 'ocupada'; // otra petición abrió una pendiente del mismo VIN/placa entre la guarda y el INSERT
    throw e;
  }
}

/** Guarda barata previa al RUNT: un SOAT abierto o pendiente del VIN (AC5) y la tenencia del vehículo. */
export async function guardaVinReal(vin: string, companiaId: number, permiteTerminal: boolean): Promise<void> {
  await verificarRn01(vin, companiaId, { permiteTerminal });
  await verificarTenenciaVehiculo(vin, companiaId);
}

export async function procesarInicial(
  f: FilaReclamada, deps: DepsFila,
  rechazar: (m: MotivoRechazoWorker, vigenteHasta?: string | null) => Promise<ResultadoFila>,
): Promise<ResultadoFila> {
  const vin = normalizarId(f.vin ?? '');
  // AC8: sin VIN válido no se consulta el RUNT.
  if (!esVinValido(vin)) return rechazar('vin_invalido');
  if (f.creadoPorId === null) return rechazar('no_procesada');

  const { ctx, canal } = await deps.contexto(f);
  // AC5: solicitud abierta / pendiente del VIN (o vehículo ajeno) → rechazo, sin RUNT. Un SOAT propio ya
  // terminado no bloquea todavía: puede ser la Renovación de la ventana (se vuelve a mirar abajo).
  await deps.guardaVin(vin, canal.companiaId, true);

  const desenlace = await deps.consultar({ modalidad: 'vin', vin });
  const decision = decidirInicial(desenlace);
  switch (decision.tipo) {
    case 'rechazar':
      return rechazar(decision.motivo, decision.vigenteHasta);
    case 'limite':
      // 429: sin gastar intento; el worker pausa el proceso con backoff.
      await deps.marcar(f, { estado: 'pendiente', proximoIntentoEn: new Date(Date.now() + 5_000) }, false);
      return 'limite';
    case 'pendiente': {
      // Inicial: un SOAT propio terminal sí bloquea (RN-01 estricta), igual que el alta individual.
      if (decision.tipoSoat === 'inicial') await deps.guardaVin(vin, canal.companiaId, false);
      const r = await deps.aparcarInicial({ fila: f, canal, ctx, vin: decision.vinRunt ?? vin, decision });
      if (r === 'ocupada') return rechazar('solicitud_existente');
      log.info({ loteId: f.loteId, filaId: f.id, resultado: 'por_validar', motivo: decision.motivoPendiente }, 'carga masiva SOAT Inicial: fila en Por validar');
      return 'por_validar';
    }
  }
}
