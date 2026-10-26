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
// RN-DRF-S6  Adjuntos (HU #13805, P9-4 a): llegan en memoria en el mismo POST y se verifican por BYTES
//            (`detectMime`, el helper de PESV que ya usa Corredor SOAT) ANTES de crear el intento: un
//            archivo rechazado → 400 `adjunto-invalido` con su POSICIÓN y el motivo, sin intento, sin
//            ADO. Si el tipo declarado es uno de los admitidos tiene que coincidir con el detectado
//            (un `.png` que es un PDF se rechaza); `application/octet-stream` se acepta por contenido.
// RN-DRF-S7  Se suben a ADO con nombre genérico `adjunto-<n>.<ext>` y luego se crea el Bug con sus
//            `AttachedFile` en el mismo json-patch. Si falla la subida de CUALQUIERA: no se crea el
//            Bug, el intento queda `fallido` y la misma clave reintenta (AC5). Las urls de ADO no se
//            guardan; si el reintento sube de nuevo, las del intento fallido quedan huérfanas en ADO.
//            Su tratamiento está en docs/privacy/retencion-flito-dr-flit.md («Adjuntos huérfanos»).
// RN-DRF-S8  Nada queda en FLITO (AC4): ni disco ni MinIO ni base; la tabla guarda solo
//            `adjuntos_cantidad`. Los buffers se sueltan al terminar (éxito o fallo). El nombre del
//            archivo no entra al servicio: ni logs, ni auditoría, ni errores lo ven.
import type { Request } from 'express';
import { and, eq, or, sql } from 'drizzle-orm';
import type {
  AmbienteDespliegue, CasoRadicadoDrFlit, CasoSoporteDrFlit, MotivoAdjuntoRechazado, TipoAdjuntoSoporte,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoDrflitCasosSoporte as t, type EstadoIntentoDrFlit } from '../../db/schema/flito-drflit.js';
import { env } from '../../config/env.js';
import { loggerFor } from '../../shared/logger.js';
import { logPiiAccess } from '../../shared/pii-audit.js';
import { AdoNoDisponibleError, AdoRechazoError, obtenerClienteSoporteAdo } from './dr-flit-ado.client.js';
import { construirBugSoporte, type ConfigMapeoAdo } from './dr-flit-ado.mapeo.js';
import { ADJUNTOS_DRFLIT } from './dr-flit.config.js';
import { detectMime } from '../pesv/magic-number.js';

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

// ── Adjuntos (HU #13805) ─────────────────────────────────────────────────────────────────────────

/** Un adjunto tal como entra al servicio: bytes y tipo DECLARADO. Sin nombre a propósito (RN-DRF-S8). */
export interface AdjuntoCaso {
  contenido: Buffer;
  tipoDeclarado: string;
}

/** Archivo rechazado (400). `indice` = posición 0-based del archivo en el multipart (anexo UX §F5.17). */
export class AdjuntoInvalidoError extends Error {
  constructor(readonly indice: number, readonly motivo: MotivoAdjuntoRechazado) {
    super(mensajeAdjuntoRechazado(indice, motivo));
    this.name = 'AdjuntoInvalidoError';
  }
}

/** Copy del rechazo: posición 1-based para la persona; nunca el nombre ni el contenido del archivo. */
export function mensajeAdjuntoRechazado(
  indice: number, motivo: MotivoAdjuntoRechazado, maxBytesArchivo: number = ADJUNTOS_DRFLIT.maxBytesArchivo,
): string {
  const n = indice + 1;
  switch (motivo) {
    case 'vacio': return `El archivo ${n} está vacío.`;
    case 'muy-grande': return `El archivo ${n} supera el máximo de ${Math.floor(maxBytesArchivo / (1024 * 1024))} MB por archivo.`;
    case 'tipo-no-permitido': return `El archivo ${n} no es de un tipo permitido. Solo se aceptan PNG, JPG y PDF.`;
    case 'contenido-no-coincide':
      return `El contenido del archivo ${n} no corresponde a una imagen PNG o JPG ni a un PDF, o no coincide con su tipo.`;
  }
}

