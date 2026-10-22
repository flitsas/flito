// FLITO Impuestos — ZIP de certificados RUNT con listado de omitidos (HU #13205).
//
// Módulo propio y no una variante de `shared/soportes/soportes-zip.ts`: aquel está atado a entradas
// que se abren en streaming desde MinIO/FLIT; aquí son PDF que se GENERAN en memoria (pdf-lib) y un
// CSV. Se reutiliza de allí solo lo que no puede divergir: el nombre por placa, el desempate `-2`/`-3`
// y el sello del nombre del archivo en hora de Colombia.
//
// ── El orden es el contrato (AC8) ────────────────────────────────────────────────────────────────
//
//   1. planificar (puro): quién entra, cómo se llama, quién queda fuera y por qué
//   2. si no entra nadie → 409 con los omitidos, sin ZIP (AC3)
//   3. generar TODOS los PDF a Buffer (si uno lanza, no se emitió nada: 500 limpio)
//   4. registro PII + bitácora — con `filas = incluidos`, que ya es un hecho
//   5. recién entonces cabeceras y `archiver`
//
// Sin RUNT, sin `flito_soportes`, sin S3 y sin disco (AC4): nada de esto se guarda.

import archiver from 'archiver';
import { setImmediate as ceder } from 'node:timers/promises';
import type { Response } from 'express';
import {
  CABECERA_CERTIFICADOS_OMITIDOS, CausaCertificadoOmitido, CODIGO_ZIP_SIN_CERTIFICADOS,
  type CertificadoOmitido,
} from '@operaciones/shared-types';
import { desempatador, nombreArchivoZipSoportes, nombrePorPlaca, ZipError } from '../../shared/soportes/soportes-zip.js';
import type { CertificacionConRegistro, CertificacionLoteItem } from './certificacion.service.js';
import { construirCertificadoPdf } from './certificado-pdf.js';

/** Texto de cada causa en `omitidos.csv` (el JSON del 409 lleva el código, la pantalla traduce). */
export const CAUSA_TEXTO: Record<CausaCertificadoOmitido, string> = {
  [CausaCertificadoOmitido.SIN_CERTIFICACION_VIGENTE]: 'sin certificación vigente',
  [CausaCertificadoOmitido.NO_DISPONIBLE]: 'no disponible',
};

/** Todos los ids pedidos quedaron fuera (AC3). 409 con la lista; ningún ZIP. */
export class ZipSinCertificadosError extends ZipError {
  readonly codigo = CODIGO_ZIP_SIN_CERTIFICADOS;
  readonly status = 409;

  constructor(readonly omitidos: CertificadoOmitido[]) {
    super('Ninguno de los registros seleccionados tiene un certificado RUNT vigente que descargar.');
    this.name = 'ZipSinCertificadosError';
  }
}

export interface CertificadoIncluido {
  impuestoId: string;
  /** Nombre de la entrada, ya desempatado y con `.pdf`. */
  nombre: string;
  cert: CertificacionConRegistro;
}

export interface PlanZipCertificados {
  incluidos: CertificadoIncluido[];
  omitidos: CertificadoOmitido[];
}

/**
 * Decide qué entra y cómo se llama. Puro.
 *
 * `autorizados` llega en ORDEN DE SERVIDOR (`createdAt, id`): el desempate depende de ese orden y no
 * del de la petición, así que el mismo lote da siempre los mismos nombres.
 *
 * Sin placa NO se omite (AC1, decisión 2026-09-30): se nombra `SIN-PLACA-<idFlit>`. Una placa
 * normalizada nunca lleva `-`, así que no colisiona con una real.
 *
 * «No disponible» = pedido y no devuelto por la frontera. Se identifica con el uuid ENVIADO: la placa
 * o el id FLIT de algo fuera del alcance convertirían el CSV en un oráculo de pertenencia (Ley 1581).
 */
