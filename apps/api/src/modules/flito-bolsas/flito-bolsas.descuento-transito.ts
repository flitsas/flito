// FLITO — lado TRÁNSITO del descuento al aplicar un comprobante de pago (HU #13909, Feature #13887,
// ADR-0029 D7-D11). Lo llama `descontarComprobante` (`flito-bolsas.descuento.ts`) DESPUÉS del lado
// compañía, en la misma tx de aplicar: cada lado se decide por separado y ninguno condiciona al otro.
//
// Reglas (cada omisión lleva su motivo y NINGUNA genera alerta, D10):
//   RN-T1 Solo SOAT, impuesto y derecho se pagan a una secretaría (`concepto_no_cubierto` para el resto:
//         trámite digital, logística, servicios adicionales).
//   RN-T2 Secretaría: `organismo_codigo` del REGISTRO DUEÑO del pago —`flito_soat` (vía `soat_id` del
//         trámite), `flito_impuestos`, `flito_derechos_tramite`—, mismo criterio que `identificadoresDe` de
//         la liquidación (se congela al crearse; el del trámite se reescribe en cada sincronización).
//         Sin registro o sin secretaría → `sin_organismo`.
//   RN-T3 No mira compañía ni autogestión: el pago ante la secretaría ocurre igual (mismo criterio que el
//         sellado, `flito-liquidacion.service.ts`).
//   RN-T4 Llave (ADR-0006): SOAT → `consumo:soat:<soatId>` (la MISMA de la conciliación: si ya existe,
//         `cubierto_por_conciliacion`; de la liquidación anterior al corte, `cubierto_por_liquidacion`);
//         resto → `consumo:comprobante:<id>`. La de este mismo comprobante → idempotente.
//   RN-T5 Bolsa (`bolsaTransitoPara`, FOR UPDATE): cobertura ACTIVA del par (secretaría, concepto) →
//         `sin_bolsa` / `inactiva`.
//   RN-T6 Anti doble cobro con lo anterior al corte: consumo VIVO (`consumo:%`) de origen `automatico` en esa
//         bolsa, mismo trámite y concepto → `cubierto_por_liquidacion`.
//   RN-T7 Saldo insuficiente NO bloquea (D11): queda en negativo y vuelve en `alertas` con el nombre de la bolsa.
//   RN-T8 Orden de locks: comprobante → trámite → bolsa compañía → bolsa tránsito (este archivo, el último).
//   RN-T9 Ley 1581: logs solo con ids.
//
// La reversión (desaplicar/reemplazar/compensación) la hace `revertirDescuentoComprobante`, que ya
// recorre las salidas vivas de ambos alcances en el orden de locks.

import { eq } from 'drizzle-orm';
import { AlcanceBolsa, ConceptoCosto, type ConceptoBolsa, type DescuentoBolsaDto, type MovimientoBolsaDto } from '@operaciones/shared-types';
import { flitoDerechosTramite, flitoImpuestos, flitoSoat, flitoTramites } from '../../db/schema.js';
import { loggerFor } from '../../shared/logger.js';
import { asentarEnBolsa, type CtxUsuario, movimientoPorLlave, type Tx } from './flito-bolsas.libro.js';
import { bolsaTransitoPara } from './flito-bolsas.resolver.js';
import { PREFIJO_CONSUMO } from './flito-bolsas-transito.service.js';

const log = loggerFor('flito-bolsas-descuento-transito');
const TRANSITO = AlcanceBolsa.TRANSITO;
type Motivo = DescuentoBolsaDto['omitidos'][number]['motivo'];

/** Lo mínimo del comprobante que necesita el lado tránsito (el resto lo decide el lado compañía). */
export interface ComprobanteTransito {
  comprobanteId: string;
  tramiteId: string;
  concepto: ConceptoCosto;
  valor: number;
  /** Día contable en Colombia (AAAA-MM-DD) de `aplicadoEn`. */
  fecha: string;
}

/** Dependencias del lado compañía que el lado tránsito reutiliza (evita el import circular). */
export interface ReglasCompartidas {
  /** RN-C5/RN-T4: de quién es una llave ya ocupada; `null` = de este mismo comprobante. */
  motivoLlaveOcupada(previo: MovimientoBolsaDto, comprobanteId: string): Motivo | null;
  /** RN-C7/RN-T6: ¿una salida/consumo VIVO de la liquidación ya cobró trámite × concepto en la bolsa? */
  cubiertoPorLiquidacion(tx: Tx, bolsaId: string, tramiteId: string, concepto: string, prefijo: string): Promise<boolean>;
}

const CONCEPTOS_TRANSITO: ReadonlySet<string> = new Set([ConceptoCosto.SOAT, ConceptoCosto.IMPUESTO, ConceptoCosto.DERECHO]);