const EXTENSION: Readonly<Record<TipoAdjuntoSoporte, string>> = Object.freeze({
  'image/png': 'png', 'image/jpeg': 'jpg', 'application/pdf': 'pdf',
});
const esTipoAdmitido = (t: string | undefined): t is TipoAdjuntoSoporte =>
  t !== undefined && (ADJUNTOS_DRFLIT.tipos as readonly string[]).includes(t);

/**
 * MIME REAL por bytes (AC2). Devuelve el tipo detectado de cada adjunto, en orden; el primero que no
 * pasa lanza `AdjuntoInvalidoError` con su posición.
 */
export async function verificarAdjuntos(adjuntos: readonly AdjuntoCaso[]): Promise<TipoAdjuntoSoporte[]> {
  const tipos: TipoAdjuntoSoporte[] = [];
  for (const [i, a] of adjuntos.entries()) {
    if (a.contenido.length === 0) throw new AdjuntoInvalidoError(i, 'vacio');
    const detectado = await detectMime(a.contenido);
    if (!esTipoAdmitido(detectado)) throw new AdjuntoInvalidoError(i, 'contenido-no-coincide');
    if (esTipoAdmitido(a.tipoDeclarado) && a.tipoDeclarado !== detectado) {
      throw new AdjuntoInvalidoError(i, 'contenido-no-coincide');
    }
    tipos.push(detectado);
  }
  return tipos;
}

/** Nombre genérico que viaja a ADO (RN-DRF-C5): `adjunto-<n>.<ext>`, n 1-based. */
export function nombreGenericoAdjunto(indice: number, tipo: TipoAdjuntoSoporte): string {
  return `adjunto-${indice + 1}.${EXTENSION[tipo]}`;
}

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
  /** HU #13805. Ausente o vacío = caso sin adjuntos (igual que HU-2, AC6). Se vacía al terminar. */
  adjuntos?: AdjuntoCaso[];
}

/** Radica el caso (RN-DRF-S1..S5). `repetido=true` → la clave ya estaba radicada (200, sin ADO). */
export async function radicarCaso(req: Request, e: EntradaRadicacion): Promise<CasoRadicadoDrFlit> {
  const adjuntos = e.adjuntos ?? [];
  try {
    // Antes del intento (RN-DRF-S6): un archivo inválido no deja fila ni llama a ADO.
    const tipos = await verificarAdjuntos(adjuntos);
    return await radicarVerificado(req, e, adjuntos, tipos);
  } finally {
    adjuntos.splice(0); // RN-DRF-S8: suelta las referencias a los buffers.
  }
}

async function radicarVerificado(
  req: Request, e: EntradaRadicacion, adjuntos: readonly AdjuntoCaso[], tipos: readonly TipoAdjuntoSoporte[],
): Promise<CasoRadicadoDrFlit> {
  const adjuntosCantidad = adjuntos.length;
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

  const inicio = Date.now();
  const auditar = () => logPiiAccess(req, {
    resourceTipo: 'drflit_caso_soporte', resourceId: intento.id, accion: 'export',
    camposAccedidos: camposEnviados(e.caso, adjuntosCantidad), motivo: 'radicacion-soporte-ado',
  });

  try {
    const cliente = obtenerClienteSoporteAdo();
    // Secuencial: el primero que falla corta (AC5) y no se crea el Bug.
    const urlsAdjuntos: string[] = [];
    for (const [i, a] of adjuntos.entries()) {
      const { url } = await cliente.subirAdjunto(nombreGenericoAdjunto(i, tipos[i]!), tipos[i]!, a.contenido);
      urlsAdjuntos.push(url);
    }
    const operaciones = construirBugSoporte(e.caso, {
      intentoId: intento.id, ambiente: e.ambiente, fecha: new Date(), adjuntosCantidad, urlsAdjuntos,
    }, configMapeoDesdeEnv());
    const { numero, tagOmitido } = await cliente.crearBug({ operaciones });
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
