// HU #14133 (Feature #14013, ADR-0032) — descarga de las filas RECHAZADAS de un lote terminado, en formato de
// plantilla + columna final «Motivo». El Excel se arma al vuelo (no se guarda). Vida de la PII: ver
// `flito-soat-masivo-purga.ts` (RN-MASD1..3).
//
// RN-MASD4  Alcance como el avance: lote ajeno / inexistente → `null` (la ruta responde 404).
// RN-MASD5  Lote sin terminar → 409 `lote_en_proceso`. Plazo vencido o sin rechazadas → 410 `descarga_no_disponible`.
// RN-MASD6  Cada celda de texto pasa por `escaparFormula`. Nada de esto entra en logs.

import ExcelJS from 'exceljs';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoSoatMasivoFilas as F, flitoSoatMasivoLotes as L } from '../../db/schema.js';
import type { SoatCtx } from './flito-soat.service.js';
import { falloMasivo } from './flito-soat-masivo.errors.js';
import { cargarLoteEnAlcance } from './flito-soat-masivo.service.js';
import { descargaVencida, purgarPiiRechazadas } from './flito-soat-masivo-purga.js';
import { textoMotivo } from './flito-soat-masivo-motivos.js';
import { ENCABEZADOS_RENOVACION, escaparFormula } from './flito-soat-masivo-plantilla.js';

export const NOMBRE_ARCHIVO_RECHAZADAS = 'rechazadas-soat-renovacion.xlsx';

export interface DescargaRechazadas { buffer: Buffer; filas: number; loteId: string }

export async function descargarRechazadas(loteId: string, ctx: SoatCtx, ahora: Date = new Date()): Promise<DescargaRechazadas | null> {
  const lote = await cargarLoteEnAlcance(loteId, ctx);
  if (!lote) return null;
  if (lote.estado !== 'terminado') {
    throw falloMasivo(409, 'lote_en_proceso', 'La carga aún no termina. Podrás descargar las rechazadas cuando finalice.');
  }
  const NO_DISPONIBLE = falloMasivo(410, 'descarga_no_disponible', 'Las filas rechazadas de esta carga ya no están disponibles para descargar. Vuelve a subir el archivo.');
  if (descargaVencida(lote, ahora)) { await purgarPiiRechazadas(ahora, lote.id); throw NO_DISPONIBLE; }
  if ((lote.nRechazadas ?? 0) === 0) throw NO_DISPONIBLE;

  const filas = await db.select({
    placa: F.placa, documento: F.documento, nombre: F.nombre, correo: F.correo, celular: F.celular,
    motivo: F.motivoRechazo, vigenteHasta: F.vigenteHasta,
  }).from(F).where(and(eq(F.loteId, lote.id), eq(F.estado, 'rechazada'))).orderBy(asc(F.nFila));
  // Purgadas por otra vía (mantenimiento): ninguna fila conserva datos → no hay nada que entregar.
  const conDatos = filas.filter((f) => f.placa || f.documento || f.nombre || f.correo || f.celular);
  if (conDatos.length === 0) throw NO_DISPONIBLE;

  // La primera descarga abre la ventana de 15 min; las siguientes no la mueven.
  await db.update(L).set({ primeraDescargaEn: sql`coalesce(${L.primeraDescargaEn}, ${ahora.toISOString()}::timestamptz)` }).where(eq(L.id, lote.id));

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Rechazadas');
  ws.addRow([...ENCABEZADOS_RENOVACION, 'Motivo']);
  ws.getRow(1).font = { bold: true };
  for (let i = 1; i <= ENCABEZADOS_RENOVACION.length + 1; i++) { const c = ws.getColumn(i); c.numFmt = '@'; c.width = i === 6 ? 60 : 22; }
  for (const f of conDatos) {
    ws.addRow([f.placa, f.documento, f.nombre, f.correo, f.celular, f.motivo ? textoMotivo(f.motivo, f.vigenteHasta) : '']
      .map((v) => escaparFormula(v ?? '')));
  }
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), filas: conDatos.length, loteId: lote.id };
}
