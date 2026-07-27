// FLITO — liquidación sellada del trámite (HU #10965, Feature #10939 §2.3).
//
// Liquidar es CONGELAR lo que costó el trámite en este momento: si mañana cambia la tarifa
// negociada con la compañía o la tasa del GMF, un trámite ya liquidado sigue mostrando lo que se
// cobró. Por eso los valores se copian a `flito_liquidaciones` en vez de recalcularse al leer.
//
// No confundir con `apps/api/src/modules/liquidacion/`, que es del subsistema antiguo
// (`tramites_digitales` con id entero + órdenes de trabajo) y no tiene relación con FLITO.

import { desc, eq } from 'drizzle-orm';
import {
  EstadoImpuesto, EstadoSoat,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import {
  clients, flitoDerechosTramite, flitoImpuestos, flitoLiquidacionEventos, flitoLiquidaciones,
  flitoSoat, flitoTramites,
} from '../../db/schema.js';
import { tarifaDe, type ValorTarifa } from '../flito-parametrizacion/flito-tarifas.service.js';

export class LiquidacionError extends Error {
  constructor(message: string, readonly faltantes: string[] = []) {
    super(message);
    this.name = 'LiquidacionError';
  }
}

/**
 * Tasa del gravamen a los movimientos financieros (4 x 1000).
 *
 * Se aplica SOLO sobre los desembolsos reales —SOAT, impuesto y derecho de trámite—, que es el
 * dinero que efectivamente sale por el banco hacia un tercero. El trámite digital y la logística
 * son honorarios propios de FLIT, no giros, y por eso no forman base.
 */
export const TASA_GMF = 0.004;

export const ESTADO_LIQUIDACION = { LIQUIDADO: 'liquidado', FACTURADO: 'facturado' } as const;
export type EstadoLiquidacion = (typeof ESTADO_LIQUIDACION)[keyof typeof ESTADO_LIQUIDACION];

/** Un concepto del cálculo. `valor: null` = no aplica o no está configurado; NUNCA cero implícito. */
export interface ConceptoLiquidado {
  valor: number | null;
  /** Por qué vale eso: útil para auditar la liquidación años después. */
  origen: string;
  /** Si es true, la liquidación no puede sellarse hasta resolverlo. */
  bloquea: boolean;
}

export interface CalculoLiquidacion {
  tramiteId: string;
  idFlit: string;
  soat: ConceptoLiquidado;
  impuesto: ConceptoLiquidado;
  derecho: ConceptoLiquidado;
  tramiteDigital: ConceptoLiquidado;
  logistica: ConceptoLiquidado;
  baseGmf: number;
  tasaGmf: number;
  valorGmf: number;
  total: number;
  /** Qué impide liquidar. Vacío = se puede sellar. */
  faltantes: string[];
}

export interface LiquidacionDto extends CalculoLiquidacion {
  id: string;
  estado: EstadoLiquidacion;
  liquidadoEn: string;
  facturadoEn: string | null;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));
const redondear = (n: number): number => Math.round(n * 100) / 100;

/** Suma tratando null como ausencia, no como cero. Solo cuenta lo que sí aplica. */
const sumar = (...vs: Array<number | null>): number =>
  vs.reduce<number>((a, v) => a + (v ?? 0), 0);

function deTarifa(t: ValorTarifa, etiqueta: string): ConceptoLiquidado {
  if (t.origen === 'no_configurada') {
    return { valor: null, origen: 'No configurado', bloquea: true };
  }
  return { valor: t.valor, origen: t.origen === 'especifica' ? `Tarifa de ${etiqueta}` : 'Tarifa genérica', bloquea: false };
}

interface FilaCalculo {
  tramiteId: string;
  idFlit: string;
  tipoTramite: string | null;
  companiaId: number | null;
  logisticaAutogestionable: boolean | null;
  soatId: string | null;
  soatEstado: string | null;
  soatValorPagado: string | null;
  soatAutogestionable: boolean | null;
  impuestoId: string | null;
  impuestoEstado: string | null;
  impuestoValorPagado: string | null;
  impuestosAutogestionable: boolean | null;
  derechoValor: string | null;
}

