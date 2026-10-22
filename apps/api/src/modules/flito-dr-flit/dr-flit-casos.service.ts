// Dr. Flit — radicar el caso de soporte como Bug en FLIT - SOPORTE (HU #13804, Feature #13695).
// Diseño: docs/diseno/feature-13695-dr-flit-soporte.md («Idempotencia y reclamo atómico», «Logs y
// auditoría») y ADR-0026.
//
// RN-DRF-S1  Solo METADATOS en `flito_drflit_casos_soporte` (D6): usuario, autorización, clave, estado,
//            número de ADO, ambiente, cantidad de adjuntos, reintentos, clase de error y fechas. El
//            texto del caso viaja a ADO y no se guarda.
// RN-DRF-S2  Idempotencia por (usuario, claveIdempotencia):
//              · nueva                        → INSERT `pendiente` y se llama a ADO;
//              · `creado`                     → 200 con el MISMO número, sin llamar a ADO ni auditar;
//              · `fallido` o `pendiente` vencido (> DRFLIT_ADO_PENDIENTE_VENCE_S) → reclamo ATÓMICO
//                (un solo UPDATE con la condición en el WHERE) y se llama a ADO;
//              · `pendiente` reciente, o reclamo perdido frente a otra petición → 409 `radicacion-en-curso`.
// RN-DRF-S3  Éxito → `creado` + número + `radicado_en`. TF401289 → `creado` con `error_codigo =
//            'tag-rechazado'`. Fallo → `fallido` + clase (timeout|red|ado-5xx|ado-429|ado-4xx|ado-auth|interno).
// RN-DRF-S4  `logPiiAccess` (accion `export`, `drflit_caso_soporte`, id del intento, SOLO nombres de
//            campos) SIEMPRE que se llamó a ADO, con éxito o sin él: en un timeout los datos pueden
//            haber salido.
// RN-DRF-S5  Logs: id del intento, estado, clase de error, duración, `repetido`, `tagOmitido`. Nunca
//            valores del caso, la URL de ADO, cabeceras ni la respuesta de ADO.
import type { Request } from 'express';
import { and, eq, or, sql } from 'drizzle-orm';
import type { AmbienteDespliegue, CasoRadicadoDrFlit, CasoSoporteDrFlit } from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoDrflitCasosSoporte as t, type EstadoIntentoDrFlit } from '../../db/schema/flito-drflit.js';
import { env } from '../../config/env.js';
import { loggerFor } from '../../shared/logger.js';
import { logPiiAccess } from '../../shared/pii-audit.js';
import { AdoNoDisponibleError, AdoRechazoError, obtenerClienteSoporteAdo } from './dr-flit-ado.client.js';
import { construirBugSoporte, type ConfigMapeoAdo } from './dr-flit-ado.mapeo.js';

const log = loggerFor('flito-dr-flit');

export type CodigoCasoSoporte = 'radicacion-en-curso' | 'ado-error' | 'ado-no-disponible';

/** Error de dominio de la radicación. El mensaje es copy propio (nunca el de ADO). */
export class CasoSoporteError extends Error {
  constructor(readonly codigo: CodigoCasoSoporte, message: string) {
    super(message);
    this.name = 'CasoSoporteError';
  }
}

export const MENSAJES_CASO: Readonly<Record<CodigoCasoSoporte, string>> = Object.freeze({
  'radicacion-en-curso': 'Su caso ya se está radicando. Espere un momento y vuelva a intentarlo.',
  'ado-error': 'Soporte no pudo registrar su caso. Intente de nuevo en unos minutos; no perderá lo que escribió.',
  'ado-no-disponible': 'El servicio de soporte no responde en este momento. Intente de nuevo en unos minutos; no perderá lo que escribió.',
});

export interface IntentoCaso {
  id: number;
  estado: EstadoIntentoDrFlit;
  numeroAdo: number | null;
}

