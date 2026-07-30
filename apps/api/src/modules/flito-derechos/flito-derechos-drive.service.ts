// FLITO Derechos de tránsito — el Drive de la secretaría, desde el módulo (HU #11010).
//
// La secretaría de Medellín publica en un Drive compartido un PDF consolidado por día con las
// cuentas de cobro de los derechos. Antes esto solo se podía procesar desde Administración → Google
// Drive, un explorador de archivos genérico; ahora se hace desde el propio módulo de derechos, que
// es donde se ve el resultado.
//
// Es BAJO DEMANDA, a propósito: quien opera elige el día y lo procesa. Un barrido automático se
// comería el OCR de los cincuenta PDF acumulados en la carpeta sin que nadie lo pidiera.
//
// Sustituye al barrido genérico por organismo de la HU #10952. Aquel recorría los organismos con
// carpeta configurada, pero ninguno la tenía ni había forma de ponérsela desde la aplicación: era
// generalidad sin demanda. El resto de secretarías siguen cargando sus recibos a mano.

import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { ESTADO_PROCESAMIENTO, procesamientoCuentas, systemKv } from '../../db/schema.js';
import { listFiles } from '../../services/googleDrive.js';
import { env } from '../../config/env.js';
import { loggerFor } from '../../shared/logger.js';
import {
  analizarPdfDeDrive, extraccionDeCuenta, separarPorPlaca, ProcesadorError, type CuentaCobro,
} from '../drive/procesador.service.js';
import {
  registrarDesdeExtraccion, type DerechoCtx, type ResultadoDerechos,
} from './flito-derechos.service.js';

const log = loggerFor('flito-derechos-drive');

/**
 * Organismo al que pertenece la carpeta. Hoy es Medellín, la única secretaría con Drive compartido.
 *
 * Va como constante y no como columna configurable porque no hay una segunda: inventar la tabla de
 * mapeo antes de tener el segundo caso fue exactamente el error de la HU #10952. Cuando aparezca
 * otra secretaría con Drive, esto se vuelve configuración con un caso real que la justifique.
 */
export const ORGANISMO_DRIVE = '05001';

/** Solo PDF: la carpeta puede tener hojas de cálculo u otros adjuntos que no son consolidados. */
const ES_PDF = /\.pdf$/i;

export interface ArchivoDrive {
  fileId: string;
  nombre: string;
  tamanoBytes: number | null;
  modificadoEn: string | null;
  /**
   * Quién tocó el archivo por última vez en el Drive. La fecha sola no era accionable: en una
   * carpeta compartida lo que hace falta es saber a quién preguntar. Null si Google no lo expone.
   */
  modificadoPor: string | null;
  /** Si ya se procesó antes, cuándo. Null = nunca. */
  procesadoEn: string | null;
  /** Si se dio por visto sin procesar (arranque del cron). Excluye del barrido automático. */
  omitidoEn: string | null;
}

/**
 * PDF de la carpeta, del más reciente al más antiguo, marcando los ya procesados.
 *
 * El «ya procesado» es informativo, no una prohibición: si el organismo reemplaza el archivo del día
 * conservando el nombre, hay que poder reprocesarlo. Lo que impide duplicar de verdad es el hash del
 * recibo, que ya vive en la carga de derechos.
 */
