// FLITO — backfill del histórico de las bolsas (HU #11163, Feature #11120).
//
// El módulo de bolsas (migración 0116) enganchó el descuento al SELLADO de la liquidación, así que
// solo ve lo que se liquida a partir de ahí. Todo lo sellado antes —`flito_liquidaciones` nació en la
// 0111— tiene sus valores congelados pero ni una línea en el libro. Este script cierra ese hueco, y
// de paso los dos que abrieron sus HUs hermanas:
//
//   1. Salidas de clientes de las liquidaciones anteriores al módulo (AC1).
//   2. La línea de GMF que falta en las liquidaciones selladas antes de la HU #11160 (AC2).
//   3. El consumo histórico de los organismos que llevan bolsa (AC3).
//
// NETO CERO en la bolsa del cliente. Por cada compañía se asienta una ENTRADA DE APERTURA igual al
// total de lo que se le va a cargar, de modo que el extracto pasa a explicar el histórico entero
// pero el saldo actual no se mueve ni un peso. Cargar el histórico sin compensarlo dejaría a medio
// mundo en rojo por dinero que ya se cobró por fuera del módulo.
//
// Lo que de verdad justifica correrlo es la SIEMBRA DE LLAVES (AC4): mientras el SOAT de un vehículo
// no tenga su llave `soat:{id}` en el libro, el próximo trámite de ese mismo VIN lo volverá a
// descontar, contra la RN-01. Eso no es un hueco de reporte, es un doble cobro real.
//
//   npx tsx src/scripts/flito-backfill-bolsas.ts                    → simulación (no escribe)
//   npx tsx src/scripts/flito-backfill-bolsas.ts --apply            → aplica
//   npx tsx src/scripts/flito-backfill-bolsas.ts --corte=2026-07-31 → hasta esa fecha inclusive
//
// ADVERTENCIA OPERATIVA. `asentarMovimiento` calcula el `saldo_resultante` sobre el saldo VIGENTE, no
// sobre la fecha del movimiento. Insertar histórico cuando ya hay actividad nueva asentada deja la
// columna sin sentido cronológico —el extracto se audita línea a línea con ella— aunque el saldo
// final sea correcto. Por eso: ventana de mantenimiento, y cuanto antes mejor.

import { eq, inArray, lte } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  flitoBolsaMovimientos, flitoDerechosTramite, flitoImpuestos, flitoLiquidaciones, flitoSoat,
  flitoTramites, organismosTransitoConfig,
} from '../db/schema.js';
import {
  asentarMovimiento, periodoEstaCerrado, periodoDeFecha, redondear, registrarSalidasLiquidacion,
} from '../modules/flito-bolsas/flito-bolsas.service.js';
import { registrarConsumoDerecho } from '../modules/flito-bolsas/flito-organismo-bolsas.service.js';
import {
  type CalculoLiquidacion, type IdentificadoresTramite, salidasDe, TASA_GMF,
} from '../modules/flito-liquidacion/flito-liquidacion.service.js';

const APPLY = process.argv.includes('--apply');
const CORTE = process.argv.find((a) => a.startsWith('--corte='))?.split('=')[1]
  ?? new Date().toISOString().slice(0, 10);

/** Quién queda como autor de cada asiento. No es una persona: fue una migración. */
const CTX = { userId: null, nombre: 'backfill:bolsas' };

const PREFIJO_SALIDA = 'salida:';
const PREFIJO_CONSUMO = 'consumo:';

const num = (v: string | null): number | null => (v === null ? null : Number(v));
const pesos = (n: number): string => n.toLocaleString('es-CO', { maximumFractionDigits: 0 });

/**
 * Reconstruye la forma que espera `salidasDe` desde los valores YA SELLADOS de la liquidación.
 *
 * Se usa la función real y no una copia de sus reglas porque lo que importa es que las LLAVES salgan
 * idénticas a las que produciría un sellado: es lo único que hace que el libro deduplique solo y que
 * el SOAT ya cobrado no se vuelva a cobrar. Los VALORES, en cambio, salen de la fila sellada y no de
 * un recálculo: la tarifa de hace un año no tiene por qué ser la de hoy.
 */
function calculoSellado(fila: FilaLiquidacion): CalculoLiquidacion {
  const concepto = (v: string | null) => ({ valor: num(v), origen: 'Valor sellado', bloquea: false });
  return {
    tramiteId: fila.tramiteId,
    idFlit: fila.idFlit ?? '',
    soat: concepto(fila.valorSoat),
    impuesto: concepto(fila.valorImpuesto),
    derecho: concepto(fila.valorDerecho),
    tramiteDigital: concepto(fila.valorTramiteDigital),
    logistica: concepto(fila.valorLogistica),
    baseGmf: Number(fila.baseGmf),
    tasaGmf: Number(fila.tasaGmf ?? TASA_GMF),
    valorGmf: Number(fila.valorGmf),
    total: Number(fila.total),
    faltantes: [],
  };
}