function proyeccionCalculo() {
  return db.select({
    tramiteId: flitoTramites.id,
    idFlit: flitoTramites.idFlit,
    tipoTramite: flitoTramites.tipoTramite,
    companiaId: flitoTramites.companiaId,
    logisticaAutogestionable: clients.logisticaAutogestionable,
    soatAutogestionable: clients.soatAutogestionable,
    impuestosAutogestionable: clients.impuestosAutogestionable,
    soatId: flitoSoat.id,
    soatEstado: flitoSoat.estado,
    soatValorPagado: flitoSoat.valorPagado,
    impuestoId: flitoImpuestos.id,
    impuestoEstado: flitoImpuestos.estado,
    impuestoValorPagado: flitoImpuestos.valorPagado,
    derechoValor: flitoDerechosTramite.valor,
  }).from(flitoTramites)
    .leftJoin(clients, eq(flitoTramites.companiaId, clients.id))
    .leftJoin(flitoSoat, eq(flitoTramites.soatId, flitoSoat.id))
    .leftJoin(flitoImpuestos, eq(flitoImpuestos.tramiteId, flitoTramites.id))
    .leftJoin(flitoDerechosTramite, eq(flitoDerechosTramite.tramiteId, flitoTramites.id));
}

/**
 * Calcula lo que costaría liquidar, SIN sellar nada. Es lo que alimenta la previsualización y lo que
 * `liquidar()` persiste si no hay faltantes.
 *
 * Reglas de cada concepto:
 *  - SOAT / impuesto: el valor pagado. Si la compañía los autogestiona, no aplican (null, no cero).
 *    Si están pendientes, bloquean: sellar un cero congelaría un cobro que aún no ocurrió.
 *  - Derecho de trámite: el valor real del recibo. Sin recibo, bloquea.
 *  - Trámite digital: tarifa de la compañía. Sin tarifa, «No configurado» y bloquea.
 *  - Logística: tarifa de la compañía, salvo que la compañía autogestione su logística.
 */
export async function calcular(tramiteId: string): Promise<CalculoLiquidacion> {
  const [f] = await proyeccionCalculo().where(eq(flitoTramites.id, tramiteId)).limit(1) as FilaCalculo[];
  if (!f) throw new LiquidacionError('El trámite no existe');
  return calcularDeFila(f);
}

async function calcularDeFila(f: FilaCalculo): Promise<CalculoLiquidacion> {
  const faltantes: string[] = [];

  const soat: ConceptoLiquidado = f.soatAutogestionable
    ? { valor: null, origen: 'La compañía autogestiona el SOAT', bloquea: false }
    : f.soatId === null
      ? { valor: null, origen: 'Sin SOAT (exento)', bloquea: false }
      : f.soatEstado === EstadoSoat.PAGADO && f.soatValorPagado !== null
        ? { valor: num(f.soatValorPagado), origen: 'Valor pagado del SOAT', bloquea: false }
        : { valor: null, origen: `SOAT en estado "${f.soatEstado}"`, bloquea: true };

  const impuesto: ConceptoLiquidado = f.impuestosAutogestionable
    ? { valor: null, origen: 'La compañía autogestiona el impuesto', bloquea: false }
    : f.impuestoId === null
      ? { valor: null, origen: 'Sin impuesto (exento)', bloquea: false }
      : f.impuestoEstado === EstadoImpuesto.PAGADO && f.impuestoValorPagado !== null
        ? { valor: num(f.impuestoValorPagado), origen: 'Valor pagado del impuesto', bloquea: false }
        : { valor: null, origen: `Impuesto en estado "${f.impuestoEstado}"`, bloquea: true };

  const derecho: ConceptoLiquidado = f.derechoValor !== null
    ? { valor: num(f.derechoValor), origen: 'Recibo de derecho de trámite', bloquea: false }
    : { valor: null, origen: 'Sin recibo de derecho de trámite', bloquea: true };

  const etiquetaTipo = f.tipoTramite ?? 'tipo';
  const tramiteDigital = deTarifa(
    await tarifaDe(f.companiaId, 'tramite_digital', f.tipoTramite), etiquetaTipo,
  );

  // La logística se cobra a toda compañía que no la autogestione, haya habido entrega o no.
  const logistica: ConceptoLiquidado = f.logisticaAutogestionable
    ? { valor: null, origen: 'La compañía autogestiona su logística', bloquea: false }
    : deTarifa(await tarifaDe(f.companiaId, 'logistica', f.tipoTramite), etiquetaTipo);

  if (soat.bloquea) faltantes.push(soat.origen);
  if (impuesto.bloquea) faltantes.push(impuesto.origen);
  if (derecho.bloquea) faltantes.push(derecho.origen);
  if (tramiteDigital.bloquea) faltantes.push('Tarifa de trámite digital no configurada para la compañía');
  if (logistica.bloquea) faltantes.push('Tarifa de logística no configurada para la compañía');

  // Base del 4x1000: solo los desembolsos que salen por el banco hacia un tercero.
  const baseGmf = redondear(sumar(soat.valor, impuesto.valor, derecho.valor));
  const valorGmf = redondear(baseGmf * TASA_GMF);
  const total = redondear(baseGmf + sumar(tramiteDigital.valor, logistica.valor) + valorGmf);

  return {
    tramiteId: f.tramiteId, idFlit: f.idFlit,
    soat, impuesto, derecho, tramiteDigital, logistica,
    baseGmf, tasaGmf: TASA_GMF, valorGmf, total, faltantes,
  };
}

