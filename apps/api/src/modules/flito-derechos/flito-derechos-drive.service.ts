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

import { desc, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { procesamientoCuentas } from '../../db/schema.js';
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
  /** Si ya se procesó antes, cuándo. Null = nunca. */
  procesadoEn: string | null;
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

  const procesados = await db.select({
    fileId: procesamientoCuentas.driveFileId,
    createdAt: procesamientoCuentas.createdAt,
  }).from(procesamientoCuentas)
    .where(eq(procesamientoCuentas.estado, 'completado'))
    .orderBy(desc(procesamientoCuentas.createdAt));

  const ultimoPorArchivo = new Map<string, Date>();
  for (const p of procesados) {
    if (p.fileId && !ultimoPorArchivo.has(p.fileId)) ultimoPorArchivo.set(p.fileId, p.createdAt);
  }

  return pdfs.map((a) => ({
    fileId: a.id,
    nombre: a.name,
    tamanoBytes: a.size ? Number(a.size) : null,
    modificadoEn: a.modifiedTime ?? null,
    procesadoEn: ultimoPorArchivo.get(a.id)?.toISOString() ?? null,
  }));
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
  const [registro] = await db.insert(procesamientoCuentas).values({
    usuarioId: ctx.userId, driveFileId: fileId, estado: 'procesando',
    organismoCodigo: ORGANISMO_DRIVE,
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
      estado: 'completado', nombreArchivo: name, totalPaginas,
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
        .set({ estado: 'error', error: e instanceof Error ? e.message : 'Error desconocido' })
        .where(eq(procesamientoCuentas.id, registro.id));
    } catch { /* el registro de auditoría no puede tapar el error real */ }
    throw e;
  }
}

export { ProcesadorError };
