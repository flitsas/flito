// Dr. Flit — purga de los intentos de radicación a 12 meses (HU #13804, D6). La PROGRAMACIÓN vive en
// `dr-flit.cron.ts`; la política, en `docs/privacy/retencion-flito-dr-flit.md`.
//
// RN-DRF1  Retención de 12 meses desde `creado_en` (Ley 1581, art. 4 lit. d; Decreto 1377 de 2013
//          art. 11). Se BORRAN las filas de `flito_drflit_casos_soporte` con `creado_en < ahora − 12
//          meses`, en lotes acotados. NUNCA toca `flito_drflit_autorizaciones` (P9-10: su purga es
//          otra HU y exige una migración que abra una vía controlada en el trigger de solo inserción).
import { inArray, lt } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoDrflitCasosSoporte as t } from '../../db/schema/flito-drflit.js';

export const MESES_RETENCION_DRFLIT = 12;
export const LOTE_PURGA_DRFLIT = 1000;
/** Tope de lotes por corrida: el atraso de un primer encendido se drena en días, no en una corrida eterna. */
export const MAX_LOTES_PURGA_DRFLIT = 50;

export type ConexionPurga = Pick<typeof db, 'select' | 'delete'>;

/** Corte de la retención: `ahora − 12 meses` (calendario, en UTC). */
export function cortePurgaDrFlit(ahora: Date): Date {
  const c = new Date(ahora.getTime());
  c.setUTCMonth(c.getUTCMonth() - MESES_RETENCION_DRFLIT);
  return c;
}

export interface ResultadoPurgaDrFlit { borrados: number; lotes: number; corte: string }

export async function ejecutarPurgaDrFlit(opts: {
  ahora?: Date; lote?: number; maxLotes?: number; conexion?: ConexionPurga;
} = {}): Promise<ResultadoPurgaDrFlit> {
  const corte = cortePurgaDrFlit(opts.ahora ?? new Date());
  const lote = opts.lote ?? LOTE_PURGA_DRFLIT;
  const maxLotes = opts.maxLotes ?? MAX_LOTES_PURGA_DRFLIT;
  const conexion = opts.conexion ?? db;
  let borrados = 0;
  let lotes = 0;
  while (lotes < maxLotes) {
    const candidatos = conexion.select({ id: t.id }).from(t).where(lt(t.creadoEn, corte)).orderBy(t.id).limit(lote);
    const filas = await conexion.delete(t).where(inArray(t.id, candidatos)).returning({ id: t.id });
    lotes += 1;
    borrados += filas.length;
    if (filas.length < lote) break;
  }
  return { borrados, lotes, corte: corte.toISOString() };
}
