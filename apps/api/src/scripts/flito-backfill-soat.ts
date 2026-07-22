// FLITO — backfill de datos: soat_requests (legacy) → flito_soat (D-4, §12.1).
//
// Migra el SOAT histórico al modelo anclado a VIN (RN-01), SIN tocar soat_requests
// (shadow-run: el módulo legacy sigue vivo). Idempotente: no pisa los flito_soat que la
// sincronización ya creó (dedup por VIN). Corre en DRY-RUN por defecto.
//
//   npx tsx src/scripts/flito-backfill-soat.ts            → dry-run (no escribe)
//   npx tsx src/scripts/flito-backfill-soat.ts --apply    → aplica
//
// Traducción de estados: pendiente→pendiente, enviado→en_adquisicion,
// comprado/verificado→pagado, rechazado→rechazado.

import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  clients, flitoSoat, organismosTransitoConfig, soatRequests, tramitesDigitales, vehicles,
} from '../db/schema.js';
import { EstadoSoat } from '@operaciones/shared-types';

const APPLY = process.argv.includes('--apply');

type FlitoEstado = 'pendiente' | 'en_adquisicion' | 'pagado' | 'rechazado';

function traducirEstado(legacy: string): FlitoEstado {
  switch (legacy) {
    case 'enviado': return EstadoSoat.EN_ADQUISICION;
    case 'comprado':
    case 'verificado': return EstadoSoat.PAGADO;
    case 'rechazado': return EstadoSoat.RECHAZADO;
    default: return EstadoSoat.PENDIENTE; // 'pendiente'
  }
}

// Precedencia para dedup por vehículo: el SOAT más avanzado gana (refleja la realidad del VIN).
const RANK: Record<FlitoEstado, number> = { pagado: 4, en_adquisicion: 3, pendiente: 2, rechazado: 1 };

interface Fila {
  srId: number;
  status: string;
  vehicleId: number;
  updatedAt: Date;
  purchaseDate: string | null;
  assignedTo: number | null;
  notes: string | null;
  vin: string | null;
  clientId: number | null;
  organismoCodigo: string | null;
}

