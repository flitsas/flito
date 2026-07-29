// FLITO Derechos de trámite — sincronización desde el Drive del organismo (HU #10952).
//
// Cada secretaría de tránsito publica sus recibos en su propio Drive. Este barrido recorre los
// organismos que tengan carpeta configurada y sincronización encendida, descarga lo que no haya
// procesado antes y lo pasa por el MISMO pipeline de la carga manual (HU #10950) — la única
// diferencia es el `origen`, que queda marcado como 'drive'.
//
// Idempotencia: el scope de Drive es de solo lectura, así que no se puede marcar el archivo en el
// origen. Se lleva localmente en `procesamiento_cuentas` por (fileId, modifiedTime): el par importa
// porque un archivo puede reemplazarse en Drive conservando su id, y entonces sí hay que releerlo.
//
// Un organismo que falla NO detiene a los demás: Drive caído para Medellín no puede dejar sin
// procesar a Bello, y el siguiente ciclo reintenta el que falló.

import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { organismosTransitoConfig, procesamientoCuentas } from '../../db/schema.js';
import { listFiles, downloadFile } from '../../services/googleDrive.js';
import { loggerFor } from '../../shared/logger.js';
import { cargarDerechos, type DerechoCtx, type ResultadoDerechos } from './flito-derechos.service.js';

const log = loggerFor('flito-derechos-drive');

/** Extensiones que tiene sentido bajar de la carpeta: el resto se ignora en silencio. */
const PROCESABLES = /\.(pdf|png|jpe?g|zip)$/i;

export interface ResumenOrganismo {
  organismoCodigo: string;
  archivosNuevos: number;
  registrados: number;
  enRevision: number;
  pendientes: number;
  duplicados: number;
  omitidas: number;
  fallidos: number;
  error?: string;
}

export interface ResumenSync {
  organismos: ResumenOrganismo[];
  /** Organismos con carpeta configurada y sincronización encendida en el momento del barrido. */
  organismosActivos: number;
}

const vacio = (organismoCodigo: string): ResumenOrganismo => ({
  organismoCodigo, archivosNuevos: 0, registrados: 0, enRevision: 0,
  pendientes: 0, duplicados: 0, omitidas: 0, fallidos: 0,
});

function acumular(resumen: ResumenOrganismo, r: ResultadoDerechos): void {
  resumen.registrados += r.registrados.length;
  resumen.enRevision += r.enRevision.length;
  resumen.pendientes += r.pendientes.length;
  resumen.duplicados += r.duplicados.length;
  resumen.omitidas += r.omitidas.length;
  resumen.fallidos += r.fallidos.length;
}

/** Organismos con carpeta puesta Y sincronización encendida. Configurar no es lo mismo que activar. */
export async function organismosConDrive(codigo?: string | null) {
  const conds = [
    eq(organismosTransitoConfig.flitoDriveActivo, true),
    eq(organismosTransitoConfig.activo, true),
  ];
  if (codigo) conds.push(eq(organismosTransitoConfig.codigo, codigo));
  const rows = await db.select({
    codigo: organismosTransitoConfig.codigo,
    folderId: organismosTransitoConfig.flitoDriveFolderId,
  }).from(organismosTransitoConfig).where(and(...conds));
  // Sin carpeta no hay nada que mirar: se omite sin ruido (no es un error de configuración a medias
  // que deba tumbar el barrido; el organismo simplemente aún no tiene Drive).
  return rows.filter((o): o is { codigo: string; folderId: string } => !!o.folderId);
}

/**
 * ¿Ya se procesó este archivo, en esta misma versión? Se compara id + fecha de modificación: si el
 * organismo reemplazó el archivo, su `modifiedTime` cambia y vuelve a entrar.
 */
