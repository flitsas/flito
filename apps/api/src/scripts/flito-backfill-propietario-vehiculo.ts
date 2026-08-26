// FLITO — backfill del propietario del vehículo desde el comprador principal del trámite.
//
// El titular llega de FLIT en cada trámite (`cedulanit` en el reporte crudo) y siempre se guardó en
// `flito_compradores`, pero NO en `vehicles`. Varios módulos preguntan por el propietario al
// VEHÍCULO y no al trámite —la certificación contra el RUNT (HU #11165) y el refresco de SOAT—, así
// que veían la flota entera sin propietario y se bloqueaban solos. La sincronización ya lo escribe
// de aquí en adelante; este script rellena lo que entró antes.
//
//   npx tsx src/scripts/flito-backfill-propietario-vehiculo.ts            → dry-run (no escribe)
//   npx tsx src/scripts/flito-backfill-propietario-vehiculo.ts --apply    → aplica
//
// Idempotente y no destructivo: solo toca vehículos SIN documento, así que el dato que ya dejó el
// OCR de la tarjeta de propiedad o un traspaso nunca se pisa. Volver a correrlo no cambia nada.

import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { flitoCompradores, flitoTramites, vehicles } from '../db/schema.js';

const APPLY = process.argv.includes('--apply');

/** Tope de `vehicles.owner_document`. Un documento más largo se descarta en vez de recortarse: */
/* recortarlo lo convertiría en otro documento y el RUNT respondería sobre alguien que no es. */
const MAX_DOCUMENTO = 20;
const MAX_NOMBRE = 200;

interface Candidato {
  vehiculoId: number;
  nombre: string | null;
  documento: string | null;
}

async function main(): Promise<void> {
  const linea = '─'.repeat(72);
  console.log(`\n${linea}\n  Backfill propietario del vehículo (desde flito_compradores)\n${linea}`);

  // Un vehículo puede tener varios trámites y cada uno su comprador. Se toma el del trámite MÁS
  // RECIENTE: si el vehículo cambió de manos, el titular vigente es el del último trámite, no el del
  // primero que se sincronizó.
  const filas = await db
    .selectDistinctOn([flitoTramites.vehiculoId], {
      vehiculoId: flitoTramites.vehiculoId,
      nombre: flitoCompradores.nombreCompleto,
      documento: flitoCompradores.numeroDocumento,
    })
    .from(flitoTramites)
    .innerJoin(flitoCompradores, and(
      eq(flitoCompradores.tramiteId, flitoTramites.id),
      eq(flitoCompradores.orden, 0),
    ))
    .innerJoin(vehicles, eq(vehicles.id, flitoTramites.vehiculoId))
    .where(isNull(vehicles.ownerDocument))
    .orderBy(flitoTramites.vehiculoId, sql`${flitoTramites.fechaCreacionFlit} desc nulls last`, sql`${flitoTramites.createdAt} desc`);

  const candidatos: Candidato[] = [];
  let descartadosPorLargo = 0;

  for (const f of filas) {
    const documento = f.documento?.trim() || null;
    if (documento && documento.length > MAX_DOCUMENTO) { descartadosPorLargo += 1; continue; }
    if (!documento) continue;
    candidatos.push({
      vehiculoId: f.vehiculoId,
      nombre: f.nombre?.trim().slice(0, MAX_NOMBRE) || null,
      documento,
    });
  }

  const [{ n: sinDocumento }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(vehicles)
    .where(isNull(vehicles.ownerDocument));

  console.log(`  vehículos sin documento:        ${sinDocumento}`);
  console.log(`  con comprador para rellenar:    ${candidatos.length}`);
  console.log(`  descartados (documento > ${MAX_DOCUMENTO}):  ${descartadosPorLargo}`);
  console.log(`  quedarán sin documento:         ${sinDocumento - candidatos.length}`);

  if (!APPLY) {
    console.log(`\n  DRY-RUN: no se escribió nada. Corre con --apply para aplicar.\n${linea}\n`);
    process.exit(0);
  }

  // Fila a fila y no en un UPDATE ... FROM: son miles, no millones, y así el `isNull` de la guarda
  // se evalúa por vehículo aunque otro proceso escriba a la vez.
  let escritos = 0;
  for (const c of candidatos) {
    const actualizado = await db
      .update(vehicles)
      .set({
        ownerDocument: c.documento,
        // El nombre solo se pone si falta: el del RUNT o el del OCR es mejor fuente que el comprador.
        ...(c.nombre ? { ownerName: sql`coalesce(${vehicles.ownerName}, ${c.nombre})` } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(vehicles.id, c.vehiculoId), isNull(vehicles.ownerDocument)))
      .returning({ id: vehicles.id });
    escritos += actualizado.length;
  }

  const [{ n: restantes }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(vehicles)
    .where(isNull(vehicles.ownerDocument));

  console.log(`\n  APLICADO.`);
  console.log(`  vehículos actualizados:         ${escritos}`);
  console.log(`  siguen sin documento:           ${restantes}`);
  console.log(`${linea}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Backfill propietario falló:', err);
  process.exit(1);
});