export async function archivosDelDrive(): Promise<ArchivoDrive[]> {
  const archivos = await listFiles(env.GOOGLE_DRIVE_FOLDER_ID, 100);
  const pdfs = archivos.filter((a) => ES_PDF.test(a.name));
  if (pdfs.length === 0) return [];

  const registros = await db.select({
    fileId: procesamientoCuentas.driveFileId,
    estado: procesamientoCuentas.estado,
    createdAt: procesamientoCuentas.createdAt,
  }).from(procesamientoCuentas)
    .where(inArray(procesamientoCuentas.estado, [ESTADO_PROCESAMIENTO.COMPLETADO, ESTADO_PROCESAMIENTO.OMITIDO]))
    .orderBy(desc(procesamientoCuentas.createdAt));

  // Solo la marca más reciente de cada archivo: reprocesar deja varias filas y la que manda es la
  // última. Se recorre en orden descendente, así que la primera que se ve de cada id ya es esa.
  const completado = new Map<string, Date>();
  const omitido = new Map<string, Date>();
  for (const r of registros) {
    if (!r.fileId) continue;
    const destino = r.estado === ESTADO_PROCESAMIENTO.OMITIDO ? omitido : completado;
    if (!completado.has(r.fileId) && !omitido.has(r.fileId)) destino.set(r.fileId, r.createdAt);
  }

  return pdfs.map((a) => ({
    fileId: a.id,
    nombre: a.name,
    tamanoBytes: a.size ? Number(a.size) : null,
    modificadoEn: a.modifiedTime ?? null,
    modificadoPor: nombreDe(a.lastModifyingUser),
    procesadoEn: completado.get(a.id)?.toISOString() ?? null,
    omitidoEn: omitido.get(a.id)?.toISOString() ?? null,
  }));
}

/** Nombre legible de quien modificó, con el correo como respaldo. */
function nombreDe(u: { displayName?: string; emailAddress?: string } | undefined): string | null {
  return u?.displayName?.trim() || u?.emailAddress?.trim() || null;
}

export interface ResultadoProcesoDrive extends ResultadoDerechos {
  archivo: string;
  totalPaginas: number;
  cuentasDetectadas: number;
  placasUnicas: number;
}

/**
 * Procesa un consolidado: lo baja, lo lee, lo separa por placa y asocia cada recibo a su trámite.
 *
 * Reusa el pipeline de la carga manual (`registrarDesdeExtraccion`), así que el cruce por placa, la
 * desambiguación cuando hay varios trámites, la bandeja de pendientes y la cola de revisión se
 * comportan EXACTAMENTE igual que si el archivo se hubiera subido a mano. La única diferencia es de
 * dónde salió el archivo, y eso queda registrado en `origen`.
 */
