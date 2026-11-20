// FLITO — catálogo de bolsas del modelo único (HU #13900, Feature #13886, ADR-0029): crear, editar,
// inactivar y reactivar la bolsa de una COMPAÑÍA, el listado (`buscarBolsas`) y el detalle por id.
//
// Archivo aparte de `flito-bolsas.service.ts` (que vive bajo su techo de max-lines tras la HU-A).
//
// Reglas que este archivo hace cumplir:
//   RN-B1 (D1/D3) Una compañía tiene UNA bolsa, incluida la inactiva: crear otra → 409
//         `bolsa_compania_existe` con `{ bolsaId, activa }` (se reactiva, no se crea). La garantía final
//         es el índice parcial `uq_flito_bolsas_unicas_compania`; la lectura previa solo da el mensaje.
//   RN-B2 (D4) Una bolsa nunca se borra: se inactiva (quién, cuándo, motivo) y se reactiva. Inactivar NO
//         toca saldo ni movimientos.
//   RN-B3 El GMF no es un concepto seleccionable: es un costo financiero, no un servicio que se descuente.
//   RN-B4 Editar no cambia el alcance ni la compañía, y una bolsa inactiva no se edita (409 `bolsa_inactiva`).
//   RN-B5 Toda configuración deja un evento en `flito_bolsas_unicas_eventos` con el usuario; el snapshot
//         lleva conceptos, nunca PII de personas.
//   RN-B6 La rama TRÁNSITO del alta, la edición y los cierres vive en `flito-bolsas.catalogo-transito.ts`
//         (HU #13907); inactivar y reactivar son comunes a ambos alcances y viven aquí.
//   RN-B7 (AC11) Los conceptos que la compañía AUTOGESTIONA (`clients.*_autogestionable`) se calculan EN
//         LECTURA (cambian después de crear la bolsa) y NO bloquean crear ni editar: la UI avisa. La regla
//         de no descontarlos es de la HU-C (#13902), no de aquí.

import { and, asc, eq, ilike, inArray, or, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  clients, flitoBolsasUnicas, flitoBolsasUnicasCobertura, flitoBolsasUnicasConceptos, flitoBolsasUnicasEventos,
} from '../../db/schema.js';
import {
  type AlcanceBolsa, type BolsaDetalleDto, type ConceptoBolsa, ConceptoCosto, type EstadoBolsaCompaniaConAutogestionDto, type BolsaResumenDto, CodigoErrorBolsa, CONCEPTOS_BOLSA_COMPANIA,
  nivelRiesgoDe, porcentajeSaldo,
} from '@operaciones/shared-types';
import { estadoBolsaDeCompania } from './flito-bolsas.estado-compania.js';
import { clienteVigente } from '../clients/cliente-operable.js';
import { BolsaError, type CtxUsuario, esLlaveDuplicada, MSG_BOLSA_INACTIVA, num, type Tx } from './flito-bolsas.libro.js';
import {
  CoberturaOcupadaError, crearBolsaTransitoUnica, datosTransitoDe, type DatosBolsaTransitoUnica, editarBolsaTransitoUnica,
  paresAutogestionados, paresOcupadosDeBolsa,
} from './flito-bolsas.catalogo-transito.js';

export { estadoBolsaDeCompania };

/** Columna de autogestión de `clients` → concepto (AC11). Derecho, trámite digital y servicios adicionales no tienen. */
interface Autogestion { soat: boolean | null; impuestos: boolean | null; logistica: boolean | null }

function autogestionados(a: Autogestion): ConceptoBolsa[] {
  const salida: ConceptoBolsa[] = [];
  if (a.soat) salida.push(ConceptoCosto.SOAT);
  if (a.impuestos) salida.push(ConceptoCosto.IMPUESTO);
  if (a.logistica) salida.push(ConceptoCosto.LOGISTICA);
  return salida;
}

const COLUMNAS_AUTOGESTION = {
  soat: clients.soatAutogestionable,
  impuestos: clients.impuestosAutogestionable,
  logistica: clients.logisticaAutogestionable,
};