async function main(): Promise<void> {
  const filas = (await db
    .select({
      srId: soatRequests.id,
      status: soatRequests.status,
      vehicleId: soatRequests.vehicleId,
      updatedAt: soatRequests.updatedAt,
      purchaseDate: soatRequests.purchaseDate,
      assignedTo: soatRequests.assignedTo,
      notes: soatRequests.notes,
      vin: vehicles.vin,
      clientId: vehicles.clientId,
      organismoCodigo: tramitesDigitales.organismoCodigo,
    })
    .from(soatRequests)
    .innerJoin(vehicles, eq(soatRequests.vehicleId, vehicles.id))
    .leftJoin(tramitesDigitales, eq(soatRequests.tramiteId, tramitesDigitales.id))) as Fila[];

  // Agrupar por vehículo (RN-01: un flito_soat por VIN). Gana el estado más avanzado; para el
  // organismo, se prefiere el del ganador y si falta, cualquier hermano con organismo.
  const porVehiculo = new Map<number, Fila[]>();
  for (const f of filas) {
    const arr = porVehiculo.get(f.vehicleId) ?? [];
    arr.push(f); porVehiculo.set(f.vehicleId, arr);
  }

  // Catálogos para validar FKs y dedup contra lo ya sembrado por sync.
  const organismosValidos = new Set((await db.select({ c: organismosTransitoConfig.codigo }).from(organismosTransitoConfig)).map((o) => o.c));
  const vinsExistentes = new Set((await db.select({ v: flitoSoat.vin }).from(flitoSoat)).map((r) => r.v));
  const clientesValidos = new Set((await db.select({ id: clients.id }).from(clients)).map((c) => c.id));

  const aInsertar: (typeof flitoSoat.$inferInsert)[] = [];
  const porEstado: Record<FlitoEstado, number> = { pendiente: 0, en_adquisicion: 0, pagado: 0, rechazado: 0 };
  const omitidos = { sinVin: 0, sinCompania: 0, companiaInexistente: 0, sinOrganismo: 0, organismoInexistente: 0, vinYaEnFlito: 0 };
  const ejemplosOmitidos: string[] = [];
  const omitir = (motivo: keyof typeof omitidos, detalle: string) => {
    omitidos[motivo] += 1;
    if (ejemplosOmitidos.length < 15) ejemplosOmitidos.push(`[${motivo}] ${detalle}`);
  };

  for (const [vehicleId, grupo] of porVehiculo) {
    const ganador = [...grupo].sort((a, b) => {
      const r = RANK[traducirEstado(b.status)] - RANK[traducirEstado(a.status)];
      return r !== 0 ? r : b.updatedAt.getTime() - a.updatedAt.getTime();
    })[0];
    const estado = traducirEstado(ganador.status);

    if (!ganador.vin) { omitir('sinVin', `vehículo ${vehicleId}`); continue; }
    if (vinsExistentes.has(ganador.vin)) { omitir('vinYaEnFlito', `VIN ${ganador.vin} (creado por sync)`); continue; }
    if (ganador.clientId === null) { omitir('sinCompania', `VIN ${ganador.vin}`); continue; }
    if (!clientesValidos.has(ganador.clientId)) { omitir('companiaInexistente', `VIN ${ganador.vin}, client ${ganador.clientId}`); continue; }

    const organismoCodigo = ganador.organismoCodigo ?? grupo.map((f) => f.organismoCodigo).find(Boolean) ?? null;
    if (!organismoCodigo) { omitir('sinOrganismo', `VIN ${ganador.vin}`); continue; }
    if (!organismosValidos.has(organismoCodigo)) { omitir('organismoInexistente', `VIN ${ganador.vin}, org ${organismoCodigo}`); continue; }

    const noPendiente = estado !== EstadoSoat.PENDIENTE;
    aInsertar.push({
      vin: ganador.vin,
      vehiculoId: vehicleId,
      estado,
      companiaId: ganador.clientId,
      organismoCodigo,
      proveedorSoatId: null,
      proveedorSobrescrito: false,
      enviadoPorId: noPendiente ? ganador.assignedTo : null,
      enviadoEn: noPendiente ? ganador.updatedAt : null,
      pagadoEn: estado === EstadoSoat.PAGADO ? (ganador.purchaseDate ? new Date(ganador.purchaseDate) : ganador.updatedAt) : null,
      valorPagado: null, // el legacy no guarda el valor cobrado; queda para reconciliación
      motivoRechazo: estado === EstadoSoat.RECHAZADO ? (ganador.notes ?? 'Rechazado (migrado del modelo legacy)') : null,
    });
    porEstado[estado] += 1;
    vinsExistentes.add(ganador.vin); // evita colisión si el mismo VIN aparece dos veces
  }

  // ── Reporte ──
  const linea = '─'.repeat(72);
  console.log(`\n${linea}\n  BACKFILL soat_requests → flito_soat  ${APPLY ? '(APLICAR)' : '(DRY-RUN)'}\n${linea}`);
  console.log(`  soat_requests leídos:     ${filas.length}`);
  console.log(`  vehículos distintos:      ${porVehiculo.size}`);
  console.log(`  a insertar (dedup VIN):   ${aInsertar.length}`);
  console.log(`    · pendiente:        ${porEstado.pendiente}`);
  console.log(`    · en_adquisicion:   ${porEstado.en_adquisicion}`);
  console.log(`    · pagado:           ${porEstado.pagado}`);
  console.log(`    · rechazado:        ${porEstado.rechazado}`);
  console.log(`  omitidos:                 ${Object.values(omitidos).reduce((a, b) => a + b, 0)}`);
  for (const [k, v] of Object.entries(omitidos)) if (v) console.log(`    · ${k}: ${v}`);
  if (ejemplosOmitidos.length) { console.log('  ejemplos de omitidos:'); ejemplosOmitidos.forEach((e) => console.log(`    ${e}`)); }

  if (!APPLY) {
    console.log(`\n  DRY-RUN: no se escribió nada. Revisa el reporte y corre con --apply para aplicar.\n${linea}\n`);
    process.exit(0);
  }

  // ── Aplicar + verificar ──
  const antes = (await db.select({ v: flitoSoat.vin }).from(flitoSoat)).length;
  if (aInsertar.length > 0) {
    // por lotes para no exceder límites de parámetros
    for (let i = 0; i < aInsertar.length; i += 500) {
      await db.insert(flitoSoat).values(aInsertar.slice(i, i + 500));
    }
  }
  const despues = await db.select({ v: flitoSoat.vin }).from(flitoSoat);
  const vinsUnicos = new Set(despues.map((r) => r.v));
  const duplicados = despues.length - vinsUnicos.size;

  console.log(`\n  APLICADO.`);
  console.log(`  flito_soat: ${antes} → ${despues.length} (+${despues.length - antes})`);
  console.log(`  VIN duplicados en flito_soat: ${duplicados} ${duplicados === 0 ? '✓' : '✗ (RN-01 violada!)'}`);
  if (duplicados !== 0) { console.error('  ¡ABORTAR revisión! Hay VIN duplicados.'); process.exit(1); }
  console.log(`${linea}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Backfill SOAT falló:', err);
  process.exit(1);
});
