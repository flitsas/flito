// FLITO Impuestos — paso «extracción» del análisis post-envío (HU #12826, Épica #12809, Feature #12821).
//
// Primer paso registrado en la cola de la HU 12825 (`registrarPasoAnalisis`). Descarga la factura de
// venta del trámite desde FLIT, lee los datos del vehículo y la dirección del comprador, y los deja
// en `flito_impuestos.extraccion_factura_venta` para que la HU 12827 los compare con el RUNT.
//
//   AC1  Factura FLIT con «Notas Finales» → parser determinístico (`flito-ocr-factura-flit.ts`):
//        vin, marca, anioVehiculo, color, cilindrada, clase de Notas Finales; `linea` de la
//        «Descripción» del producto (decisión del humano, 2026-09-23); dirección, municipio y
//        departamento del bloque Adquiriente. Cada campo `{ valor, confianza, confiable }`.
//   AC2  Sin Notas Finales reconocibles (PDF escaneado, imagen, otra plantilla) → motor OCR existente
//        con el prompt `PROMPT_FACTURA_VENTA_VEHICULO`. `OcrNoDisponibleError` se relanza.
//
// Desenlace (lo decide la cola, este paso solo lanza o no): sin factura, descarga fallida o OCR caído
// → el paso LANZA → `error_analisis`, sin escribir nada. Parser u OCR respondieron (aunque haya
// campos no confiables) → se persiste → `completado`. `error_analisis` es solo para fallos técnicos.
//
// PII: el jsonb lleva la dirección del comprador y el VIN. Nada de valores en los logs —ni el texto
// del PDF, ni el VIN, ni la URL presignada de FLIT (lleva firma)—, solo el id, la fuente y conteos.
// Cada extracción persistida deja constancia en `pii_access_log` (ver `registrarAccesoSistema`).

import type { Request } from 'express';
import { and, eq } from 'drizzle-orm';
import {
  AnalisisEstadoImpuesto, type CampoExtraido, type ExtraccionFacturaVentaImpuesto,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { flitoImpuestos, flitoTramites } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import { logPiiAccess } from '../../shared/pii-audit.js';
import { tipoPorBytes } from '../../shared/soportes/soportes-zip.js';
import { getFlitAdapter } from '../flito-sync/flit.adapter.js';
import { textoPdf } from '../flito-ocr/flito-ocr-local.js';
import { extraerVehiculoFacturaVenta } from '../flito-ocr/flito-ocr.service.js';
import {
  CAMPOS_DIRECCION_FACTURA, CAMPOS_VEHICULO_FACTURA, descripcionProducto, extraccionCompleta,
  lineaDesdeDescripcion, parsearAdquiriente, parsearNotasFinales,
} from '../flito-ocr/flito-ocr-factura-flit.js';
import { umbralPara } from '../flito-parametrizacion/flito-parametrizacion.service.js';
import { RECURSO_IMPUESTO } from './flito-impuestos.pii.js';
import type { PasoAnalisis } from './flito-impuestos.analisis.service.js';

const log = loggerFor('flito-impuestos.extraccion');

/** Tope de la descarga: el job corre sin supervisión y la ruta interactiva no tiene ninguno. */
export const TOPE_FACTURA_BYTES = 15 * 1024 * 1024;
const TIMEOUT_DESCARGA_MS = 30_000;

export type MotivoFacturaNoDisponible = 'sin_factura' | 'url_nula' | 'descarga' | `http_${number}` | 'tope';

/** La factura del impuesto no se pudo obtener de FLIT. El paso lanza → `error_analisis`. */
export class FacturaNoDisponibleError extends Error {
  constructor(public readonly motivo: MotivoFacturaNoDisponible) {
    super(`Factura de venta no disponible (${motivo})`);
    this.name = 'FacturaNoDisponibleError';
  }
}

function noDisponible(impuestoId: string, motivo: MotivoFacturaNoDisponible): never {
  log.warn({ impuestoId, motivo }, 'extraccion: factura de venta no disponible');
  throw new FacturaNoDisponibleError(motivo);
}

/**
 * Descarga la factura de venta FLIT del trámite del impuesto. Del SISTEMA: no pasa por la frontera
 * del gestor (`buscarConAcceso`), porque el job no actúa en nombre de ningún usuario.
 */
export async function descargarFacturaDeImpuesto(impuestoId: string): Promise<{ bytes: Buffer; contentType: string }> {
  const [fila] = await db.select({ facturaId: flitoTramites.facturaVentaFlitId })
    .from(flitoImpuestos)
    .innerJoin(flitoTramites, eq(flitoImpuestos.tramiteId, flitoTramites.id))
    .where(eq(flitoImpuestos.id, impuestoId)).limit(1);
  if (!fila?.facturaId) noDisponible(impuestoId, 'sin_factura');

  const url = await getFlitAdapter().obtenerUrlFactura(fila.facturaId);
  if (!url) noDisponible(impuestoId, 'url_nula');

  const resp = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_DESCARGA_MS) }).catch(() => null);
  if (!resp) noDisponible(impuestoId, 'descarga');
  if (!resp.ok) noDisponible(impuestoId, `http_${resp.status}`);
  const declarado = Number(resp.headers.get('content-length') ?? 0);
  if (declarado > TOPE_FACTURA_BYTES) noDisponible(impuestoId, 'tope');
  const bytes = Buffer.from(await resp.arrayBuffer().catch(() => noDisponible(impuestoId, 'descarga')));
  if (bytes.length > TOPE_FACTURA_BYTES) noDisponible(impuestoId, 'tope');
  return { bytes, contentType: tipoPorBytes(bytes).contentType };
}