async function yaProcesado(fileId: string, modifiedTime: string | null): Promise<boolean> {
  const [previo] = await db.select({
    modificado: procesamientoCuentas.driveModifiedTime,
  }).from(procesamientoCuentas)
    .where(and(
      eq(procesamientoCuentas.driveFileId, fileId),
      eq(procesamientoCuentas.estado, 'completado'),
    ))
    .orderBy(procesamientoCuentas.createdAt)
    .limit(1);

  if (!previo) return false;
  if (!modifiedTime || !previo.modificado) return true; // sin fecha comparable, el id manda
  return previo.modificado.getTime() >= new Date(modifiedTime).getTime();
}

/**
 * Sincroniza un organismo. Devuelve su resumen; si Drive falla, el resumen lleva el `error` y el
 * barrido general sigue con el resto.
 */
async function sincronizarOrganismo(
  organismo: { codigo: string; folderId: string },
  ctx: DerechoCtx,
): Promise<ResumenOrganismo> {
  const resumen = vacio(organismo.codigo);
  const archivos = await listFiles(organismo.folderId, 200);

  for (const archivo of archivos) {
    if (!PROCESABLES.test(archivo.name)) continue;
    if (await yaProcesado(archivo.id, archivo.modifiedTime)) continue;

    const [registro] = await db.insert(procesamientoCuentas).values({
      usuarioId: ctx.userId,
      driveFileId: archivo.id,
      nombreArchivo: archivo.name,
      organismoCodigo: organismo.codigo,
      driveModifiedTime: archivo.modifiedTime ? new Date(archivo.modifiedTime) : null,
      estado: 'procesando',
    }).returning({ id: procesamientoCuentas.id });

    try {
      const { buffer, name, mimeType } = await downloadFile(archivo.id);
      const resultado = await cargarDerechos(
        [{ originalname: name, mimetype: mimeType, buffer, size: buffer.length }],
        { organismoCodigo: organismo.codigo, origen: 'drive' },
        ctx,
      );
      acumular(resumen, resultado);
      resumen.archivosNuevos += 1;

      await db.update(procesamientoCuentas).set({
        estado: 'completado',
        cuentasDetectadas: resultado.registrados.length + resultado.enRevision.length + resultado.pendientes.length,
      }).where(eq(procesamientoCuentas.id, registro.id));
    } catch (e) {
      // El archivo queda en 'error', NO en 'completado': así el siguiente ciclo vuelve a intentarlo.
      const mensaje = (e as Error).message;
      await db.update(procesamientoCuentas).set({ estado: 'error', error: mensaje })
        .where(eq(procesamientoCuentas.id, registro.id)).catch(() => { /* el error ya está en el log */ });
      resumen.fallidos += 1;
      log.error({ organismo: organismo.codigo, fileId: archivo.id, err: mensaje }, 'archivo de Drive falló');
    }
  }

  return resumen;
}

/**
 * Barrido completo. `codigo` lo acota a un solo organismo (el botón «sincronizar ahora»).
 *
 * Los organismos se recorren en serie a propósito: cada archivo dispara varias llamadas de OCR y
 * paralelizar organismos multiplicaría la presión sobre la API de Anthropic sin ganar nada — el
 * barrido corre en segundo plano y nadie lo está esperando.
 */
export async function sincronizarDerechosDrive(ctx: DerechoCtx, codigo?: string | null): Promise<ResumenSync> {
  const organismos = await organismosConDrive(codigo);
  const resumenes: ResumenOrganismo[] = [];

  for (const organismo of organismos) {
    try {
      resumenes.push(await sincronizarOrganismo(organismo, ctx));
    } catch (e) {
      // Drive caído, credenciales vencidas, carpeta borrada: se registra y se sigue con el resto.
      const mensaje = (e as Error).message;
      log.error({ organismo: organismo.codigo, err: mensaje }, 'sincronización de organismo falló');
      resumenes.push({ ...vacio(organismo.codigo), error: mensaje });
    }
  }

  return { organismos: resumenes, organismosActivos: organismos.length };
}