export async function procesarArchivoDrive(fileId: string, ctx: DerechoCtx): Promise<ResultadoProcesoDrive> {
  // Se toma el «modificado por» ANTES de procesar: si el archivo desaparece del Drive después, el
  // registro sigue diciendo quién lo había subido, que es de lo que sirve un registro.
  const metadatos = (await archivosDelDrive().catch(() => [])).find((a) => a.fileId === fileId);

  const [registro] = await db.insert(procesamientoCuentas).values({
    usuarioId: ctx.userId, driveFileId: fileId, estado: ESTADO_PROCESAMIENTO.PROCESANDO,
    organismoCodigo: ORGANISMO_DRIVE,
    modificadoPor: metadatos?.modificadoPor ?? null,
    driveModifiedTime: metadatos?.modificadoEn ? new Date(metadatos.modificadoEn) : null,
  }).returning({ id: procesamientoCuentas.id });

  try {
    const { name, srcDoc, totalPaginas, cuentas, paginasPorPlaca } = await analizarPdfDeDrive(fileId);
    const pdfsPorPlaca = await separarPorPlaca(srcDoc, paginasPorPlaca);

    // Una cuenta por placa: si el consolidado trae varias páginas de la misma, la primera manda —
    // son el desglose de un mismo pago, no pagos distintos.
    const cuentaPorPlaca = new Map<string, CuentaCobro>();
    for (const c of cuentas) if (!cuentaPorPlaca.has(c.placa)) cuentaPorPlaca.set(c.placa, c);

    const total: ResultadoProcesoDrive = {
      archivo: name, totalPaginas, cuentasDetectadas: cuentas.length, placasUnicas: pdfsPorPlaca.size,
      registrados: [], enRevision: [], duplicados: [], pendientes: [], omitidas: [], fallidos: [],
    };

    for (const [placa, buffer] of pdfsPorPlaca) {
      const cuenta = cuentaPorPlaca.get(placa);
      if (!cuenta) continue;
      try {
        const r = await registrarDesdeExtraccion(
          { originalname: `${placa}.pdf`, mimetype: 'application/pdf', buffer, size: buffer.length },
          extraccionDeCuenta(cuenta),
          // El organismo SÍ se declara: de él salen el umbral de OCR y la pista de prompt, y sin él
          // el derecho quedaría sin secretaría.
          { origen: 'drive', organismoCodigo: ORGANISMO_DRIVE },
          ctx,
        );
        total.registrados.push(...r.registrados);
        total.enRevision.push(...r.enRevision);
        total.duplicados.push(...r.duplicados);
        total.pendientes.push(...r.pendientes);
        total.omitidas.push(...r.omitidas);
        total.fallidos.push(...r.fallidos);
      } catch (e) {
        // Una placa que falla no tumba el consolidado: el resto del día sí se registra.
        total.fallidos.push({
          archivo: `${placa}.pdf`, placa, idFlit: null, registroId: null, valor: null,
          detalle: e instanceof Error ? e.message : 'Error procesando la cuenta.',
        });
      }
    }

    await db.update(procesamientoCuentas).set({
      estado: ESTADO_PROCESAMIENTO.COMPLETADO, nombreArchivo: name, totalPaginas,
      cuentasDetectadas: cuentas.length, placasUnicas: pdfsPorPlaca.size,
      valorTotal: String(cuentas.reduce((s, c) => s + c.valorTotal, 0)),
      organismoCodigo: ORGANISMO_DRIVE,
    }).where(eq(procesamientoCuentas.id, registro.id));

    log.info({
      fileId, archivo: name, placas: pdfsPorPlaca.size,
      registrados: total.registrados.length, pendientes: total.pendientes.length,
    }, 'Consolidado del Drive procesado');

    return total;
  } catch (e) {
    // `.catch()` solo cubriría un rechazo; si el `update` lanza en síncrono el error original se
    // perdería y quien llamó se quedaría esperando.
    try {
      await db.update(procesamientoCuentas)
        .set({ estado: ESTADO_PROCESAMIENTO.ERROR, error: e instanceof Error ? e.message : 'Error desconocido' })
        .where(eq(procesamientoCuentas.id, registro.id));
    } catch { /* el registro de auditoría no puede tapar el error real */ }
    throw e;
  }
}

export { ProcesadorError };

// ─────────────────────── Registro y barrido automático ──────────────────────

export interface RegistroProceso {
  id: number;
  fileId: string | null;
  nombreArchivo: string | null;
  estado: string;
  modificadoPor: string | null;
  modificadoEn: string | null;
  totalPaginas: number | null;
  cuentasDetectadas: number | null;
  placasUnicas: number | null;
  valorTotal: string | null;
  error: string | null;
  procesadoEn: string;
  /** false = el archivo ya no está en la carpeta del Drive. El registro es lo único que queda. */
  sigueEnDrive: boolean;
}

/**
 * Historial de lo procesado, INCLUIDOS los archivos que ya no están en el Drive.
 *
 * Es el motivo de que el registro exista: la carpeta la manejan personas del organismo y un
 * consolidado puede desaparecer. Si eso pasa, aquí queda que existió, qué se extrajo de él y quién
 * lo había subido. Consultar el Drive en vivo no serviría precisamente cuando hace falta.
 */
export async function registroProcesados(limite = 200): Promise<RegistroProceso[]> {
  const filas = await db.select().from(procesamientoCuentas)
    .where(isNotNull(procesamientoCuentas.driveFileId))
    .orderBy(desc(procesamientoCuentas.createdAt))
    .limit(limite);

  // Un fallo del Drive no puede tumbar el registro: sin listado, se informa como «no consta».
  const enCarpeta = new Set((await archivosDelDrive().catch(() => [])).map((a) => a.fileId));

  return filas.map((f) => ({
    id: f.id,
    fileId: f.driveFileId,
    nombreArchivo: f.nombreArchivo,
    estado: f.estado,
    modificadoPor: f.modificadoPor,
    modificadoEn: f.driveModifiedTime?.toISOString() ?? null,
    totalPaginas: f.totalPaginas,
    cuentasDetectadas: f.cuentasDetectadas,
    placasUnicas: f.placasUnicas,
    valorTotal: f.valorTotal,
    error: f.error,
    procesadoEn: f.createdAt.toISOString(),
    sigueEnDrive: f.driveFileId ? enCarpeta.has(f.driveFileId) : false,
  }));
}