export interface NuevoIntento {
  usuarioId: number;
  autorizacionId: number;
  claveIdempotencia: string;
  ambiente: AmbienteDespliegue;
  adjuntosCantidad: number;
}

/** Conexión de Drizzle. Por defecto la del proceso; los tests contra PostgreSQL pasan la de su tx. */
export type ConexionCasos = Pick<typeof db, 'select' | 'insert' | 'update'>;

const columnas = { id: t.id, estado: t.estado, numeroAdo: t.numeroAdo };

/**
 * Acceso a datos. Objeto mutable a propósito (igual que `repoAutorizaciones`): los tests HTTP sustituyen
 * sus métodos con `vi.spyOn`; las consultas reales se prueban contra PostgreSQL en
 * `__tests__/db/migracion-0246.test.ts`.
 */
export const repoCasos = {
  /** INSERT … ON CONFLICT (usuario, clave) DO NOTHING. `null` si la clave ya existía para ese usuario. */
  async insertar(n: NuevoIntento, conexion: ConexionCasos = db): Promise<IntentoCaso | null> {
    const [fila] = await conexion.insert(t).values({ ...n, estado: 'pendiente' })
      .onConflictDoNothing({ target: [t.usuarioId, t.claveIdempotencia] })
      .returning(columnas);
    return fila ?? null;
  },

  async buscar(usuarioId: number, clave: string, conexion: ConexionCasos = db): Promise<IntentoCaso | null> {
    const [fila] = await conexion.select(columnas).from(t)
      .where(and(eq(t.usuarioId, usuarioId), eq(t.claveIdempotencia, clave))).limit(1);
    return fila ?? null;
  },

  /**
   * Reclamo ATÓMICO (RN-DRF-S2): toma el intento solo si está `fallido` o `pendiente` vencido. Dos
   * peticiones a la vez → una sola fila devuelta; la otra recibe `null` (409).
   */
  async reclamar(
    id: number, usuarioId: number, autorizacionId: number, venceS: number, conexion: ConexionCasos = db,
  ): Promise<IntentoCaso | null> {
    const [fila] = await conexion.update(t).set({
      estado: 'pendiente',
      reintentos: sql`${t.reintentos} + 1`,
      errorCodigo: null,
      autorizacionId,
      actualizadoEn: sql`now()`,
    }).where(and(
      eq(t.id, id),
      eq(t.usuarioId, usuarioId),
      or(
        eq(t.estado, 'fallido'),
        and(eq(t.estado, 'pendiente'), sql`${t.actualizadoEn} < now() - (${venceS}::int * interval '1 second')`),
      ),
    )).returning(columnas);
    return fila ?? null;
  },

  async marcarCreado(id: number, numero: number, errorCodigo: string | null, conexion: ConexionCasos = db): Promise<void> {
    await conexion.update(t).set({
      estado: 'creado', numeroAdo: numero, errorCodigo, radicadoEn: sql`now()`, actualizadoEn: sql`now()`,
    }).where(eq(t.id, id));
  },

  async marcarFallido(id: number, errorCodigo: string, conexion: ConexionCasos = db): Promise<void> {
    await conexion.update(t).set({ estado: 'fallido', errorCodigo, actualizadoEn: sql`now()` })
      .where(and(eq(t.id, id), eq(t.estado, 'pendiente')));
  },
};

/** Mapeo configurado por env (P9-2). Los nombres ya vienen validados por `env.ts`. */
export function configMapeoDesdeEnv(): ConfigMapeoAdo {
  return {
    campoDetalle: env.DRFLIT_ADO_CAMPO_DETALLE,
    campoPrioridad: env.DRFLIT_ADO_CAMPO_PRIORIDAD,
    campoAmbiente: env.DRFLIT_ADO_CAMPO_AMBIENTE,
    areaPath: env.DRFLIT_ADO_AREA_PATH,
    tags: env.DRFLIT_ADO_TAGS,
    tagsPruebas: env.DRFLIT_ADO_TAGS_PRUEBAS,
  };
}