interface FilaLiquidacion {
  tramiteId: string;
  idFlit: string | null;
  companiaId: number | null;
  liquidadoEn: Date;
  valorSoat: string | null;
  valorImpuesto: string | null;
  valorDerecho: string | null;
  valorTramiteDigital: string | null;
  valorLogistica: string | null;
  baseGmf: string;
  tasaGmf: string;
  valorGmf: string;
  total: string;
  soatId: string | null;
  soatOrganismo: string | null;
  impuestoId: string | null;
  impuestoOrganismo: string | null;
  derechoId: string | null;
  derechoOrganismo: string | null;
}

/** Todo lo sellado hasta el corte, con lo que la bolsa necesita para imputar cada salida. */
async function liquidacionesHasta(corte: string): Promise<FilaLiquidacion[]> {
  return db.select({
    tramiteId: flitoLiquidaciones.tramiteId,
    idFlit: flitoTramites.idFlit,
    companiaId: flitoTramites.companiaId,
    liquidadoEn: flitoLiquidaciones.liquidadoEn,
    valorSoat: flitoLiquidaciones.valorSoat,
    valorImpuesto: flitoLiquidaciones.valorImpuesto,
    valorDerecho: flitoLiquidaciones.valorDerecho,
    valorTramiteDigital: flitoLiquidaciones.valorTramiteDigital,
    valorLogistica: flitoLiquidaciones.valorLogistica,
    baseGmf: flitoLiquidaciones.baseGmf,
    tasaGmf: flitoLiquidaciones.tasaGmf,
    valorGmf: flitoLiquidaciones.valorGmf,
    total: flitoLiquidaciones.total,
    soatId: flitoSoat.id,
    soatOrganismo: flitoSoat.organismoCodigo,
    impuestoId: flitoImpuestos.id,
    impuestoOrganismo: flitoImpuestos.organismoCodigo,
    derechoId: flitoDerechosTramite.id,
    derechoOrganismo: flitoDerechosTramite.organismoCodigo,
  }).from(flitoLiquidaciones)
    .innerJoin(flitoTramites, eq(flitoLiquidaciones.tramiteId, flitoTramites.id))
    .leftJoin(flitoSoat, eq(flitoTramites.soatId, flitoSoat.id))
    .leftJoin(flitoImpuestos, eq(flitoImpuestos.tramiteId, flitoTramites.id))
    .leftJoin(flitoDerechosTramite, eq(flitoDerechosTramite.tramiteId, flitoTramites.id))
    .where(lte(flitoLiquidaciones.liquidadoEn, new Date(`${corte}T23:59:59.999Z`)))
    .orderBy(flitoLiquidaciones.liquidadoEn) as Promise<FilaLiquidacion[]>;
}

/** Llaves ya presentes en el libro del cliente, para no contar dos veces en la simulación. */
async function llavesExistentes(llaves: string[]): Promise<Set<string>> {
  if (llaves.length === 0) return new Set();
  const filas: Array<{ llave: string | null }> = [];
  // En lotes: `IN` con decenas de miles de parámetros revienta el driver.
  for (let i = 0; i < llaves.length; i += 500) {
    filas.push(...await db
      .select({ llave: flitoBolsaMovimientos.llaveIdempotencia })
      .from(flitoBolsaMovimientos)
      .where(inArray(flitoBolsaMovimientos.llaveIdempotencia, llaves.slice(i, i + 500))));
  }
  return new Set(filas.map((f) => f.llave).filter((l): l is string => l !== null));
}

/** Organismos marcados para llevar bolsa: solo esos reciben consumo histórico (AC3). */
async function organismosConBolsa(): Promise<Set<string>> {
  const filas = await db
    .select({ codigo: organismosTransitoConfig.codigo })
    .from(organismosTransitoConfig)
    .where(eq(organismosTransitoConfig.flitoLlevaBolsa, true));
  return new Set(filas.map((f) => f.codigo));
}

interface PlanCliente {
  companiaId: number;
  /** Liquidaciones con al menos un concepto por asentar, en orden cronológico. */
  liquidaciones: Array<{ fila: FilaLiquidacion; fecha: string; conceptos: ReturnType<typeof salidasDe> }>;
  total: number;
}

interface Reporte {
  sinCompania: string[];
  periodosCerrados: Array<{ companiaId: number; periodo: string; tramiteId: string }>;
  porCliente: PlanCliente[];
  porOrganismo: Map<string, { movimientos: number; total: number }>;
}