/** RN-T2: la secretaría del registro dueño del pago y, para el SOAT, su id (la llave de ADR-0006). */
async function registroDueno(tx: Tx, tramiteId: string, concepto: string): Promise<{ organismo: string | null; soatId: string | null }> {
  if (concepto === ConceptoCosto.SOAT) {
    const [f] = await tx.select({ soatId: flitoSoat.id, organismo: flitoSoat.organismoCodigo }).from(flitoTramites)
      .innerJoin(flitoSoat, eq(flitoTramites.soatId, flitoSoat.id))
      .where(eq(flitoTramites.id, tramiteId)).limit(1);
    return { organismo: f?.organismo ?? null, soatId: f?.soatId ?? null };
  }
  const tabla = concepto === ConceptoCosto.IMPUESTO ? flitoImpuestos : flitoDerechosTramite;
  const [f] = await tx.select({ organismo: tabla.organismoCodigo }).from(tabla).where(eq(tabla.tramiteId, tramiteId)).limit(1);
  return { organismo: f?.organismo ?? null, soatId: null };
}

/** RN-T4: la llave del consumo. */
export function llaveConsumoComprobante(comprobanteId: string, soatId: string | null): string {
  return soatId ? `${PREFIJO_CONSUMO}soat:${soatId}` : `${PREFIJO_CONSUMO}comprobante:${comprobanteId}`;
}

function omitido(motivo: Motivo): DescuentoBolsaDto {
  return { movimientos: [], omitidos: [{ alcance: TRANSITO, motivo }], alertas: [] };
}

function conMovimiento(m: MovimientoBolsaDto, bolsaNombre: string): DescuentoBolsaDto {
  return {
    movimientos: [{ bolsaId: m.bolsaId, alcance: TRANSITO, movimientoId: m.id, valor: m.valor, saldoResultante: m.saldoResultante }],
    omitidos: [],
    alertas: m.saldoResultante < 0 ? [{ bolsaId: m.bolsaId, bolsaNombre, alcance: TRANSITO, saldoResultante: m.saldoResultante }] : [],
  };
}

/**
 * Dentro de la tx de aplicar, tras el lado compañía. Nunca lanza por saldo ni por negocio; sí por error
 * de BD. Idempotente por llave. Quien llama ya comprobó corte, `esPago` y valor > 0.
 */
export async function descontarTransito(
  tx: Tx, c: ComprobanteTransito, ctx: CtxUsuario, reglas: ReglasCompartidas,
): Promise<DescuentoBolsaDto> {
  if (!CONCEPTOS_TRANSITO.has(c.concepto)) return omitido('concepto_no_cubierto');
  const { organismo, soatId } = await registroDueno(tx, c.tramiteId, c.concepto);
  if (!organismo) return omitido('sin_organismo');

  const llave = llaveConsumoComprobante(c.comprobanteId, soatId);
  const ocupada = await movimientoPorLlave(tx, llave);
  if (ocupada) {
    const motivo = reglas.motivoLlaveOcupada(ocupada, c.comprobanteId);
    if (motivo) return omitido(motivo);
  }

  const resuelta = await bolsaTransitoPara(tx, organismo, c.concepto);
  if (!resuelta.bolsa) return omitido(resuelta.motivo);
  const bolsa = resuelta.bolsa;
  if (ocupada) return conMovimiento(ocupada, bolsa.nombre); // reintento de este mismo comprobante
  if (await reglas.cubiertoPorLiquidacion(tx, bolsa.id, c.tramiteId, c.concepto, PREFIJO_CONSUMO)) {
    return omitido('cubierto_por_liquidacion');
  }

  // Savepoint (Bug #11685 punto 3): la familia `consumo:soat:*` también la escribe la conciliación; tras
  // un 23505 la relectura por llave tiene que poder correr y el choque se trata como duplicado.
  const { movimiento, duplicado } = await asentarEnBolsa(tx, bolsa, {
    tipo: 'salida',
    origen: 'comprobante',
    valor: c.valor,
    fecha: c.fecha,
    organismoCodigo: organismo,
    concepto: c.concepto as ConceptoBolsa,
    tramiteId: c.tramiteId,
    comprobanteId: c.comprobanteId,
    llaveIdempotencia: llave,
    observacion: 'Consumo al aplicar el comprobante de pago',
    etiqueta: 'salida',
    savepoint: true,
  }, ctx);
  if (duplicado) {
    const motivo = reglas.motivoLlaveOcupada(movimiento, c.comprobanteId);
    return motivo ? omitido(motivo) : conMovimiento(movimiento, bolsa.nombre);
  }
  log.info({ comprobanteId: c.comprobanteId, bolsaId: bolsa.id, movimientoId: movimiento.id, negativo: movimiento.saldoResultante < 0 },
    'Bolsa de tránsito descontada por comprobante');
  return conMovimiento(movimiento, bolsa.nombre);
}