/** Liquidación vigente de un trámite, o null. */
export async function liquidacionDe(tramiteId: string): Promise<LiquidacionDto | null> {
  const [l] = await db.select().from(flitoLiquidaciones)
    .where(eq(flitoLiquidaciones.tramiteId, tramiteId)).limit(1);
  if (!l) return null;
  const [t] = await db.select({ idFlit: flitoTramites.idFlit }).from(flitoTramites)
    .where(eq(flitoTramites.id, tramiteId)).limit(1);
  return aDto(l, t?.idFlit ?? '');
}

function aDto(l: typeof flitoLiquidaciones.$inferSelect, idFlit: string): LiquidacionDto {
  const d = (l.detalle ?? {}) as Partial<Record<string, ConceptoLiquidado>>;
  const concepto = (k: string, valor: string | null): ConceptoLiquidado =>
    d[k] ?? { valor: num(valor), origen: 'Sellado', bloquea: false };
  return {
    id: l.id,
    tramiteId: l.tramiteId,
    idFlit,
    estado: l.estado as EstadoLiquidacion,
    soat: concepto('soat', l.valorSoat),
    impuesto: concepto('impuesto', l.valorImpuesto),
    derecho: concepto('derecho', l.valorDerecho),
    tramiteDigital: concepto('tramiteDigital', l.valorTramiteDigital),
    logistica: concepto('logistica', l.valorLogistica),
    baseGmf: Number(l.baseGmf), tasaGmf: Number(l.tasaGmf), valorGmf: Number(l.valorGmf),
    total: Number(l.total),
    faltantes: [],
    liquidadoEn: l.liquidadoEn.toISOString(),
    facturadoEn: l.facturadoEn ? l.facturadoEn.toISOString() : null,
  };
}

/**
 * Sella la liquidación. Falla —con la lista de faltantes— si algún concepto aplicable no está
 * resuelto: liquidar a medias congelaría un cobro incompleto que nadie volvería a revisar.
 */
export async function liquidar(tramiteId: string, usuarioId: number | null): Promise<LiquidacionDto> {
  const existente = await liquidacionDe(tramiteId);
  if (existente) {
    throw new LiquidacionError('El trámite ya está liquidado. Reversa la liquidación antes de volver a liquidar.');
  }

  const calculo = await calcular(tramiteId);
  if (calculo.faltantes.length > 0) {
    throw new LiquidacionError('El trámite no puede liquidarse todavía', calculo.faltantes);
  }

  const detalle = {
    soat: calculo.soat, impuesto: calculo.impuesto, derecho: calculo.derecho,
    tramiteDigital: calculo.tramiteDigital, logistica: calculo.logistica,
  };
  const valores = {
    tramiteId,
    estado: ESTADO_LIQUIDACION.LIQUIDADO,
    valorSoat: calculo.soat.valor === null ? null : String(calculo.soat.valor),
    valorImpuesto: calculo.impuesto.valor === null ? null : String(calculo.impuesto.valor),
    valorDerecho: calculo.derecho.valor === null ? null : String(calculo.derecho.valor),
    valorTramiteDigital: calculo.tramiteDigital.valor === null ? null : String(calculo.tramiteDigital.valor),
    valorLogistica: calculo.logistica.valor === null ? null : String(calculo.logistica.valor),
    baseGmf: String(calculo.baseGmf), tasaGmf: String(calculo.tasaGmf), valorGmf: String(calculo.valorGmf),
    total: String(calculo.total), detalle, liquidadoPorId: usuarioId,
  };

  const dto = await db.transaction(async (tx) => {
    const [fila] = await tx.insert(flitoLiquidaciones).values(valores).returning();
    await tx.insert(flitoLiquidacionEventos).values({
      tramiteId, accion: 'liquidar', usuarioId, snapshot: { ...detalle, total: calculo.total },
    });
    return aDto(fila, calculo.idFlit);
  });
  return dto;
}