/**
 * AC8 + AC11: el estado de la bolsa de la compañía MÁS lo que la compañía autogestiona (para el formulario
 * de alta, antes de que exista la bolsa). `estadoBolsaDeCompania` (contrato (d) con #13407) no cambia.
 */
export async function estadoConAutogestion(companiaId: number): Promise<EstadoBolsaCompaniaConAutogestionDto> {
  const [estado, [cliente]] = await Promise.all([
    estadoBolsaDeCompania(companiaId),
    db.select(COLUMNAS_AUTOGESTION).from(clients).where(eq(clients.id, companiaId)).limit(1),
  ]);
  return { ...estado, conceptosAutogestionados: cliente ? autogestionados(cliente) : [] };
}

/** 409 de «ya existe» con los datos que la web necesita para ofrecer abrirla o reactivarla. */
export class BolsaCompaniaExisteError extends BolsaError {
  constructor(readonly datos: { bolsaId: string; activa: boolean }) {
    super('La compañía ya tiene bolsa', 409, CodigoErrorBolsa.BOLSA_COMPANIA_EXISTE);
    this.name = 'BolsaCompaniaExisteError';
  }
}

export const MSG_TRANSITO_PENDIENTE = 'Las bolsas de tránsito se crean y editan desde su pantalla actual por ahora';

/** Lo mínimo que necesitan las guardas: alcance y dueño. */
export interface BolsaGuarda { id: string; alcance: AlcanceBolsa; companiaId: number | null; activa: boolean }

export interface DatosBolsaCompania { companiaId: number; conceptos: string[] }

const CONCEPTOS_VALIDOS = new Set<string>(CONCEPTOS_BOLSA_COMPANIA);

/** Conceptos de una bolsa de compañía: al menos uno, sin GMF ni desconocidos, sin repetidos (RN-B3). */
export function validarConceptos(conceptos: readonly string[]): string[] {
  const unicos = [...new Set(conceptos)];
  if (unicos.length === 0) throw new BolsaError('Selecciona al menos un concepto', 400, CodigoErrorBolsa.DATOS_INVALIDOS);
  if (unicos.some((c) => !CONCEPTOS_VALIDOS.has(c))) {
    throw new BolsaError('Concepto no válido para una bolsa de compañía', 400, CodigoErrorBolsa.DATOS_INVALIDOS);
  }
  return unicos.sort();
}

async function registrarEvento(
  tx: Tx, bolsaId: string, accion: 'crear' | 'editar' | 'inactivar' | 'reactivar',
  snapshot: Record<string, unknown>, ctx: CtxUsuario, motivo: string | null = null,
): Promise<void> {
  await tx.insert(flitoBolsasUnicasEventos).values({
    bolsaId, accion, motivo, snapshot, usuarioId: ctx.userId, usuarioNombre: ctx.nombre,
  });
}

async function conceptosDe(tx: Tx, bolsaId: string): Promise<string[]> {
  const filas = await tx.select({ c: flitoBolsasUnicasConceptos.concepto }).from(flitoBolsasUnicasConceptos)
    .where(eq(flitoBolsasUnicasConceptos.bolsaId, bolsaId)).orderBy(asc(flitoBolsasUnicasConceptos.concepto));
  return filas.map((f) => f.c);
}

async function bloquear(tx: Tx, bolsaId: string): Promise<BolsaGuarda> {
  const [fila] = await tx.select({
    id: flitoBolsasUnicas.id, alcance: flitoBolsasUnicas.alcance,
    companiaId: flitoBolsasUnicas.companiaId, activa: flitoBolsasUnicas.activa,
  }).from(flitoBolsasUnicas).where(eq(flitoBolsasUnicas.id, bolsaId)).for('update').limit(1);
  if (!fila) throw new BolsaError('La bolsa no existe', 404);
  return { ...fila, alcance: fila.alcance as AlcanceBolsa };
}