/**
 * Extracción de la factura ya descargada: parser si hay Notas Finales, OCR si no. Una imagen no
 * tiene capa de texto: va directo al OCR.
 */
export async function extraerDeFactura(
  factura: { bytes: Buffer; contentType: string },
): Promise<ExtraccionFacturaVentaImpuesto> {
  if (factura.contentType === 'application/pdf') {
    const texto = await textoPdf(factura.bytes, '-layout');
    const notas = parsearNotasFinales(texto);
    if (notas) {
      // La línea NO está en Notas Finales en las facturas FLIT: sale de la «Descripción» del
      // producto. Una etiqueta `Linea:` en Notas Finales, si FLIT la añade, tiene prioridad.
      if (!notas.linea.confiable) {
        const producto = descripcionProducto(await textoPdf(factura.bytes, '-raw'));
        const linea = lineaDesdeDescripcion(producto, notas.marca.confiable ? notas.marca.valor : null);
        if (linea.confiable || notas.linea.valor === null) notas.linea = linea;
      }
      return { ...extraccionCompleta(notas, parsearAdquiriente(texto)), fuente: 'notas_finales' };
    }
  }
  const ocr = await extraerVehiculoFacturaVenta({
    // Nombre genérico: el motor no lo necesita para leer y así no viaja el id de FLIT.
    nombreArchivo: 'factura-venta', contenido: factura.bytes, contentType: factura.contentType, umbral: umbralPara(null),
  });
  return { ...extraccionCompleta(ocr, ocr), fuente: 'ocr' };
}

/**
 * `logPiiAccess` exige una `Request` y el job no tiene ninguna. En el repo no existe un actor de
 * sistema para `pii_access_log` (todos los llamadores son rutas), así que se fabrica la petición
 * mínima que la cabecera de `pii-audit.ts` ya contempla («un cron que fabrica una petición»): sin
 * usuario —`user_id`/`user_role` quedan NULL, que es lo que distingue al sistema de una persona—,
 * sin IP y sin `request_id`. El motivo dice que fue el análisis automático. No se inventa usuario.
 */
export async function registrarAccesoSistema(
  impuestoId: string, camposAccedidos: string[], detalle: string,
): Promise<void> {
  const reqSistema = { headers: {}, ip: undefined } as unknown as Request;
  await logPiiAccess(reqSistema, {
    resourceTipo: RECURSO_IMPUESTO,
    resourceId: null, // uuid: no cabe en la columna integer; va en el motivo, como en flito-impuestos.pii.ts
    accion: 'read',
    camposAccedidos,
    motivo: `analisis_post_envio (sistema) — ${detalle} · impuesto ${impuestoId}`,
  });
}

const confiables = (e: ExtraccionFacturaVentaImpuesto): number =>
  [...CAMPOS_VEHICULO_FACTURA, ...CAMPOS_DIRECCION_FACTURA]
    .filter((c) => (e[c] as CampoExtraido | undefined)?.confiable).length;

/** Paso `extraccion` de la cola de la HU 12825. No consulta el RUNT. */
export const pasoExtraccion: PasoAnalisis = async ({ impuestoId }) => {
  const factura = await descargarFacturaDeImpuesto(impuestoId);
  const extraccion = await extraerDeFactura(factura);
  // Solo si sigue `en_curso`: no pisa una fila que se reseteó mientras el job corría.
  await db.update(flitoImpuestos).set({ extraccionFacturaVenta: extraccion })
    .where(and(eq(flitoImpuestos.id, impuestoId), eq(flitoImpuestos.analisisEstado, AnalisisEstadoImpuesto.EN_CURSO)));
  await registrarAccesoSistema(
    impuestoId, ['direccion', 'municipio', 'departamento', 'vin'], `extracción factura de venta · fuente=${extraccion.fuente!}`,
  );
  log.info({ impuestoId, fuente: extraccion.fuente, camposConfiables: confiables(extraccion) }, 'extraccion: factura analizada');
};