/**
 * Calcula qué se asentaría, sin escribir nada. Es lo que imprime la simulación (AC5) y lo que
 * consume `aplicar`, de modo que lo que el reporte promete y lo que se escribe salen del mismo sitio.
 *
 * Exportada para poder probarla: el resto del archivo es orquestación de CLI.
 */
export async function planificar(): Promise<Reporte> {
  const filas = await liquidacionesHasta(CORTE);
  const conBolsa = await organismosConBolsa();

  // Se resuelven de una vez todas las llaves candidatas: preguntar por cada una sería una consulta
  // por concepto y por trámite.
  const candidatas: string[] = [];
  for (const f of filas) {
    if (f.companiaId === null) continue;
    for (const c of salidasDe(calculoSellado(f), f as IdentificadoresTramite)) {
      candidatas.push(`${PREFIJO_SALIDA}${c.llave}`);
    }
    if (f.derechoOrganismo !== null && conBolsa.has(f.derechoOrganismo)) {
      candidatas.push(`${PREFIJO_CONSUMO}tramite:${f.tramiteId}:derecho`);
    }
  }
  const yaAsentadas = await llavesExistentes(candidatas);

  const reporte: Reporte = {
    sinCompania: [],
    periodosCerrados: [],
    porCliente: [],
    porOrganismo: new Map(),
  };
  const porCliente = new Map<number, PlanCliente>();

  for (const f of filas) {
    const fecha = f.liquidadoEn.toISOString().slice(0, 10);
    const periodo = periodoDeFecha(fecha);

    // AC7: sin compañía no hay bolsa a la que cargar. Se lista, no se inventa un cliente.
    if (f.companiaId === null) {
      reporte.sinCompania.push(f.idFlit ?? f.tramiteId);
    } else {
      const pendientes = salidasDe(calculoSellado(f), f as IdentificadoresTramite)
        .filter((c) => !yaAsentadas.has(`${PREFIJO_SALIDA}${c.llave}`));

      if (pendientes.length > 0) {
        // AC8: un periodo cerrado está congelado. Meterle movimientos invalidaría un reporte ya
        // sellado, así que se deja fuera y se reporta para que Financiera decida.
        if (await periodoEstaCerrado(db, f.companiaId, periodo)) {
          reporte.periodosCerrados.push({
            companiaId: f.companiaId, periodo, tramiteId: f.idFlit ?? f.tramiteId,
          });
        } else {
          const plan = porCliente.get(f.companiaId) ?? {
            companiaId: f.companiaId, liquidaciones: [], total: 0,
          };
          plan.liquidaciones.push({ fila: f, fecha, conceptos: pendientes });
          plan.total = redondear(plan.total + pendientes.reduce((a, c) => a + c.valor, 0));
          porCliente.set(f.companiaId, plan);
        }
      }
    }

    // AC3: el consumo del organismo es independiente del cliente — el derecho se cobra siempre, así
    // que la secretaría gastó su saldo aunque el trámite no hubiera cruzado con una compañía.
    const valorDerecho = num(f.valorDerecho);
    if (
      f.derechoOrganismo !== null && conBolsa.has(f.derechoOrganismo)
      && valorDerecho !== null && valorDerecho > 0
      && !yaAsentadas.has(`${PREFIJO_CONSUMO}tramite:${f.tramiteId}:derecho`)
    ) {
      const acc = reporte.porOrganismo.get(f.derechoOrganismo) ?? { movimientos: 0, total: 0 };
      acc.movimientos += 1;
      acc.total = redondear(acc.total + valorDerecho);
      reporte.porOrganismo.set(f.derechoOrganismo, acc);
    }
  }

  reporte.porCliente = [...porCliente.values()];
  return reporte;
}

/** Llave de la entrada de apertura. Una por compañía: reejecutar no acredita dos veces (AC6). */
function llaveApertura(companiaId: number): string {
  return `apertura:backfill:${companiaId}`;
}