export function planificarZipCertificados(idsPedidos: readonly string[], autorizados: readonly CertificacionLoteItem[]): PlanZipCertificados {
  const nombrar = desempatador();
  const incluidos: CertificadoIncluido[] = [];
  const omitidos: CertificadoOmitido[] = [];
  const devueltos = new Set<string>();

  for (const a of autorizados) {
    devueltos.add(a.impuestoId);
    const base = nombrePorPlaca(a.placa);
    const conPlaca = base !== 'SIN-PLACA';
    if (!a.cert) {
      omitidos.push({
        identificador: conPlaca ? base : a.idFlit,
        causa: CausaCertificadoOmitido.SIN_CERTIFICACION_VIGENTE,
      });
      continue;
    }
    const raiz = conPlaca ? base : `SIN-PLACA-${idFlitSeguro(a.idFlit)}`;
    incluidos.push({ impuestoId: a.impuestoId, nombre: `${nombrar(raiz)}.pdf`, cert: a.cert });
  }

  const noDisponibles = [...new Set(idsPedidos)].filter((id) => !devueltos.has(id)).sort();
  for (const id of noDisponibles) omitidos.push({ identificador: id, causa: CausaCertificadoOmitido.NO_DISPONIBLE });

  return { incluidos, omitidos };
}

/** El id FLIT va a un nombre de fichero: nada de `/`, `..` ni espacios. */
function idFlitSeguro(idFlit: string): string {
  return idFlit.replace(/[^A-Za-z0-9_-]/g, '') || 'X';
}

const BOM = '﻿';
const SEP = ';';
const EOL = '\r\n';

/** Una celda CSV: anti inyección de fórmulas (OWASP) + escape RFC 4180. */
function celda(valor: string): string {
  const v = /^[=+\-@\t\r]/.test(valor) ? `'${valor}` : valor;
  return /[;"\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** `omitidos.csv`: UTF-8 con BOM (Excel es-CO), separador `;`, fin de línea `\r\n`. Puro. */
export function csvOmitidos(omitidos: readonly CertificadoOmitido[]): Buffer {
  const lineas = ['Identificador;Causa', ...omitidos.map((o) => [celda(o.identificador), celda(CAUSA_TEXTO[o.causa])].join(SEP))];
  return Buffer.from(BOM + lineas.join(EOL) + EOL, 'utf8');
}

export interface PdfCertificado {
  nombre: string;
  pdf: Buffer;
}

/**
 * Genera los PDF, uno tras otro, TODOS antes del primer byte (D2). pdf-lib es CPU en el hilo
 * principal: paralelizar no gana nada y sube el pico de heap; se cede el event loop entre PDF.
 */
export async function generarPdfsCertificados(
  incluidos: readonly CertificadoIncluido[], generadoPor: string, generadoEn: Date = new Date(),
): Promise<PdfCertificado[]> {
  const pdfs: PdfCertificado[] = [];
  for (const { nombre, cert } of incluidos) {
    const pdf = await construirCertificadoPdf({
      placaConsultada: cert.placaConsultada,
      documentoConsultado: cert.documentoConsultado,
      vinConsultado: cert.vinConsultado,
      tipoDocPropietario: cert.tipoDocPropietario,
      propietarioNombre: cert.propietarioNombre,
      campos: cert.campos,
      certificadoPorNombre: cert.certificadoPorNombre,
      certificadoEn: new Date(cert.createdAt),
      registroRunt: cert.registroRunt,
      generadoPor,
      generadoEn,
    });
    pdfs.push({ nombre, pdf });
    await ceder();
  }
  return pdfs;
}

/**
 * Escribe cabeceras y el ZIP. Solo se llama con el registro PII ya hecho. Sin compresión
 * (`level: 0`): los PDF ya van comprimidos y comprimir otra vez solo gasta CPU.
 */
export async function emitirZipCertificados(
  res: Response, pdfs: readonly PdfCertificado[], omitidos: readonly CertificadoOmitido[], ahora: Date = new Date(),
): Promise<void> {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${nombreArchivoZipSoportes(ahora, 'certificados-runt')}"`);
  res.setHeader(CABECERA_CERTIFICADOS_OMITIDOS, String(omitidos.length));

  const archive = archiver('zip', { zlib: { level: 0 } });
  const terminado = new Promise<void>((resolve, reject) => {
    archive.on('error', reject);
    res.on('finish', resolve);
    res.on('close', resolve);
  });
  archive.pipe(res);
  for (const { nombre, pdf } of pdfs) archive.append(pdf, { name: nombre });
  if (omitidos.length > 0) archive.append(csvOmitidos(omitidos), { name: 'omitidos.csv' });
  await archive.finalize();
  await terminado;
}
