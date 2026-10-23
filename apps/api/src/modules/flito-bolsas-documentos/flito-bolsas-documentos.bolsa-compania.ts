// HU #13889 (ADR-0028 §6) — Puerto S0 con flito-df (Épica #13412): ¿la compañía tiene bolsa de compañía,
// y está activa? Este módulo NO consulta las tablas de bolsa por su cuenta en ningún otro sitio.
//
// TODO S0 #13412 — FALLBACK TEMPORAL. Leer antes de tocar:
//   (1) La función definitiva es `estadoBolsaDeCompania(companiaId)` de
//       `apps/api/src/modules/flito-bolsas/flito-bolsas.estado-compania.ts`, con ESTA MISMA firma. Llega con
//       la HU-A de la Épica #13412 y todavía no existe en develop. En cuanto la HU-A entre a develop, este
//       archivo se reduce a una línea:
//         export { estadoBolsaDeCompania } from '../flito-bolsas/flito-bolsas.estado-compania.js';
//   (2) El fallback hace `EXISTS` sobre `flito_bolsas` (la bolsa de cliente del modelo actual). Solo es
//       fiable hasta la HU-A: desde la HU-A daría falsos «sí» (bolsas autocreadas que no se migran), y desde
//       la HU-B, falsos «no». No puede sobrevivir a esas HUs.
//   (3) El modelo actual no tiene inactivación, así que el fallback devuelve siempre `activa: true`: el 409
//       por bolsa inactiva (AC8, ADR-0028 §14) solo se dispara con la función real. Los tests lo cubren
//       mockeando este módulo.
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { flitoBolsas } from '../../db/schema.js';

export interface EstadoBolsaCompania {
  existe: boolean;
  activa: boolean;
}

export async function estadoBolsaDeCompania(companiaId: number): Promise<EstadoBolsaCompania> {
  // `LIMIT 1` y no `unique`: sigue siendo un EXISTS aunque el modelo nuevo admita varias filas.
  const filas = await db.select({ id: flitoBolsas.id }).from(flitoBolsas)
    .where(eq(flitoBolsas.companiaId, companiaId)).limit(1);
  const existe = filas.length > 0;
  return { existe, activa: true };
}
