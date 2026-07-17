import { eq, and, isNull, sql, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  manifiestos, remesas, manifiestoRemesas, vehicles, users, rndcMunicipios,
  rndcIdempotencyKeys, notificationOutbox,
} from '../../db/schema.js';
import { logOperacion } from './operaciones.repo.js';
import { getRndcClient } from './client/factory.js';
import { getActiveCredenciales } from './credenciales.service.js';
import { isTransientError, isBusinessError, isDuplicate, RndcResponse } from './client/types.js';
import { hashRequest } from '../../shared/utils/crypto.js';
import { env } from '../../config/env.js';

// ============================================================================
// Servicio de envío RNDC.
// - Idempotencia persistida en rndc_idempotency_keys (sobrevive restart).
// - Backoff exponencial con cap a 4h, hasta 10 intentos / ~24h ventana total.
// - Transiciones: pendiente_envio → enviando → aceptado | error_envio | fallido_*
// - Anti-doble-envío: SELECT FOR UPDATE + flip a 'enviando' antes del SOAP.
// - Cancelación pre-envío: si remesa ya está anulada, marcar cancelado_pre_envio.
// ============================================================================

const SOAP_TIMEOUT_MS = 90_000;     // < TTL del lock (240_000) con buen margen.
const MAX_INTENTOS = 10;
const BASE_BACKOFF_MS = 60_000;     // 1 min
const CAP_BACKOFF_MS = 4 * 3600_000; // 4 h

// Backoff: 1m, 2m, 4m, 8m, 16m, 32m, 64m, 128m=2.1h, 256m=4h(cap), 4h
function calcBackoff(intentoCompletado: number): Date {
  const delay = Math.min(BASE_BACKOFF_MS * 2 ** (intentoCompletado - 1), CAP_BACKOFF_MS);
  const jitter = Math.floor(Math.random() * 30_000);
  return new Date(Date.now() + delay + jitter);
}

async function getEmpresaNit(): Promise<string> {
  // FUTURO multi-tenant: leer de tabla `empresa`. Por ahora env (OPS-08: env.ts Zod).
  return env.EMPRESA_NIT;
}

async function getAmbiente(): Promise<'sandbox' | 'produccion'> {
  return env.RNDC_AMBIENTE;
}

interface EnvioResult {
  ok: boolean;
  estadoFinal: 'aceptado' | 'error_envio' | 'fallido_temporal' | 'fallido_definitivo' | 'cancelado_pre_envio';
  consecutivoRndc?: string;
  mensaje: string;
  codigo?: string;
}

// ----------------------------------------------------------------------------
// Encolar (encolar = marcar pendiente_envio, lo procesa el cron retry).
// ----------------------------------------------------------------------------
export async function encolarRemesa(remesaId: number): Promise<void> {
  await db.update(remesas)
    .set({
      estadoEnvio: 'pendiente_envio',
      proximoIntentoAt: new Date(),
      ultimoError: null,
    })
    .where(and(
      eq(remesas.id, remesaId),
      isNull(remesas.deletedAt),
    ));
}

export async function encolarManifiesto(manifiestoId: number): Promise<void> {
  await db.update(manifiestos)
    .set({
      estadoEnvio: 'pendiente_envio',
      proximoIntentoAt: new Date(),
      ultimoError: null,
    })
    .where(and(
      eq(manifiestos.id, manifiestoId),
      isNull(manifiestos.deletedAt),
    ));
}