/** Nombres (nunca valores) de los campos que salen hacia ADO, para `logPiiAccess` (AC8). */
export function camposEnviados(caso: CasoSoporteDrFlit, adjuntosCantidad: number): string[] {
  return [
    'contacto.nombre', 'contacto.correo', ...(caso.contacto.telefono ? ['contacto.telefono'] : []),
    'area', 'titulo', 'detalle', 'resultadoEsperado', 'frecuencia', 'prioridad',
    ...(adjuntosCantidad > 0 ? ['adjuntos'] : []),
  ];
}

export interface EntradaRadicacion {
  usuarioId: number;
  autorizacionId: number;
  ambiente: AmbienteDespliegue;
  caso: CasoSoporteDrFlit;
}

/** Radica el caso (RN-DRF-S1..S5). `repetido=true` → la clave ya estaba radicada (200, sin ADO). */
export async function radicarCaso(req: Request, e: EntradaRadicacion): Promise<CasoRadicadoDrFlit> {
  const adjuntosCantidad = 0; // HU-3 (#13805) los suma.
  const clave = e.caso.claveIdempotencia;
  let intento = await repoCasos.insertar({
    usuarioId: e.usuarioId, autorizacionId: e.autorizacionId, claveIdempotencia: clave,
    ambiente: e.ambiente, adjuntosCantidad,
  });
  if (!intento) {
    const existente = await repoCasos.buscar(e.usuarioId, clave);
    if (existente?.estado === 'creado' && existente.numeroAdo !== null) {
      log.info({ intentoId: existente.id, estado: 'creado', repetido: true }, 'dr-flit: caso ya radicado');
      return { numero: existente.numeroAdo, repetido: true };
    }
    intento = existente
      ? await repoCasos.reclamar(existente.id, e.usuarioId, e.autorizacionId, env.DRFLIT_ADO_PENDIENTE_VENCE_S)
      : null;
    if (!intento) {
      log.info({ intentoId: existente?.id ?? null, estado: 'pendiente' }, 'dr-flit: radicación en curso');
      throw new CasoSoporteError('radicacion-en-curso', MENSAJES_CASO['radicacion-en-curso']);
    }
  }

  const operaciones = construirBugSoporte(e.caso, {
    intentoId: intento.id, ambiente: e.ambiente, fecha: new Date(), adjuntosCantidad,
  }, configMapeoDesdeEnv());
  const inicio = Date.now();
  const auditar = () => logPiiAccess(req, {
    resourceTipo: 'drflit_caso_soporte', resourceId: intento.id, accion: 'export',
    camposAccedidos: camposEnviados(e.caso, adjuntosCantidad), motivo: 'radicacion-soporte-ado',
  });

  try {
    const { numero, tagOmitido } = await obtenerClienteSoporteAdo().crearBug({ operaciones });
    await repoCasos.marcarCreado(intento.id, numero, tagOmitido ? 'tag-rechazado' : null);
    await auditar();
    log.info({
      intentoId: intento.id, estado: 'creado', adjuntosCantidad, duracionMs: Date.now() - inicio,
      repetido: false, tagOmitido,
    }, 'dr-flit: caso radicado');
    return { numero, repetido: false };
  } catch (err) {
    const errorCodigo = err instanceof AdoNoDisponibleError || err instanceof AdoRechazoError ? err.clase : 'interno';
    await repoCasos.marcarFallido(intento.id, errorCodigo);
    await auditar();
    log.warn({
      intentoId: intento.id, estado: 'fallido', errorCodigo, adjuntosCantidad, duracionMs: Date.now() - inicio,
    }, 'dr-flit: la radicación falló');
    if (err instanceof AdoNoDisponibleError) {
      throw new CasoSoporteError('ado-no-disponible', MENSAJES_CASO['ado-no-disponible']);
    }
    // AdoRechazoError o un fallo propio: 502 con copy fijo (nunca el mensaje del error).
    throw new CasoSoporteError('ado-error', MENSAJES_CASO['ado-error']);
  }
}