/**
 * Deshace la liquidación. Permitido hasta que el trámite se marque como facturado; después, los
 * valores quedan congelados de verdad.
 *
 * Borra la fila (el UNIQUE por trámite lo exige) y guarda el snapshot completo en la bitácora: nada
 * se pierde y volver a liquidar queda limpio.
 */
export async function reversar(tramiteId: string, motivo: string, usuarioId: number | null): Promise<void> {
  const texto = motivo.trim();
  if (texto.length < 5) throw new LiquidacionError('Indica el motivo del reverso (mínimo 5 caracteres)');

  const [l] = await db.select().from(flitoLiquidaciones)
    .where(eq(flitoLiquidaciones.tramiteId, tramiteId)).limit(1);
  if (!l) throw new LiquidacionError('El trámite no está liquidado');
  if (l.estado === ESTADO_LIQUIDACION.FACTURADO) {
    throw new LiquidacionError('El trámite ya está facturado: su liquidación no puede reversarse');
  }

  await db.transaction(async (tx) => {
    await tx.insert(flitoLiquidacionEventos).values({
      tramiteId, accion: 'reversar', motivo: texto, usuarioId,
      snapshot: { ...(l.detalle as object ?? {}), total: Number(l.total), liquidadoEn: l.liquidadoEn.toISOString() },
    });
    await tx.delete(flitoLiquidaciones).where(eq(flitoLiquidaciones.id, l.id));
  });
}

/** Marca como facturado. A partir de aquí la liquidación deja de poder reversarse. */
export async function facturar(tramiteId: string, usuarioId: number | null): Promise<LiquidacionDto> {
  const [l] = await db.select().from(flitoLiquidaciones)
    .where(eq(flitoLiquidaciones.tramiteId, tramiteId)).limit(1);
  if (!l) throw new LiquidacionError('El trámite no está liquidado: no puede facturarse');
  if (l.estado === ESTADO_LIQUIDACION.FACTURADO) throw new LiquidacionError('El trámite ya está facturado');

  const dto = await db.transaction(async (tx) => {
    const [fila] = await tx.update(flitoLiquidaciones)
      .set({ estado: ESTADO_LIQUIDACION.FACTURADO, facturadoPorId: usuarioId, facturadoEn: new Date(), updatedAt: new Date() })
      .where(eq(flitoLiquidaciones.id, l.id)).returning();
    await tx.insert(flitoLiquidacionEventos).values({
      tramiteId, accion: 'facturar', usuarioId, snapshot: { total: Number(fila.total) },
    });
    return fila;
  });

  const [t] = await db.select({ idFlit: flitoTramites.idFlit }).from(flitoTramites)
    .where(eq(flitoTramites.id, tramiteId)).limit(1);
  return aDto(dto, t?.idFlit ?? '');
}

export interface EventoLiquidacion {
  id: string; accion: string; motivo: string | null; snapshot: unknown; creadoEn: string;
}

/** Bitácora de la liquidación de un trámite, más reciente primero. */
export async function eventosDe(tramiteId: string): Promise<EventoLiquidacion[]> {
  const filas = await db.select().from(flitoLiquidacionEventos)
    .where(eq(flitoLiquidacionEventos.tramiteId, tramiteId))
    .orderBy(desc(flitoLiquidacionEventos.createdAt));
  return filas.map((f) => ({
    id: f.id, accion: f.accion, motivo: f.motivo, snapshot: f.snapshot, creadoEn: f.createdAt.toISOString(),
  }));
}

/**
 * Liquidación en lote. Nunca falla entera: cada trámite se intenta por separado y se reporta su
 * resultado, porque en un lote de 50 lo normal es que a unos pocos les falte algo.
 */
export interface ResultadoLote {
  liquidados: string[];
  fallidos: Array<{ tramiteId: string; motivo: string; faltantes: string[] }>;
}

export async function liquidarLote(tramiteIds: string[], usuarioId: number | null): Promise<ResultadoLote> {
  const r: ResultadoLote = { liquidados: [], fallidos: [] };
  for (const id of tramiteIds) {
    try {
      await liquidar(id, usuarioId);
      r.liquidados.push(id);
    } catch (e) {
      const err = e as LiquidacionError;
      r.fallidos.push({ tramiteId: id, motivo: err.message, faltantes: err.faltantes ?? [] });
    }
  }
  return r;
}