// ----------------------------------------------------------------------------
// Procesar manifiesto (llamado por cron retry y por botón "Reintentar" UI).
// ----------------------------------------------------------------------------
export async function procesarManifiesto(manifiestoId: number, ipOrigen?: string): Promise<EnvioResult> {
  // 1. Lock pesimista del row + flip a 'enviando' atómico.
  const claimed = await db.transaction(async (tx) => {
    // Statement timeout 30s: protege la fila no quede atrapada en 'enviando' si BD se cuelga.
    // Si excede, postgres aborta la tx y libera el row lock; zombie rescue lo recupera al ciclo siguiente.
    await tx.execute(sql`SET LOCAL statement_timeout TO 30000`);

    const [row] = await tx.select({
      id: manifiestos.id,
      numero: manifiestos.numero,
      estadoEnvio: manifiestos.estadoEnvio,
      intentosEnvio: manifiestos.intentosEnvio,
      consecutivoRndc: manifiestos.consecutivoRndc,
      vehiculoPrincipalId: manifiestos.vehiculoPrincipalId,
      conductorId: manifiestos.conductorId,
      municipioOrigenDane: manifiestos.municipioOrigenDane,
      municipioDestinoDane: manifiestos.municipioDestinoDane,
      fechaExpedicion: manifiestos.fechaExpedicion,
      valorFleteTotal: manifiestos.valorFleteTotal,
      anuladoAt: manifiestos.anuladoAt,
      deletedAt: manifiestos.deletedAt,
    }).from(manifiestos)
      .where(eq(manifiestos.id, manifiestoId))
      .for('update');

    if (!row || row.deletedAt) return null;
    if (row.estadoEnvio === 'aceptado' || row.estadoEnvio === 'fallido_definitivo') return null;
    if (row.anuladoAt) {
      await tx.update(manifiestos).set({
        estadoEnvio: 'cancelado_pre_envio',
        ultimoIntentoAt: new Date(),
      }).where(eq(manifiestos.id, manifiestoId));
      return null;
    }

    // Validar que NINGUNA remesa asociada esté anulada.
    const rems = await tx.select({
      id: remesas.id, estado: remesas.estado, anuladoAt: remesas.deletedAt,
    }).from(manifiestoRemesas)
      .innerJoin(remesas, eq(remesas.id, manifiestoRemesas.remesaId))
      .where(eq(manifiestoRemesas.manifiestoId, manifiestoId));

    if (rems.some((r) => r.estado === 'anulada' || r.anuladoAt)) {
      await tx.update(manifiestos).set({
        estadoEnvio: 'cancelado_pre_envio',
        ultimoError: 'Una o más remesas asociadas están anuladas',
        ultimoIntentoAt: new Date(),
      }).where(eq(manifiestos.id, manifiestoId));
      return null;
    }

    await tx.update(manifiestos).set({
      estadoEnvio: 'enviando',
      ultimoIntentoAt: new Date(),
    }).where(eq(manifiestos.id, manifiestoId));

    return row;
  });

  if (!claimed) {
    return {
      ok: false, estadoFinal: 'cancelado_pre_envio',
      mensaje: 'Manifiesto no procesable (anulado, eliminado, ya enviado o remesas anuladas)',
    };
  }

  // 2. Si ya tiene consecutivo_rndc → ya fue radicado. Marcar aceptado y salir.
  if (claimed.consecutivoRndc) {
    await db.update(manifiestos).set({
      estadoEnvio: 'aceptado',
    }).where(eq(manifiestos.id, manifiestoId));
    return {
      ok: true, estadoFinal: 'aceptado',
      consecutivoRndc: claimed.consecutivoRndc,
      mensaje: 'Manifiesto ya radicado anteriormente',
    };
  }

  // 3. Cargar credenciales activas.
  const empresaNit = await getEmpresaNit();
  const ambiente = await getAmbiente();
  const credBundle = await getActiveCredenciales(empresaNit, ambiente);

  if (!credBundle) {
    return await marcarErrorTransitorio(manifiestoId, claimed.intentosEnvio, 'Sin credenciales RNDC activas (configurar en /rndc/admin/credenciales)');
  }

  // 4. Construir payload + verificar idempotency_keys.
  const payload = {
    consec: claimed.numero,
    vehiculoPrincipalId: claimed.vehiculoPrincipalId,
    conductorId: claimed.conductorId,
    municipioOrigenDane: claimed.municipioOrigenDane,
    municipioDestinoDane: claimed.municipioDestinoDane,
    fechaExpedicion: claimed.fechaExpedicion,
    valorFleteTotal: claimed.valorFleteTotal,
  };
  const requestHash = hashRequest(payload);

  const [existingIdem] = await db.select().from(rndcIdempotencyKeys)
    .where(eq(rndcIdempotencyKeys.consecutivoLocal, claimed.numero))
    .limit(1);

  if (existingIdem?.consecutivoRndc) {
    // Validar que el payload sea idéntico al que ya fue aceptado por RNDC.
    // Si el manifiesto fue editado tras un envío exitoso, el consecutivo viejo NO corresponde
    // al contenido actual: hay divergencia local↔RNDC. Bloqueamos para forzar resolución manual.
    if (existingIdem.requestHash !== requestHash) {
      await db.update(manifiestos).set({
        estadoEnvio: 'error_envio',
        ultimoError: 'Manifiesto editado tras envío aceptado por RNDC. Genere nuevo número o revierta cambios.',
      }).where(eq(manifiestos.id, manifiestoId));
      return {
        ok: false, estadoFinal: 'error_envio',
        codigo: 'PAYLOAD_DIVERGENCE',
        mensaje: 'Hash del payload no coincide con el ya aceptado por RNDC',
      };
    }
    // Mismo payload: reusar consecutivo (idempotencia exitosa).
    await db.update(manifiestos).set({
      estadoEnvio: 'aceptado',
      consecutivoRndc: existingIdem.consecutivoRndc,
      aceptadoAt: new Date(),
    }).where(eq(manifiestos.id, manifiestoId));
    return {
      ok: true, estadoFinal: 'aceptado',
      consecutivoRndc: existingIdem.consecutivoRndc,
      mensaje: 'Recuperado de tabla de idempotencia',
    };
  }

  // Marcar in-flight ANTES de llamar SOAP (sobrevive crash + restart).
  // Solo actualizamos requestHash si NO había consecutivoRndc previo (in-flight reintentando).
  await db.insert(rndcIdempotencyKeys).values({
    consecutivoLocal: claimed.numero,
    entidadTipo: 'manifiesto',
    entidadId: manifiestoId,
    requestHash,
    modo: getRndcClient().modo(),
  }).onConflictDoUpdate({
    target: rndcIdempotencyKeys.consecutivoLocal,
    set: { requestHash, updatedAt: new Date() },
    setWhere: sql`${rndcIdempotencyKeys.consecutivoRndc} IS NULL`,
  });

  // 5. Llamar al cliente con timeout.
  const intento = claimed.intentosEnvio + 1;
  const client = getRndcClient();
  let response: RndcResponse;

  try {
    response = await callWithTimeout(
      () => client.ingresarManifiesto({
        consecutivoLocal: claimed.numero,
        manifiestoId,
        payload,
      }, credBundle.creds),
      SOAP_TIMEOUT_MS,
    );
  } catch (e: any) {
    response = {
      ok: false, codigo: e?.message === 'TIMEOUT' ? 'TIMEOUT' : 'NETWORK',
      mensaje: e?.message ?? 'Error de transporte',
      rawXml: '', durationMs: SOAP_TIMEOUT_MS,
    };
  }

  // 6. Persistir log WORM.
  await logOperacion({
    tipoOp: 'ingresarManifiesto',
    entidadTipo: 'manifiesto', entidadId: manifiestoId,
    intento, modo: client.modo(),
    requestXml: redactClaveQR(JSON.stringify(payload)),
    responseXml: response.rawXml,
    resultado: classifyResultado(response.codigo),
    codigoResultado: response.codigo,
    consecutivoRndc: response.consecutivoRndc,
    mensaje: response.mensaje,
    duracionMs: response.durationMs,
    ipOrigen: ipOrigen ?? null,
  });

  // 7. Decidir estado final + actualizar manifiesto + idempotency.
  if (response.ok && response.consecutivoRndc) {
    await db.transaction(async (tx) => {
      await tx.update(manifiestos).set({
        estadoEnvio: 'aceptado',
        consecutivoRndc: response.consecutivoRndc,
        aceptadoAt: new Date(),
        intentosEnvio: intento,
        ultimoError: null,
      }).where(eq(manifiestos.id, manifiestoId));
      await tx.update(rndcIdempotencyKeys).set({
        consecutivoRndc: response.consecutivoRndc,
        resultado: 'ok',
      }).where(eq(rndcIdempotencyKeys.consecutivoLocal, claimed.numero));
    });
    return { ok: true, estadoFinal: 'aceptado', consecutivoRndc: response.consecutivoRndc, mensaje: response.mensaje };
  }

  if (isDuplicate(response.codigo)) {
    // ER07: RNDC ya tiene este consecutivo. Consultar estado para recuperar consecutivo_rndc.
    return await reconciliarDuplicado(manifiestoId, claimed.numero, intento, credBundle.creds);
  }

  if (isBusinessError(response.codigo)) {
    await db.update(manifiestos).set({
      estadoEnvio: 'fallido_definitivo',
      intentosEnvio: intento,
      ultimoError: `${response.codigo}: ${response.mensaje}`,
    }).where(eq(manifiestos.id, manifiestoId));
    await encolarNotificacion('manifiesto', manifiestoId, response.codigo, response.mensaje);
    return { ok: false, estadoFinal: 'fallido_definitivo', mensaje: response.mensaje };
  }

  // Transitorio: backoff o fallido_definitivo si excede MAX_INTENTOS.
  return await marcarErrorTransitorio(manifiestoId, intento, `${response.codigo}: ${response.mensaje}`);
}