export interface ResultadoBarrido {
  /** Archivos de la carpeta que no tenían registro y por tanto entraban al barrido. */
  candidatos: number;
  procesados: string[];
  fallidos: Array<{ archivo: string; detalle: string }>;
  /** Si fue el primer barrido: cuántos se dieron por vistos sin gastar OCR. */
  omitidosPorArranque: number;
}

/**
 * Barrido de la carpeta: procesa lo que aún no tiene registro.
 *
 * EL PRIMER BARRIDO NO PROCESA NADA. Marca como `omitido` todo lo que ya estaba en la carpeta y sale.
 * La razón es dinero: hay un centenar de consolidados acumulados, a unas trece páginas cada uno, y
 * cada página es una llamada de OCR. Cargar el histórico entero porque alguien encendió un cron no es
 * una decisión que deba tomar un cron. Lo que quede pendiente se procesa a mano, archivo por archivo,
 * desde la pestaña.
 */
export async function barrerDrive(ctx: DerechoCtx): Promise<ResultadoBarrido> {
  const archivos = await archivosDelDrive();
  const pendientes = archivos.filter((a) => !a.procesadoEn && !a.omitidoEn);

  const arrancado = await yaArrancado();
  if (!arrancado) {
    for (const a of pendientes) {
      await db.insert(procesamientoCuentas).values({
        usuarioId: ctx.userId, driveFileId: a.fileId, nombreArchivo: a.nombre,
        estado: ESTADO_PROCESAMIENTO.OMITIDO, organismoCodigo: ORGANISMO_DRIVE,
        modificadoPor: a.modificadoPor,
        driveModifiedTime: a.modificadoEn ? new Date(a.modificadoEn) : null,
        error: 'Ya estaba en la carpeta al encender el barrido automático: se da por visto sin procesar.',
      });
    }
    await marcarArrancado();
    log.info({ omitidos: pendientes.length }, 'Primer barrido del Drive: histórico dado por visto, sin OCR');
    return { candidatos: pendientes.length, procesados: [], fallidos: [], omitidosPorArranque: pendientes.length };
  }

  const res: ResultadoBarrido = { candidatos: pendientes.length, procesados: [], fallidos: [], omitidosPorArranque: 0 };
  for (const a of pendientes) {
    try {
      await procesarArchivoDrive(a.fileId, ctx);
      res.procesados.push(a.nombre);
    } catch (e) {
      // Un consolidado que falla no detiene los demás: el error queda en su propio registro.
      res.fallidos.push({ archivo: a.nombre, detalle: e instanceof Error ? e.message : 'Error desconocido' });
    }
  }
  log.info({ ...res, procesados: res.procesados.length }, 'Barrido del Drive completado');
  return res;
}

/** Marca de que el barrido ya se estrenó, en `system_kv` (mismo patrón que el reconciliador SOAT). */
const CLAVE_ARRANQUE = 'flito:drive:barrido:arrancado';

async function yaArrancado(): Promise<boolean> {
  const [row] = await db.select({ v: systemKv.v }).from(systemKv).where(eq(systemKv.k, CLAVE_ARRANQUE)).limit(1);
  return row !== undefined;
}

async function marcarArrancado(): Promise<void> {
  await db.insert(systemKv)
    .values({ k: CLAVE_ARRANQUE, v: { desde: new Date().toISOString() }, updatedAt: new Date() })
    .onConflictDoUpdate({ target: systemKv.k, set: { updatedAt: new Date() } });
}
