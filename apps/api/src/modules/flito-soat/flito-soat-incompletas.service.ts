// FLITO — SOAT, canal Cliente: solicitudes INCOMPLETAS por RUNT caído. Feature #12841, HU #12996.
// Diseño: docs/diseno-feature-12841-solicitud-incompleta-runt.md (§11 manda sobre §4).
// Decisión: docs/adr/ADR-0019-flito-soat-solicitud-incompleta-runt-caido.md (opción A, Aceptado).
//
// ── Qué hace ─────────────────────────────────────────────────────────────────────────────────────
//
// Cuando el alta del canal Cliente (`crearSolicitud`) consulta el RUNT y el registro no responde, la
// solicitud NO se pierde y NO se despacha: se APARCA en `flito_soat_incompletas` con su factura y su
// propietario. La pantalla recibe un 202 y le dice al usuario que quedó «pendiente de validar».
//
// ── Lo que este módulo NO hace, y por qué eso es la HU entera ───────────────────────────────────
//
//   · No escribe en `flito_soat` ni en `vehicles`. La incompleta no es un SOAT (CF-02): la cola, sus
//     facetas, el Excel, el ZIP de soportes, el envío al gestor y el cron de vigencia leen
//     `flito_soat` y por eso no la ven — sin un solo filtro nuevo que alguien pueda olvidar.
//   · No reutiliza `flito_soat_solicitud.verificacion_estado = 'caido'` (ADR-0019): ese valor es el
//     residuo histórico del intervalo #11935–#11966 y significa «despachada sin RUNT».
//   · No guarda nada del RUNT: el RUNT no respondió. Placa, marca, línea… llegan en el reintento.
//
// ── La clave de la factura se nombra con el id que TENDRÁ el SOAT ────────────────────────────────
//
// `soat_id_reservado` se genera aquí y nombra el objeto en S3 igual que el alta normal lo nombra con
// el `soatId`. Cuando el reintento complete la solicitud, el SOAT nacerá con ese mismo uuid y la
// factura ya estará donde el resto del sistema la busca, sin mover bytes.
//
// ── Lectura: la bandeja «Por validar» / «Descartadas» (HU #12997) ─────────────────────────────────
//
// `buscarIncompletas` y `detalleIncompleta` sirven las pastillas nuevas de la cola y su detalle. La
// cola de `flito_soat` (`GET /`, facetas, Excel, ZIP) NO cambia (§4.2 variante a): la pantalla antepone
// estas filas llamando a su propio endpoint. El alcance de filas es el del ENLACE del rol (`ctx.alcance`,
// Bug #12869), sin literales de rol: `todo` ve todo, `compania` su compañía, y `proveedor` / `nada`
// CERO filas — la incompleta nunca se envió a ningún gestor, así que no hay nada suyo que ver.
//
// ── Retención (AC10, Q7 del diseño, CF-06) ───────────────────────────────────────────────────────
//
// La MISMA que la de las solicitudes del canal Cliente en `flito_soat`: hoy sin purga automática
// (`privacy/retention.cron.ts` no las recorre). Las DESCARTADAS nunca se borran: quedan como constancia
// de la solicitud y de por qué no siguió. Si algún día se declara una purga para el canal, esta tabla
// y su propietario en `flito_compradores.soat_incompleta_id` entran en la misma edición.
//
// ── Logs (AC10) ──────────────────────────────────────────────────────────────────────────────────
//
// Solo el uuid de la incompleta y la compañía. Ni VIN, ni placa, ni documento, ni el mensaje crudo
// de ningún error: el desenlace del RUNT ya lo registra `consultarYClasificar` con un token de causa.