/** Bolsa por id para las guardas (sin lock), o `undefined`. */
export async function bolsaParaGuarda(bolsaId: string): Promise<BolsaGuarda | undefined> {
  const [fila] = await db.select({
    id: flitoBolsasUnicas.id, alcance: flitoBolsasUnicas.alcance,
    companiaId: flitoBolsasUnicas.companiaId, activa: flitoBolsasUnicas.activa,
  }).from(flitoBolsasUnicas).where(eq(flitoBolsasUnicas.id, bolsaId)).limit(1);
  return fila ? { ...fila, alcance: fila.alcance as AlcanceBolsa } : undefined;
}

/** 409 `bolsa_compania_existe` con la bolsa que ya tiene la compañía. */
async function existeDe(companiaId: number): Promise<BolsaCompaniaExisteError | null> {
  const [previa] = await db.select({ id: flitoBolsasUnicas.id, activa: flitoBolsasUnicas.activa })
    .from(flitoBolsasUnicas)
    .where(and(eq(flitoBolsasUnicas.alcance, 'compania'), eq(flitoBolsasUnicas.companiaId, companiaId)))
    .limit(1);
  return previa ? new BolsaCompaniaExisteError({ bolsaId: previa.id, activa: previa.activa }) : null;
}

/** AC1-AC3: alta de la bolsa de una compañía, activa y con saldo 0. */
export async function crearBolsaCompania(datos: DatosBolsaCompania, ctx: CtxUsuario): Promise<BolsaDetalleDto> {
  const conceptos = validarConceptos(datos.conceptos);
  // RN-CLI-9 (HU #13953): un cliente eliminado no recibe bolsa nueva; cuenta como inexistente.
  const [compania] = await db.select({ id: clients.id }).from(clients)
    .where(and(eq(clients.id, datos.companiaId), clienteVigente())).limit(1);
  if (!compania) throw new BolsaError('La compañía no existe', 404);
  const existe = await existeDe(datos.companiaId);
  if (existe) throw existe;

  let bolsaId: string;
  try {
    bolsaId = await db.transaction(async (tx) => {
      const [bolsa] = await tx.insert(flitoBolsasUnicas)
        .values({ alcance: 'compania', companiaId: datos.companiaId, creadaPorId: ctx.userId })
        .returning({ id: flitoBolsasUnicas.id });
      await tx.insert(flitoBolsasUnicasConceptos).values(conceptos.map((concepto) => ({ bolsaId: bolsa!.id, concepto })));
      await registrarEvento(tx, bolsa!.id, 'crear', { alcance: 'compania', companiaId: datos.companiaId, conceptos }, ctx);
      return bolsa!.id;
    });
  } catch (e) {
    // Carrera: otro alta de la misma compañía confirmó entre la lectura y el INSERT (RN-B1).
    if (esLlaveDuplicada(e)) throw (await existeDe(datos.companiaId)) ?? e;
    throw e;
  }
  return (await bolsaDetalle(bolsaId))!;
}

/** HU #13907 AC1-AC2: alta de una bolsa de tránsito (lógica en el archivo de tránsito). */
export async function crearBolsaTransito(datos: DatosBolsaTransitoUnica, ctx: CtxUsuario): Promise<BolsaDetalleDto> {
  return (await bolsaDetalle(await crearBolsaTransitoUnica(datos, ctx)))!;
}

/** HU #13907 AC2-AC3: nombre, secretarías y conceptos de una bolsa de tránsito activa. */
export async function editarBolsaTransito(bolsaId: string, datos: DatosBolsaTransitoUnica, ctx: CtxUsuario): Promise<BolsaDetalleDto> {
  await editarBolsaTransitoUnica(bolsaId, datos, ctx);
  return (await bolsaDetalle(bolsaId))!;
}