async function marcarErrorTransitorio(
  manifiestoId: number, intentosEnvio: number, errorMsg: string,
): Promise<EnvioResult> {
  if (intentosEnvio >= MAX_INTENTOS) {
    await db.update(manifiestos).set({
      estadoEnvio: 'fallido_definitivo',
      intentosEnvio,
      ultimoError: errorMsg,
    }).where(eq(manifiestos.id, manifiestoId));
    await encolarNotificacion('manifiesto', manifiestoId, 'AGOTADO', errorMsg);
    return { ok: false, estadoFinal: 'fallido_definitivo', mensaje: errorMsg };
  }
  await db.update(manifiestos).set({
    estadoEnvio: intentosEnvio >= 5 ? 'fallido_temporal' : 'error_envio',
    intentosEnvio,
    proximoIntentoAt: calcBackoff(intentosEnvio),
    ultimoError: errorMsg,
  }).where(eq(manifiestos.id, manifiestoId));
  return { ok: false, estadoFinal: intentosEnvio >= 5 ? 'fallido_temporal' : 'error_envio', mensaje: errorMsg };
}

async function reconciliarDuplicado(
  manifiestoId: number, consecutivoLocal: string, intento: number, creds: any,
): Promise<EnvioResult> {
  const client = getRndcClient();
  try {
    const consulta = await callWithTimeout(
      () => client.consultarEstadoIngreso({ consecutivoLocal }, creds),
      SOAP_TIMEOUT_MS,
    );
    if (consulta.ok && consulta.consecutivoRndc) {
      await db.transaction(async (tx) => {
        await tx.update(manifiestos).set({
          estadoEnvio: 'aceptado',
          consecutivoRndc: consulta.consecutivoRndc,
          aceptadoAt: new Date(),
          intentosEnvio: intento,
          ultimoError: null,
        }).where(eq(manifiestos.id, manifiestoId));
        await tx.update(rndcIdempotencyKeys).set({
          consecutivoRndc: consulta.consecutivoRndc,
          resultado: 'ok',
        }).where(eq(rndcIdempotencyKeys.consecutivoLocal, consecutivoLocal));
      });
      return { ok: true, estadoFinal: 'aceptado', consecutivoRndc: consulta.consecutivoRndc, mensaje: 'Reconciliado por duplicado' };
    }
  } catch { /* fall-through */ }
  return await marcarErrorTransitorio(manifiestoId, intento, 'ER07 sin reconciliación posible');
}