import { createHash, randomUUID } from 'crypto';
import { and, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { clients, flitoCompradores, flitoSoatIncompletas, users } from '../../db/schema.js';
import {
  AUTOR_DESCARTE_FLITO, EstadoSolicitudIncompletaSoat,
  type MotivoDescarteSoat, type PropietarioSolicitudIncompleta, type RespuestaBuscarIncompletas,
  type SolicitudIncompletaDetalle, type SolicitudIncompletaFila,
} from '@operaciones/shared-types';
import { carpetaDe } from '../flito-parametrizacion/flito-parametrizacion.service.js';
import { uploadEntityDocument } from '../../services/storage.js';
import { loggerFor } from '../../shared/logger.js';
import type { SoatCtx } from './flito-soat.service.js';
import {
  CARPETA_ADICIONALES, compensarAdicionales, insertarAdicionales, subirAdicionales,
  type AdicionalAceptado, type AdicionalGuardado,
} from './flito-soat-documentos.service.js';
import type {
  ArchivoSolicitud,
  PropietarioSolicitud,
} from './flito-soat-cliente.service.js';
import type { ProcedenciaComprador } from '@operaciones/shared-types';

const log = loggerFor('flito-soat-incompletas');

/** Código de violación de unicidad de PostgreSQL: aquí, el índice parcial del VIN abierto. */
const UNIQUE_VIOLATION = '23505';

/**
 * El texto que acompaña al 202 (AC1). Constante exportada para que los tests la nombren en vez de
 * copiarla. No menciona el VIN: el mensaje explica qué pasó, no con qué vehículo.
 */
export const MENSAJE_SOLICITUD_INCOMPLETA =
  'El RUNT no respondió. Su solicitud quedó guardada, pendiente de validar, y no se enviará al gestor hasta que el RUNT confirme el vehículo.';

/** Lo que el alta ya validó y resolvió antes de aparcar: nada de esto se vuelve a decidir aquí. */
export interface EntradaAparcar {
  /** VIN tecleado y normalizado (`normalizarId`): el RUNT no respondió, no hay VIN efectivo. */
  vin: string;
  companiaId: number;
  carpetaStorage: string | null;
  propietario: PropietarioSolicitud;
  /** Nombre derivado (`nombreCompletoDe`), el mismo que escribe el alta normal. */
  nombreCompleto: string;
  /** Mapa completo (`procedenciaCompleta`), igual que el alta normal. */
  procedencia: ProcedenciaComprador;
  archivo: ArchivoSolicitud;
  /** HU #13362 (D3-bis): los adicionales aceptados también se guardan, contra la por validar. */
  adicionales?: AdicionalAceptado[];
}

export type ResultadoAparcar =
  | { aparcada: true; id: string; soatIdReservado: string; adicionalesGuardados: AdicionalGuardado[] }
  /**
   * Otra petición abrió una incompleta para el mismo VIN entre la comprobación de la RN-01 y el
   * INSERT (el índice único parcial saltó). Quien llama decide el 409 volviendo a mirar la RN-01,
   * que sabe distinguir la forma propia de la ajena.
   */
  | { aparcada: false; motivo: 'vin_ocupado' };

/**
 * Aparca la solicitud (AC1): factura en S3 con la clave del `soat_id_reservado`, y en UNA
 * transacción la fila de `flito_soat_incompletas` (intentos = 1, último intento = ahora) y el
 * propietario en `flito_compradores` colgado de ella.
 *
 * El propietario recibe el MISMO tratamiento que en el alta normal (Ley 1581): misma tabla, mismas
 * columnas, mismo nombre derivado y el mismo mapa de procedencia. Así cualquier ejercicio de derechos
 * sobre `flito_compradores` lo encuentra.
 *
 * La subida va FUERA de la transacción (CA-11, igual que el alta): una transacción no puede
 * deshacer un PUT en S3, y retenerla abierta mientras sube el PDF es peor.
 */
export async function aparcarSolicitud(entrada: EntradaAparcar, ctx: SoatCtx): Promise<ResultadoAparcar> {
  const soatIdReservado = randomUUID();
  const { archivo } = entrada;
  const hash = createHash('sha256').update(archivo.buffer).digest('hex');
  const storageKey = await uploadEntityDocument(
    carpetaDe({ id: entrada.companiaId, flitoCarpetaStorage: entrada.carpetaStorage }, 'soat/facturas-venta'),
    soatIdReservado, archivo.originalname, archivo.buffer, archivo.mimetype,
  );
  // Mismo `entityId` que la factura: al completar, el `soat_id` final ES el reservado (D3-bis §2).
  const subidos = await subirAdicionales(
    carpetaDe({ id: entrada.companiaId, flitoCarpetaStorage: entrada.carpetaStorage }, CARPETA_ADICIONALES),
    soatIdReservado, entrada.adicionales ?? [],
  );

  const ahora = new Date();
  let id!: string;
  let adicionalesGuardados: AdicionalGuardado[] = [];
  try {
    await db.transaction(async (tx) => {
      const [fila] = await tx.insert(flitoSoatIncompletas).values({
        soatIdReservado,
        companiaId: entrada.companiaId,
        vin: entrada.vin,
        estado: EstadoSolicitudIncompletaSoat.INCOMPLETA,
        facturaStorageKey: storageKey,
        facturaHash: hash,
        facturaNombreArchivo: archivo.originalname,
        facturaContentType: archivo.mimetype,
        facturaTamanoBytes: archivo.size,
        solicitadoPorId: ctx.userId,
        solicitadoPorNombre: ctx.username,
        solicitadoEn: ahora,
        // El alta ES el primer intento contra el RUNT (AC1).
        intentos: 1,
        ultimoIntentoEn: ahora,
        ultimoIntentoPorId: ctx.userId,
      }).returning({ id: flitoSoatIncompletas.id });
      id = fila.id;

      await tx.insert(flitoCompradores).values({
        soatIncompletaId: id,
        nombreCompleto: entrada.nombreCompleto,
        nombres: entrada.propietario.nombres,
        apellidos: entrada.propietario.apellidos,
        razonSocial: entrada.propietario.razonSocial,
        numeroDocumento: entrada.propietario.numeroDocumento,
        tipoDocumento: entrada.propietario.tipoDocumento,
        correo: entrada.propietario.correo,
        celular: entrada.propietario.celular,
        direccion: entrada.propietario.direccion,
        municipio: entrada.propietario.municipio,
        departamento: entrada.propietario.departamento,
        procedencia: entrada.procedencia,
        orden: 0,
      });

      adicionalesGuardados = await insertarAdicionales(
        tx, subidos, { soatIncompletaId: id }, { id: ctx.userId, nombre: ctx.username },
      );
    });
  } catch (e) {
    // AC7 de la HU #13362: si no hay COMMIT, ningún adicional queda en storage (también con `vin_ocupado`).
    await compensarAdicionales(subidos);
    if ((e as { code?: string })?.code === UNIQUE_VIOLATION) {
      log.warn({ companiaId: entrada.companiaId, desenlace: 'vin_ocupado' },
        'Solicitud SOAT incompleta no aparcada: el VIN ya tenía una incompleta abierta');
      return { aparcada: false, motivo: 'vin_ocupado' };
    }
    throw e;
  }

  log.info({ incompletaId: id, companiaId: entrada.companiaId },
    'Solicitud SOAT del canal Cliente aparcada como incompleta: el RUNT no respondió');
  return { aparcada: true, id, soatIdReservado, adicionalesGuardados };
}

// ─────────────────────────────── Lectura (HU #12997) ────────────────────────────────────────────

export interface FiltroIncompletas {
  estados: EstadoSolicitudIncompletaSoat[];
  /** VIN (contiene) o documento exacto del propietario. Llega SOLO por el body. */
  texto?: string;
  pagina: number;
  porPagina: number;
}

/**
 * La condición de alcance por ENLACE, o `null` cuando el contexto no ve ninguna fila (proveedor,
 * nada, o compañía sin su id). `undefined` = sin recorte (`todo`). Fallo cerrado: cualquier alcance
 * que no sea `todo` ni `compania` con id es «nada».
 */
export function condicionAlcance(ctx: SoatCtx): SQL | undefined | null {
  if (ctx.alcance === 'todo') return undefined;
  if (ctx.alcance === 'compania' && ctx.companiaId !== null) {
    return eq(flitoSoatIncompletas.companiaId, ctx.companiaId);
  }
  return null;
}

const escaparLike = (s: string) => s.replace(/[\\%_]/g, '\\$&');

/** VIN que contiene el texto, o propietario con ese documento exacto. Todo parametrizado. */
function condicionTexto(texto: string): SQL {
  const limpio = texto.trim();
  return or(
    ilike(flitoSoatIncompletas.vin, `%${escaparLike(limpio.toUpperCase())}%`),
    sql`EXISTS (SELECT 1 FROM ${flitoCompradores}
      WHERE ${flitoCompradores.soatIncompletaId} = ${flitoSoatIncompletas.id}
        AND ${flitoCompradores.numeroDocumento} = ${limpio})`,
  )!;
}

const COLUMNAS_FILA = {
  id: flitoSoatIncompletas.id,
  estado: flitoSoatIncompletas.estado,
  vin: flitoSoatIncompletas.vin,
  companiaId: flitoSoatIncompletas.companiaId,
  companiaNombre: clients.name,
  titular: flitoCompradores.nombreCompleto,
  solicitadoPorNombre: flitoSoatIncompletas.solicitadoPorNombre,
  solicitadoEn: flitoSoatIncompletas.solicitadoEn,
  intentos: flitoSoatIncompletas.intentos,
  ultimoIntentoEn: flitoSoatIncompletas.ultimoIntentoEn,
  motivoDescarte: flitoSoatIncompletas.motivoDescarte,
  resueltaEn: flitoSoatIncompletas.resueltaEn,
  resueltaPorId: flitoSoatIncompletas.resueltaPorId,
  resueltaPorNombre: flitoSoatIncompletas.resueltaPorNombre,
  soatId: flitoSoatIncompletas.soatId,
};

interface FilaCruda {
  id: string; estado: string; vin: string; companiaId: number; companiaNombre: string | null;
  titular: string | null; solicitadoPorNombre: string; solicitadoEn: Date; intentos: number;
  ultimoIntentoEn: Date; motivoDescarte: string | null; resueltaEn: Date | null;
  resueltaPorId: number | null; resueltaPorNombre: string | null; soatId: string | null;
}

const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

/**
 * Compañía de cada autor de descarte, solo cuando quien mira está acotado a una compañía (Q6 / P-4).
 * Un contexto `todo` (FLITO) ve el nombre real sin consulta extra.
 */
async function companiasDeAutores(filas: FilaCruda[], ctx: SoatCtx): Promise<Map<number, number | null>> {
  const ids = [...new Set(filas
    .filter((f) => f.estado === EstadoSolicitudIncompletaSoat.DESCARTADA && f.resueltaPorId !== null)
    .map((f) => f.resueltaPorId as number))];
  if (ctx.alcance === 'todo' || ids.length === 0) return new Map();
  const rows = await db.select({ id: users.id, companiaId: users.companiaId })
    .from(users).where(inArray(users.id, ids));
  return new Map(rows.map((r) => [r.id, r.companiaId]));
}

/**
 * Q6 / P-4: el nombre real si quien descartó comparte el enlace de compañía del que mira; si no,
 * «FLITO». FLITO (alcance `todo`) ve siempre el real. En base se guarda el real.
 */
function autorVisible(f: FilaCruda, ctx: SoatCtx, companias: Map<number, number | null>): string {
  const real = f.resueltaPorNombre ?? AUTOR_DESCARTE_FLITO;
  if (ctx.alcance === 'todo') return real;
  if (f.resueltaPorId === null || ctx.companiaId === null) return AUTOR_DESCARTE_FLITO;
  return companias.get(f.resueltaPorId) === ctx.companiaId ? real : AUTOR_DESCARTE_FLITO;
}

function aFila(f: FilaCruda, ctx: SoatCtx, companias: Map<number, number | null>): SolicitudIncompletaFila {
  const descartada = f.estado === EstadoSolicitudIncompletaSoat.DESCARTADA;
  return {
    id: f.id,
    estado: f.estado as EstadoSolicitudIncompletaSoat,
    vin: f.vin,
    companiaId: f.companiaId,
    companiaNombre: f.companiaNombre,
    // R5 del UX: el RUNT no respondió, no hay de dónde sacarlas.
    placa: null, marca: null, linea: null,
    titular: f.titular,
    solicitadoPorNombre: f.solicitadoPorNombre,
    solicitadoEn: iso(f.solicitadoEn),
    intentos: f.intentos,
    ultimoIntentoRuntEn: iso(f.ultimoIntentoEn),
    descarte: descartada && f.motivoDescarte && f.resueltaEn
      ? { motivo: f.motivoDescarte as MotivoDescarteSoat, en: iso(f.resueltaEn), porNombre: autorVisible(f, ctx, companias) }
      : null,
    soatId: f.estado === EstadoSolicitudIncompletaSoat.COMPLETADA ? f.soatId : null,
  };
}

const VACIO: RespuestaBuscarIncompletas = { items: [], total: 0, conteos: { incompleta: 0, descartada: 0 } };

/**
 * `POST /cliente/incompletas/buscar` (AC1). Los `conteos` alimentan las pastillas y NO dependen de
 * `estados` (sí del alcance y del texto): la pastilla «Descartadas» cuenta aunque se esté mirando
 * «Por validar». `total` es el de los estados pedidos.
 */
export async function buscarIncompletas(filtro: FiltroIncompletas, ctx: SoatCtx): Promise<RespuestaBuscarIncompletas> {
  const alcance = condicionAlcance(ctx);
  if (alcance === null) return { ...VACIO, conteos: { ...VACIO.conteos } };
  const base = and(alcance, filtro.texto ? condicionTexto(filtro.texto) : undefined);

  const porEstado = await db.select({ estado: flitoSoatIncompletas.estado, n: sql<number>`count(*)::int` })
    .from(flitoSoatIncompletas).where(base).groupBy(flitoSoatIncompletas.estado);
  const cuenta = (e: string) => Number(porEstado.find((r) => r.estado === e)?.n ?? 0);
  const conteos = {
    incompleta: cuenta(EstadoSolicitudIncompletaSoat.INCOMPLETA),
    descartada: cuenta(EstadoSolicitudIncompletaSoat.DESCARTADA),
  };
  const total = filtro.estados.reduce((acc, e) => acc + cuenta(e), 0);
  if (total === 0) return { items: [], total, conteos };

  const filas = await db.select(COLUMNAS_FILA)
    .from(flitoSoatIncompletas)
    .leftJoin(clients, eq(clients.id, flitoSoatIncompletas.companiaId))
    .leftJoin(flitoCompradores, and(
      eq(flitoCompradores.soatIncompletaId, flitoSoatIncompletas.id), eq(flitoCompradores.orden, 0)))
    .where(and(base, inArray(flitoSoatIncompletas.estado, filtro.estados)))
    .orderBy(desc(flitoSoatIncompletas.solicitadoEn), desc(flitoSoatIncompletas.id))
    .limit(filtro.porPagina)
    .offset((filtro.pagina - 1) * filtro.porPagina) as FilaCruda[];

  const companias = await companiasDeAutores(filas, ctx);
  return { items: filas.map((f) => aFila(f, ctx, companias)), total, conteos };
}

/**
 * `GET /cliente/incompletas/:id` (AC3). `null` si no existe O está fuera del alcance: la ruta
 * responde 404 en los dos casos, no 403, para no confirmar que el id existe.
 */
export async function detalleIncompleta(id: string, ctx: SoatCtx): Promise<SolicitudIncompletaDetalle | null> {
  const alcance = condicionAlcance(ctx);
  if (alcance === null) return null;

  const [fila] = await db.select({
    ...COLUMNAS_FILA,
    facturaNombreArchivo: flitoSoatIncompletas.facturaNombreArchivo,
    facturaContentType: flitoSoatIncompletas.facturaContentType,
    facturaTamanoBytes: flitoSoatIncompletas.facturaTamanoBytes,
  })
    .from(flitoSoatIncompletas)
    .leftJoin(clients, eq(clients.id, flitoSoatIncompletas.companiaId))
    .leftJoin(flitoCompradores, and(
      eq(flitoCompradores.soatIncompletaId, flitoSoatIncompletas.id), eq(flitoCompradores.orden, 0)))
    .where(and(eq(flitoSoatIncompletas.id, id), alcance))
    .limit(1) as (FilaCruda & { facturaNombreArchivo: string; facturaContentType: string; facturaTamanoBytes: number })[];
  if (!fila) return null;

  const [p] = await db.select({
    tipoDocumento: flitoCompradores.tipoDocumento,
    nombres: flitoCompradores.nombres,
    apellidos: flitoCompradores.apellidos,
    razonSocial: flitoCompradores.razonSocial,
    numeroDocumento: flitoCompradores.numeroDocumento,
    correo: flitoCompradores.correo,
    celular: flitoCompradores.celular,
    direccion: flitoCompradores.direccion,
    municipio: flitoCompradores.municipio,
    departamento: flitoCompradores.departamento,
  }).from(flitoCompradores)
    .where(eq(flitoCompradores.soatIncompletaId, id))
    .orderBy(flitoCompradores.orden)
    .limit(1);

  const propietario: PropietarioSolicitudIncompleta | null = p ? {
    tipoDocumento: p.tipoDocumento, nombres: p.nombres, apellidos: p.apellidos, razonSocial: p.razonSocial,
    numeroDocumento: p.numeroDocumento, correo: p.correo, celular: p.celular, direccion: p.direccion,
    municipio: p.municipio, departamento: p.departamento,
  } : null;

  const companias = await companiasDeAutores([fila], ctx);
  return {
    ...aFila(fila, ctx, companias),
    propietario,
    factura: {
      nombreArchivo: fila.facturaNombreArchivo,
      contentType: fila.facturaContentType,
      tamanoBytes: fila.facturaTamanoBytes,
    },
  };
}