/** AC4: cambia los conceptos de la bolsa de una compañía. No toca alcance ni compañía (RN-B4). */
export async function editarBolsa(bolsaId: string, datos: { conceptos: string[] }, ctx: CtxUsuario): Promise<BolsaDetalleDto> {
  const conceptos = validarConceptos(datos.conceptos);
  await db.transaction(async (tx) => {
    const bolsa = await bloquear(tx, bolsaId);
    if (bolsa.alcance !== 'compania') throw new BolsaError(MSG_TRANSITO_PENDIENTE, 400, CodigoErrorBolsa.DATOS_INVALIDOS);
    if (!bolsa.activa) throw new BolsaError(MSG_BOLSA_INACTIVA, 409, CodigoErrorBolsa.BOLSA_INACTIVA);
    const antes = await conceptosDe(tx, bolsaId);
    await tx.delete(flitoBolsasUnicasConceptos).where(eq(flitoBolsasUnicasConceptos.bolsaId, bolsaId));
    await tx.insert(flitoBolsasUnicasConceptos).values(conceptos.map((concepto) => ({ bolsaId, concepto })));
    await tx.update(flitoBolsasUnicas).set({ updatedAt: new Date() }).where(eq(flitoBolsasUnicas.id, bolsaId));
    await registrarEvento(tx, bolsaId, 'editar', { antes: { conceptos: antes }, despues: { conceptos } }, ctx);
  });
  return (await bolsaDetalle(bolsaId))!;
}

/** AC5: inactiva con motivo; conserva saldo y movimientos (RN-B2). */
export async function inactivarBolsa(bolsaId: string, motivo: string, ctx: CtxUsuario): Promise<BolsaDetalleDto> {
  await db.transaction(async (tx) => {
    const bolsa = await bloquear(tx, bolsaId);
    if (!bolsa.activa) throw new BolsaError('La bolsa ya está inactiva', 409, CodigoErrorBolsa.YA_INACTIVA);
    await tx.update(flitoBolsasUnicas).set({
      activa: false, inactivadaEn: new Date(), inactivadaPorId: ctx.userId, inactivadaPorNombre: ctx.nombre,
      motivoInactivacion: motivo, updatedAt: new Date(),
    }).where(eq(flitoBolsasUnicas.id, bolsaId));
    // Tránsito: la copia de `activa` en la cobertura libera sus pares (D3). En compañía no hay filas.
    await tx.update(flitoBolsasUnicasCobertura).set({ activa: false }).where(eq(flitoBolsasUnicasCobertura.bolsaId, bolsaId));
    await registrarEvento(tx, bolsaId, 'inactivar', { conceptos: await conceptosDe(tx, bolsaId) }, ctx, motivo);
  });
  return (await bolsaDetalle(bolsaId))!;
}

/** AC6: reactiva con motivo. Los datos de la última inactivación quedan en la bitácora, no en la fila. */
export async function reactivarBolsa(bolsaId: string, motivo: string, ctx: CtxUsuario): Promise<BolsaDetalleDto> {
  try {
    await db.transaction(async (tx) => {
      const bolsa = await bloquear(tx, bolsaId);
      if (bolsa.activa) throw new BolsaError('La bolsa ya está activa', 409, CodigoErrorBolsa.YA_ACTIVA);
      // Tránsito (HU #13907 AC5): una pareja tomada por otra activa mientras esta estuvo inactiva → 409
      // con las parejas; la bolsa sigue inactiva (la transacción se deshace).
      const ocupados = bolsa.alcance === 'transito' ? await paresOcupadosDeBolsa(tx, bolsaId) : [];
      if (ocupados.length > 0) throw new CoberturaOcupadaError(ocupados);
      await tx.update(flitoBolsasUnicas).set({
        activa: true, inactivadaEn: null, inactivadaPorId: null, inactivadaPorNombre: null,
        motivoInactivacion: null, updatedAt: new Date(),
      }).where(eq(flitoBolsasUnicas.id, bolsaId));
      await tx.update(flitoBolsasUnicasCobertura).set({ activa: true }).where(eq(flitoBolsasUnicasCobertura.bolsaId, bolsaId));
      await registrarEvento(tx, bolsaId, 'reactivar', { conceptos: await conceptosDe(tx, bolsaId) }, ctx, motivo);
    });
  } catch (e) {
    // Tránsito, carrera: otra bolsa activa tomó un par entre la lectura y el UPDATE (23505 del índice
    // parcial `uq_flito_bolsas_unicas_cobertura_activa`, D3). Se relee fuera de la tx abortada.
    if (esLlaveDuplicada(e)) throw new CoberturaOcupadaError(await paresOcupadosDeBolsa(db, bolsaId));
    throw e;
  }
  return (await bolsaDetalle(bolsaId))!;
}