function classifyResultado(codigo: string): 'ok' | 'error_negocio' | 'error_tecnico' | 'timeout' {
  if (codigo === '00') return 'ok';
  if (codigo === 'TIMEOUT') return 'timeout';
  if (isTransientError(codigo as any)) return 'error_tecnico';
  return 'error_negocio';
}

function callWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs);
    fn().then((r) => { clearTimeout(t); resolve(r); })
        .catch((e) => { clearTimeout(t); reject(e); });
  });
}

function redactClaveQR(payload: string): string {
  // Si futura serialización XML incluye <claveQR>, redactar antes de persistir.
  return payload.replace(/(<claveQR>)[^<]*(<\/claveQR>)/g, '$1[REDACTED]$2');
}

async function encolarNotificacion(
  entidadTipo: 'manifiesto' | 'remesa', entidadId: number, codigo: string, mensaje: string,
): Promise<void> {
  // Buscar admins activos.
  const admins = await db.select({ email: users.email })
    .from(users).where(and(eq(users.role, 'admin'), eq(users.active, true)));
  const emails = admins.map((a) => a.email).filter(Boolean);
  if (emails.length === 0) return;

  const asunto = `[RNDC] ${entidadTipo} #${entidadId} no pudo radicarse (${codigo})`;
  const html = `
    <p>Estimado administrador,</p>
    <p>El siguiente ${entidadTipo} fue marcado como <strong>fallido definitivo</strong> tras ${MAX_INTENTOS} intentos:</p>
    <ul>
      <li>ID interno: ${entidadId}</li>
      <li>Código RNDC: ${codigo}</li>
      <li>Mensaje: ${mensaje}</li>
    </ul>
    <p>Revise los logs en el panel de Operaciones RNDC.</p>
    <p>— Sistema Kyverum LLC</p>
  `;
  await db.insert(notificationOutbox).values({
    canal: 'email',
    destinatarios: JSON.stringify(emails),
    asunto, cuerpoHtml: html,
    contextoTipo: `rndc_fallido_${entidadTipo}`,
    contextoId: entidadId,
    proximoIntentoAt: new Date(),
  });
}