async function aplicar(reporte: Reporte): Promise<void> {
  for (const plan of reporte.porCliente) {
    await db.transaction(async (tx) => {
      // La apertura va PRIMERO para que el saldo no baje a un negativo transitorio que la última
      // línea desharía: el extracto se lee de arriba abajo y esa caída no significaría nada.
      //
      // Se imputa al periodo del movimiento más antiguo, para que el mes que recibe el cargo reciba
      // también su compensación y ninguno quede descuadrado por su cuenta.
      const primeraFecha = plan.liquidaciones[0].fecha;
      await asentarMovimiento(tx, plan.companiaId, {
        tipo: 'entrada',
        origen: 'manual',
        valor: plan.total,
        fecha: primeraFecha,
        observacion: 'Apertura del backfill de bolsas (HU #11163): compensa el histórico cargado por '
          + 'este mismo proceso, para que el extracto lo explique sin mover el saldo actual',
        llaveIdempotencia: llaveApertura(plan.companiaId),
        etiqueta: 'apertura',
      }, CTX);

      for (const { fila, fecha, conceptos } of plan.liquidaciones) {
        await registrarSalidasLiquidacion(tx, {
          companiaId: plan.companiaId,
          tramiteId: fila.tramiteId,
          fecha,
          conceptos,
        }, CTX);
      }
    });
  }

  // El consumo del organismo va en su propia transacción por trámite: son libros distintos y no hay
  // razón para que un fallo en uno tumbe el otro.
  const filas = await liquidacionesHasta(CORTE);
  const conBolsa = await organismosConBolsa();
  for (const f of filas) {
    const valorDerecho = num(f.valorDerecho);
    if (f.derechoOrganismo === null || !conBolsa.has(f.derechoOrganismo)) continue;
    if (valorDerecho === null || valorDerecho <= 0) continue;
    await db.transaction((tx) => registrarConsumoDerecho(tx, {
      organismoCodigo: f.derechoOrganismo as string,
      tramiteId: f.tramiteId,
      valor: valorDerecho,
      fecha: f.liquidadoEn.toISOString().slice(0, 10),
      llave: `tramite:${f.tramiteId}:derecho`,
    }, CTX));
  }
}

function imprimir(reporte: Reporte): void {
  const movimientosCliente = reporte.porCliente.reduce((a, p) => a + p.liquidaciones.reduce((b, l) => b + l.conceptos.length, 0), 0);
  const totalCliente = reporte.porCliente.reduce((a, p) => a + p.total, 0);

  console.log(`\nBackfill de bolsas — corte ${CORTE} — ${APPLY ? 'APLICANDO' : 'SIMULACIÓN (no escribe)'}`);
  console.log('─'.repeat(78));

  console.log(`\nBolsas de clientes: ${reporte.porCliente.length} compañías, ${movimientosCliente} salidas, ${pesos(totalCliente)} en total`);
  console.log('Cada compañía recibe además una entrada de apertura por su total, así que el saldo no cambia.');
  for (const p of reporte.porCliente) {
    const n = p.liquidaciones.reduce((a, l) => a + l.conceptos.length, 0);
    console.log(`  · compañía ${p.companiaId}: ${n} salidas por ${pesos(p.total)} (+ apertura de ${pesos(p.total)})`);
  }

  console.log(`\nBolsas de organismos: ${reporte.porOrganismo.size} organismos`);
  for (const [codigo, acc] of reporte.porOrganismo) {
    console.log(`  · ${codigo}: ${acc.movimientos} consumos por ${pesos(acc.total)}`);
  }

  if (reporte.sinCompania.length > 0) {
    console.log(`\nSIN COMPAÑÍA — ${reporte.sinCompania.length} liquidaciones sin cliente asociado (AC7).`);
    console.log('No se les asienta nada: no hay bolsa a la que cargarlas.');
    console.log(`  ${reporte.sinCompania.slice(0, 20).join(', ')}${reporte.sinCompania.length > 20 ? ' …' : ''}`);
  }

  if (reporte.periodosCerrados.length > 0) {
    console.log(`\nPERIODOS CERRADOS — ${reporte.periodosCerrados.length} movimientos NO asentados (AC8).`);
    console.log('El cierre mensual congela el periodo; reabrirlo es decisión de Financiera.');
    for (const p of reporte.periodosCerrados.slice(0, 20)) {
      console.log(`  · compañía ${p.companiaId}, periodo ${p.periodo}, trámite ${p.tramiteId}`);
    }
  }

  if (movimientosCliente === 0 && reporte.porOrganismo.size === 0) {
    console.log('\nNada por asentar: el histórico ya está en los libros.');
  }
  console.log('');
}

async function main(): Promise<void> {
  const reporte = await planificar();
  imprimir(reporte);
  if (!APPLY) {
    console.log('Simulación. Vuelve a ejecutar con --apply para escribir.\n');
    return;
  }
  await aplicar(reporte);
  console.log('Backfill aplicado.\n');
}

// Solo cuando se ejecuta como script. Sin este guard, importarlo desde un test dispararía el
// backfill entero y mataría el proceso con `process.exit`.
const ejecutadoDirectamente = process.argv[1]?.includes('flito-backfill-bolsas');
if (ejecutadoDirectamente) {
  main()
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
}