// ─────────────────────────── Lectura ─────────────────────────────────────────

export interface FiltroBolsas { alcance?: AlcanceBolsa; activa?: boolean; texto?: string }

const COLUMNAS_DETALLE = {
  id: flitoBolsasUnicas.id,
  alcance: flitoBolsasUnicas.alcance,
  nombre: flitoBolsasUnicas.nombre,
  companiaId: flitoBolsasUnicas.companiaId,
  companiaNombre: clients.name,
  activa: flitoBolsasUnicas.activa,
  saldo: flitoBolsasUnicas.saldo,
  ultimaEntradaValor: flitoBolsasUnicas.ultimaEntradaValor,
  ultimaEntradaEn: flitoBolsasUnicas.ultimaEntradaEn,
  inactivadaEn: flitoBolsasUnicas.inactivadaEn,
  inactivadaPorNombre: flitoBolsasUnicas.inactivadaPorNombre,
  motivoInactivacion: flitoBolsasUnicas.motivoInactivacion,
  ...COLUMNAS_AUTOGESTION,
};

type FilaDetalle = {
  id: string; alcance: string; nombre: string | null; companiaId: number | null; companiaNombre: string | null;
  activa: boolean; saldo: string; ultimaEntradaValor: string | null; ultimaEntradaEn: Date | null;
  inactivadaEn: Date | null; inactivadaPorNombre: string | null; motivoInactivacion: string | null;
} & Autogestion;

