// Certificación de impuesto sin trámite — ZIP de certificados RUNT con listado de omitidos (HU
// #14665, AC8). Mismo contrato que `certificados-zip.ts` (planificar PURO → 409 si nadie entra →
// generar TODOS los PDF a Buffer → registro PII → cabeceras + archiver): se reutiliza de allí
// `emitirZipCertificados` tal cual —el ZIP en sí no cambia, solo cambia QUÉ se empaqueta—, pero NO
// `planificarZipCertificados`, que decide con `CertificacionLoteItem` (la cola CON trámite). Aquí se
// decide con las filas de `flito_impuesto_certificacion_directa`, ya cargadas por quien llama
// (`filasCertificacionDirectaPorIds` + `organismosAliasPorCodigos`): este módulo no hace I/O.
//
// Sin placa (opcional desde esta HU): se nombra por el VIN. Solo entran filas `estado ===
// 'certificado'` con snapshot congelado; las demás, omitidas con
// `CausaCertificadoOmitido.SIN_CERTIFICACION_VIGENTE` (no hay «no disponible»: a diferencia del ZIP
// con trámite, aquí no hay un permiso que recorte el lote antes de llegar — el que pide el id es
// quien ya lo ve en la lista).

import { setImmediate as ceder } from 'node:timers/promises';
import { CausaCertificadoOmitido, type CertificadoOmitido } from '@operaciones/shared-types';
import { desempatador } from '../../shared/soportes/soportes-zip.js';
import { construirCertificadoDirectoPdf, type CertificadoDirectoPdfDatos } from './certificado-directo-pdf.js';
import type { PdfCertificado } from './certificados-zip.js';
import type { Fila } from './flito-impuestos.certificacion-directa.service.js';

export interface CertificadoDirectoZipIncluido {
  id: string;
  /** Nombre de la entrada, ya desempatado y con `.pdf`. */
  nombre: string;
  datos: Omit<CertificadoDirectoPdfDatos, 'generadoPor' | 'generadoEn'>;
}

export interface PlanZipCertificacionDirecta {
  incluidos: CertificadoDirectoZipIncluido[];
  omitidos: CertificadoOmitido[];
}

/** Base del nombre de archivo: la placa si hay, el VIN si no (AC8). Sin separadores. */
function baseArchivo(placa: string | null, vin: string): string {
  return (placa || vin).replace(/[^A-Za-z0-9]/g, '') || 'SIN-IDENTIFICAR';
}

/**
 * Decide qué filas entran al ZIP y cómo se llaman. Puro: recibe las filas YA CARGADAS y el alias de
 * organismo YA RESUELTO; no consulta nada.
 *
 * `idsPedidos` manda el orden y el desempate (mismo criterio que `planificarZipCertificados`): el
 * mismo lote da siempre los mismos nombres.
 */
export function planificarZipCertificacionDirecta(
  idsPedidos: readonly string[], filas: readonly Fila[], organismos: ReadonlyMap<string, string>,
): PlanZipCertificacionDirecta {
  const nombrar = desempatador();
  const incluidos: CertificadoDirectoZipIncluido[] = [];
  const omitidos: CertificadoOmitido[] = [];
  const porId = new Map(filas.map((f) => [f.id, f]));

  for (const id of [...new Set(idsPedidos)]) {
    const fila = porId.get(id);
    if (!fila || fila.estado !== 'certificado' || !fila.snapshot || !fila.certificadoEn) {
      omitidos.push({ identificador: id, causa: CausaCertificadoOmitido.SIN_CERTIFICACION_VIGENTE });
      continue;
    }
    incluidos.push({
      id,
      nombre: `${nombrar(baseArchivo(fila.placa, fila.vin))}.pdf`,
      datos: {
        placa: fila.placa,
        vin: fila.vin,
        documento: fila.documentoPropietario,
        nombrePropietario: fila.nombrePropietario,
        // Del snapshot congelado, no de la fila: un certificado anterior a la HU #14665 tiene
        // documento y se consultó por placa+documento.
        modalidadConsulta: fila.snapshot.modalidadConsulta ?? 'vin',
        organismo: organismos.get(fila.organismoCodigo) ?? fila.organismoCodigo,
        campos: fila.snapshot.campos,
        registroRunt: fila.snapshot.registroRunt,
        certificadoPorNombre: fila.certificadoPorNombre ?? 'FLITO',
        certificadoEn: fila.certificadoEn,
      },
    });
  }

  return { incluidos, omitidos };
}

/**
 * Genera los PDF, uno tras otro, TODOS antes del primer byte (D2, igual que
 * `generarPdfsCertificados`). Se cede el event loop entre PDF: pdf-lib es CPU en el hilo principal.
 */
export async function generarPdfsCertificacionDirecta(
  incluidos: readonly CertificadoDirectoZipIncluido[], generadoPor: string, generadoEn: Date = new Date(),
): Promise<PdfCertificado[]> {
  const pdfs: PdfCertificado[] = [];
  for (const { nombre, datos } of incluidos) {
    const pdf = await construirCertificadoDirectoPdf({ ...datos, generadoPor, generadoEn });
    pdfs.push({ nombre, pdf });
    await ceder();
  }
  return pdfs;
}