/** `%` y `_` del usuario son literales, no comodines. */
function patron(texto: string): string {
  return `%${texto.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

async function hidratar(filas: FilaDetalle[]): Promise<BolsaDetalleDto[]> {
  if (filas.length === 0) return [];
  const transito = filas.filter((f) => f.alcance === 'transito');
  const [autoTransito, datosTransito] = await Promise.all([
    coberturaTransitoDe(filas).then(paresAutogestionados),
    datosTransitoDe(transito.map((f) => ({
      id: f.id, saldo: num(f.saldo), ultimaEntradaValor: f.ultimaEntradaValor === null ? null : num(f.ultimaEntradaValor),
    }))),
  ]);
  const ids = filas.map((f) => f.id);
  const [conceptos, cobertura] = await Promise.all([
    db.select().from(flitoBolsasUnicasConceptos).where(inArray(flitoBolsasUnicasConceptos.bolsaId, ids))
      .orderBy(asc(flitoBolsasUnicasConceptos.concepto)),
    db.select({
      bolsaId: flitoBolsasUnicasCobertura.bolsaId, organismoCodigo: flitoBolsasUnicasCobertura.organismoCodigo,
      concepto: flitoBolsasUnicasCobertura.concepto,
    }).from(flitoBolsasUnicasCobertura).where(inArray(flitoBolsasUnicasCobertura.bolsaId, ids))
      .orderBy(asc(flitoBolsasUnicasCobertura.organismoCodigo), asc(flitoBolsasUnicasCobertura.concepto)),
  ]);
  return filas.map((f) => {
    const saldo = num(f.saldo);
    const ultima = f.ultimaEntradaValor === null ? null : num(f.ultimaEntradaValor);
    const cob = cobertura.filter((c) => c.bolsaId === f.id).map(({ organismoCodigo, concepto }) => ({ organismoCodigo, concepto }));
    return {
      id: f.id,
      alcance: f.alcance as AlcanceBolsa,
      nombre: f.alcance === 'compania' ? (f.companiaNombre ?? '') : (f.nombre ?? ''),
      companiaId: f.companiaId,
      companiaNombre: f.alcance === 'compania' ? f.companiaNombre : null,
      activa: f.activa,
      conceptos: f.alcance === 'compania'
        ? conceptos.filter((c) => c.bolsaId === f.id).map((c) => c.concepto)
        : [...new Set(cob.map((c) => c.concepto))].sort(),
      cobertura: cob,
      saldo,
      ultimaEntradaValor: ultima,
      ultimaEntradaEn: f.ultimaEntradaEn ? f.ultimaEntradaEn.toISOString() : null,
      nivel: nivelRiesgoDe(saldo, ultima),
      porcentaje: porcentajeSaldo(saldo, ultima),
      transito: datosTransito.get(f.id) ?? null,
      inactivadaEn: f.inactivadaEn ? f.inactivadaEn.toISOString() : null,
      inactivadaPorNombre: f.inactivadaPorNombre,
      motivoInactivacion: f.motivoInactivacion,
      conceptosAutogestionados: f.alcance === 'compania' ? autogestionados(f) : [],
      paresAutogestionados: f.alcance === 'transito'
        ? autoTransito.filter((p) => cob.some((c) => c.organismoCodigo === p.organismoCodigo && c.concepto === p.concepto))
        : [],
    };
  });
}

/** Pares de la cobertura de las bolsas de tránsito de `filas` (para la autogestión de AC9, HU #13907). */
async function coberturaTransitoDe(filas: FilaDetalle[]): Promise<Array<{ organismoCodigo: string; concepto: string }>> {
  const ids = filas.filter((f) => f.alcance === 'transito').map((f) => f.id);
  if (ids.length === 0) return [];
  return db.select({ organismoCodigo: flitoBolsasUnicasCobertura.organismoCodigo, concepto: flitoBolsasUnicasCobertura.concepto })
    .from(flitoBolsasUnicasCobertura).where(inArray(flitoBolsasUnicasCobertura.bolsaId, ids));
}

/**
 * AC7: listado con filtros por BODY. `companiaAlcance` es la frontera por enlace (ADR-0024):
 * `undefined` = sin enlace (todas); número = solo la bolsa de esa compañía; `null` = ninguna.
 */
export async function buscarBolsas(filtro: FiltroBolsas, companiaAlcance: number | null | undefined): Promise<BolsaResumenDto[]> {
  if (companiaAlcance === null) return [];
  const condiciones: SQL[] = [];
  if (companiaAlcance !== undefined) {
    condiciones.push(eq(flitoBolsasUnicas.alcance, 'compania'), eq(flitoBolsasUnicas.companiaId, companiaAlcance));
  }
  if (filtro.alcance) condiciones.push(eq(flitoBolsasUnicas.alcance, filtro.alcance));
  if (filtro.activa !== undefined) condiciones.push(eq(flitoBolsasUnicas.activa, filtro.activa));
  if (filtro.texto) {
    const p = patron(filtro.texto);
    condiciones.push(or(ilike(flitoBolsasUnicas.nombre, p), ilike(clients.name, p), ilike(clients.document, p))!);
  }
  const filas = await db.select(COLUMNAS_DETALLE).from(flitoBolsasUnicas)
    .leftJoin(clients, eq(clients.id, flitoBolsasUnicas.companiaId))
    .where(condiciones.length ? and(...condiciones) : undefined)
    .orderBy(asc(flitoBolsasUnicas.alcance), asc(clients.name), asc(flitoBolsasUnicas.nombre))
    .limit(1000);
  return (await hidratar(filas)).map(({
    inactivadaEn: _a, inactivadaPorNombre: _b, motivoInactivacion: _c, conceptosAutogestionados: _d,
    paresAutogestionados: _e, ...resumen
  }) => resumen);
}

/** Detalle por id, o `null` si no existe. La frontera la aplica la guarda de la ruta. */
export async function bolsaDetalle(bolsaId: string): Promise<BolsaDetalleDto | null> {
  const filas = await db.select(COLUMNAS_DETALLE).from(flitoBolsasUnicas)
    .leftJoin(clients, eq(clients.id, flitoBolsasUnicas.companiaId))
    .where(eq(flitoBolsasUnicas.id, bolsaId)).limit(1);
  const [detalle] = await hidratar(filas);
  return detalle ?? null;
}
