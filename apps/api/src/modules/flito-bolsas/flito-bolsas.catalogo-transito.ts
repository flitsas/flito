// FLITO — rama TRÁNSITO del catálogo único de bolsas (HU #13907, Feature #13887, ADR-0029, HU-G back).
//
// Archivo aparte de `flito-bolsas.catalogo.service.ts` para que ninguno de los dos se acerque a las 800
// líneas. Inactivar y reactivar son los del catálogo (comunes a ambos alcances); aquí vive lo propio de
// tránsito: alta, edición, cobertura ocupada con detalle, cierres por bolsa y la autogestión por organismo.
//
// Reglas que este archivo hace cumplir:
//   RN-T1 (D3) Una pareja (secretaría, concepto) la cubre como mucho UNA bolsa ACTIVA. El árbitro es el
//         índice parcial `uq_flito_bolsas_unicas_cobertura_activa`; la lectura previa solo arma el 409
//         `cobertura_ocupada` con `pares: [{organismoCodigo, concepto, bolsaId, bolsaNombre}]`. Un 23505
//         del índice (carrera) se traduce igual. Las inactivas no reservan su cobertura.
//   RN-T2 El nombre de una bolsa de tránsito es único entre las de tránsito (409 `nombre_en_uso`).
//   RN-T3 Editar no cambia el alcance; una bolsa inactiva no se edita (409 `bolsa_inactiva`). El saldo no
//         se toca nunca: es dinero real.
//   RN-T4 (Q3) Las bolsas de tránsito tienen cierre mensual, único por `bolsa_id` + periodo, y la bolsa
//         INACTIVA también se cierra (Q7). El periodo cerrado corre la imputación (`periodoImputable`).
//   RN-T5 (D15, AC9) La pareja (secretaría, impuesto) cuyo organismo es AUTOGESTIONADO se marca al
//         CONSULTAR (la modalidad cambia después de crear la bolsa) y NO bloquea crear ni editar.
//   RN-T6 Toda configuración deja evento en la bitácora con el usuario; el snapshot no lleva PII.

import { and, asc, desc, eq, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import {
  flitoBolsasUnicas, flitoBolsasUnicasCierres, flitoBolsasUnicasCobertura, flitoBolsasUnicasEventos,
  flitoBolsasUnicasMovimientos, flitoOrganismoVigencias,
} from '../../db/schema.js';
import {
  type CierreBolsaTransitoDto, CodigoErrorBolsa, type ConceptoBolsaTransito, CONCEPTOS_BOLSA_TRANSITO,
  type CoberturaBolsaDto, type DatosBolsaTransitoDto, deudaBolsaTransito, nivelBolsaTransitoDe, type ParCoberturaOcupada,
} from '@operaciones/shared-types';
import {
  BolsaError, bolsaBloqueadaPorId, type CtxUsuario, esLlaveDuplicada, hoyIso, MSG_BOLSA_INACTIVA, num,
  periodoDeFecha, redondear, type Tx,
} from './flito-bolsas.libro.js';

/** Modalidad del organismo que hace la pareja (secretaría, impuesto) autogestionada (D15). */
export const MODALIDAD_AUTOGESTIONADO = 'autogestionado' as const;

export interface DatosBolsaTransitoUnica { nombre: string; organismos: string[]; conceptos: string[] }

/** 409 `cobertura_ocupada` con las parejas en conflicto y la bolsa activa que tiene cada una. */
export class CoberturaOcupadaError extends BolsaError {
  constructor(readonly pares: ParCoberturaOcupada[]) {
    super(mensajeOcupada(pares), 409, CodigoErrorBolsa.COBERTURA_OCUPADA);
    this.name = 'CoberturaOcupadaError';
  }
}

function mensajeOcupada(pares: ParCoberturaOcupada[]): string {
  if (pares.length === 0) return 'Otra bolsa activa ya cubre alguna de esas parejas';
  const detalle = pares.slice(0, 3)
    .map((p) => `${p.organismoCodigo} (${p.concepto}) ya está en «${p.bolsaNombre}»`).join('; ');
  const resto = pares.length > 3 ? ` y ${pares.length - 3} más` : '';
  return `Una secretaría no puede tener el mismo concepto en dos bolsas activas: ${detalle}${resto}.`;
}

const nombreEnUso = (nombre: string): BolsaError =>
  new BolsaError(`Ya existe una bolsa de tránsito llamada «${nombre}»`, 409, CodigoErrorBolsa.NOMBRE_EN_USO);

const CONCEPTOS_TRANSITO = new Set<string>(CONCEPTOS_BOLSA_TRANSITO);

/** Nombre (3-120), secretarías y conceptos (derecho | soat | impuesto) sin repetidos, en orden fijo. */
export function normalizarTransito(datos: DatosBolsaTransitoUnica): {
  nombre: string; organismos: string[]; conceptos: ConceptoBolsaTransito[];
} {
  const invalido = (m: string) => new BolsaError(m, 400, CodigoErrorBolsa.DATOS_INVALIDOS);
  const nombre = datos.nombre?.trim() ?? '';
  if (nombre.length < 3) throw invalido('El nombre de la bolsa debe tener al menos 3 caracteres');
  if (nombre.length > 120) throw invalido('El nombre de la bolsa no puede superar 120 caracteres');
  const organismos = [...new Set((datos.organismos ?? []).map((o) => o.trim()).filter(Boolean))].sort();
  if (organismos.length === 0) throw invalido('Selecciona al menos una secretaría');
  const conceptos = [...new Set(datos.conceptos ?? [])];
  if (conceptos.length === 0) throw invalido('Selecciona al menos un concepto');
  if (conceptos.some((c) => !CONCEPTOS_TRANSITO.has(c))) throw invalido('Concepto no válido para una bolsa de tránsito');
  const ordenados = (conceptos as ConceptoBolsaTransito[])
    .sort((a, b) => CONCEPTOS_BOLSA_TRANSITO.indexOf(a) - CONCEPTOS_BOLSA_TRANSITO.indexOf(b));
  return { nombre, organismos, conceptos: ordenados };
}

function filasCobertura(bolsaId: string, organismos: string[], conceptos: string[], activa: boolean) {
  return organismos.flatMap((organismoCodigo) => conceptos.map((concepto) => ({ bolsaId, organismoCodigo, concepto, activa })));
}

/**
 * Parejas de `pares` que hoy cubre OTRA bolsa activa (RN-T1). Lee con `tx` cuando se llama dentro de una
 * transacción sana; tras un 23505 la transacción está abortada y se llama con `db`.
 */
export async function paresOcupados(
  ejecutor: Tx | typeof db, organismos: string[], conceptos: string[], bolsaIdExcluida?: string,
): Promise<ParCoberturaOcupada[]> {
  if (organismos.length === 0 || conceptos.length === 0) return [];
  const C = flitoBolsasUnicasCobertura;
  const filas = await ejecutor.select({
    organismoCodigo: C.organismoCodigo, concepto: C.concepto, bolsaId: C.bolsaId, bolsaNombre: flitoBolsasUnicas.nombre,
  }).from(C)
    .innerJoin(flitoBolsasUnicas, eq(flitoBolsasUnicas.id, C.bolsaId))
    .where(and(
      eq(C.activa, true), inArray(C.organismoCodigo, organismos), inArray(C.concepto, conceptos),
      bolsaIdExcluida ? ne(C.bolsaId, bolsaIdExcluida) : undefined,
    ))
    .orderBy(asc(C.organismoCodigo), asc(C.concepto));
  // `organismos × conceptos` ES la cobertura pedida (alta y edición la escriben así), así que el filtro es exacto.
  return filas.map((f) => ({ ...f, bolsaNombre: f.bolsaNombre ?? '' }));
}

/** Parejas de la cobertura de una bolsa que hoy tiene otra activa (reactivar, AC5). */
export async function paresOcupadosDeBolsa(ejecutor: Tx | typeof db, bolsaId: string): Promise<ParCoberturaOcupada[]> {
  const propias = await ejecutor.select({ o: flitoBolsasUnicasCobertura.organismoCodigo, c: flitoBolsasUnicasCobertura.concepto })
    .from(flitoBolsasUnicasCobertura).where(eq(flitoBolsasUnicasCobertura.bolsaId, bolsaId));
  if (propias.length === 0) return [];
  const llaves = new Set(propias.map((p) => `${p.o}|${p.c}`));
  const candidatas = await paresOcupados(
    ejecutor, [...new Set(propias.map((p) => p.o))], [...new Set(propias.map((p) => p.c))], bolsaId,
  );
  return candidatas.filter((p) => llaves.has(`${p.organismoCodigo}|${p.concepto}`));
}

async function nombreTomado(nombre: string, bolsaIdExcluida?: string): Promise<boolean> {
  const [fila] = await db.select({ id: flitoBolsasUnicas.id }).from(flitoBolsasUnicas)
    .where(and(
      eq(flitoBolsasUnicas.alcance, 'transito'),
      sql`lower(${flitoBolsasUnicas.nombre}) = lower(${nombre})`,
      bolsaIdExcluida ? ne(flitoBolsasUnicas.id, bolsaIdExcluida) : undefined,
    )).limit(1);
  return fila !== undefined;
}

/** 409 si alguna pareja de `organismos × conceptos` (la cobertura que se va a escribir) la tiene otra activa. */
async function exigirCoberturaLibre(
  ejecutor: Tx | typeof db, organismos: string[], conceptos: string[], bolsaIdExcluida?: string,
): Promise<void> {
  const ocupados = await paresOcupados(ejecutor, organismos, conceptos, bolsaIdExcluida);
  if (ocupados.length > 0) throw new CoberturaOcupadaError(ocupados);
}

async function evento(
  tx: Tx, bolsaId: string, accion: 'crear' | 'editar', snapshot: Record<string, unknown>, ctx: CtxUsuario,
): Promise<void> {
  await tx.insert(flitoBolsasUnicasEventos).values({
    bolsaId, accion, motivo: null, snapshot, usuarioId: ctx.userId, usuarioNombre: ctx.nombre,
  });
}

/** Traduce un 23505 al alta o edición: nombre (RN-T2) o cobertura (RN-T1). Fuera de la tx abortada. */
async function traducirDuplicado(
  e: unknown, nombre: string, organismos: string[], conceptos: string[], bolsaId?: string,
): Promise<unknown> {
  if (!esLlaveDuplicada(e)) return e;
  const ocupados = await paresOcupados(db, organismos, conceptos, bolsaId);
  if (ocupados.length > 0) return new CoberturaOcupadaError(ocupados);
  if (await nombreTomado(nombre, bolsaId)) return nombreEnUso(nombre);
  return new CoberturaOcupadaError([]);
}

/** AC1-AC2: alta de una bolsa de tránsito, activa, saldo 0 y cobertura = secretarías × conceptos. */
export async function crearBolsaTransitoUnica(datos: DatosBolsaTransitoUnica, ctx: CtxUsuario): Promise<string> {
  const { nombre, organismos, conceptos } = normalizarTransito(datos);
  if (await nombreTomado(nombre)) throw nombreEnUso(nombre);
  await exigirCoberturaLibre(db, organismos, conceptos);
  try {
    return await db.transaction(async (tx) => {
      const [bolsa] = await tx.insert(flitoBolsasUnicas)
        .values({ alcance: 'transito', nombre, saldo: '0', creadaPorId: ctx.userId })
        .returning({ id: flitoBolsasUnicas.id });
      await tx.insert(flitoBolsasUnicasCobertura).values(filasCobertura(bolsa!.id, organismos, conceptos, true));
      await evento(tx, bolsa!.id, 'crear', { alcance: 'transito', nombre, organismos, conceptos }, ctx);
      return bolsa!.id;
    });
  } catch (e) {
    throw await traducirDuplicado(e, nombre, organismos, conceptos);
  }
}

/** AC2-AC3: redefine nombre y cobertura de una bolsa de tránsito ACTIVA. El saldo no se toca (RN-T3). */
export async function editarBolsaTransitoUnica(bolsaId: string, datos: DatosBolsaTransitoUnica, ctx: CtxUsuario): Promise<void> {
  const { nombre, organismos, conceptos } = normalizarTransito(datos);
  try {
    await db.transaction(async (tx) => {
      const [bolsa] = await tx.select({
        alcance: flitoBolsasUnicas.alcance, activa: flitoBolsasUnicas.activa, nombre: flitoBolsasUnicas.nombre,
      }).from(flitoBolsasUnicas).where(eq(flitoBolsasUnicas.id, bolsaId)).for('update').limit(1);
      if (!bolsa) throw new BolsaError('La bolsa no existe', 404);
      if (bolsa.alcance !== 'transito') throw new BolsaError('La bolsa no es de tránsito', 400, CodigoErrorBolsa.DATOS_INVALIDOS);
      if (!bolsa.activa) throw new BolsaError(MSG_BOLSA_INACTIVA, 409, CodigoErrorBolsa.BOLSA_INACTIVA);
      if (await nombreTomado(nombre, bolsaId)) throw nombreEnUso(nombre);
      await exigirCoberturaLibre(tx, organismos, conceptos, bolsaId);
      const antes = await tx.select({ o: flitoBolsasUnicasCobertura.organismoCodigo, c: flitoBolsasUnicasCobertura.concepto })
        .from(flitoBolsasUnicasCobertura).where(eq(flitoBolsasUnicasCobertura.bolsaId, bolsaId));
      await tx.update(flitoBolsasUnicas).set({ nombre, updatedAt: new Date() }).where(eq(flitoBolsasUnicas.id, bolsaId));
      await tx.delete(flitoBolsasUnicasCobertura).where(eq(flitoBolsasUnicasCobertura.bolsaId, bolsaId));
      await tx.insert(flitoBolsasUnicasCobertura).values(filasCobertura(bolsaId, organismos, conceptos, true));
      await evento(tx, bolsaId, 'editar', {
        antes: {
          nombre: bolsa.nombre, organismos: [...new Set(antes.map((a) => a.o))].sort(),
          conceptos: [...new Set(antes.map((a) => a.c))].sort(),
        },
        despues: { nombre, organismos, conceptos },
      }, ctx);
    });
  } catch (e) {
    throw await traducirDuplicado(e, nombre, organismos, conceptos, bolsaId);
  }
}

// ─────────────────────────── Datos de tránsito del DTO único ──────────────────

/**
 * Nivel en la escala de tránsito, deuda y totales del libro de cada bolsa (lo que hoy da `GET /transito/:id`
 * con `BolsaTransitoConNivel`), en UNA consulta para todas. La regla es la de `flito-bolsas-transito.service.ts`.
 */
export async function datosTransitoDe(
  bolsas: Array<{ id: string; saldo: number; ultimaEntradaValor: number | null }>,
): Promise<Map<string, DatosBolsaTransitoDto>> {
  const salida = new Map<string, DatosBolsaTransitoDto>();
  if (bolsas.length === 0) return salida;
  const M = flitoBolsasUnicasMovimientos;
  const totales = await db.select({
    bolsaId: M.bolsaId,
    cargado: sql<string>`coalesce(sum(case when ${M.tipo} = 'entrada' then ${M.valor} else 0 end), 0)`,
    consumido: sql<string>`coalesce(sum(case when ${M.tipo} = 'salida' then ${M.valor} else 0 end), 0)`,
  }).from(M).where(inArray(M.bolsaId, bolsas.map((b) => b.id))).groupBy(M.bolsaId);
  const porBolsa = new Map(totales.map((t) => [t.bolsaId, t]));
  for (const b of bolsas) {
    const t = porBolsa.get(b.id);
    salida.set(b.id, {
      nivel: nivelBolsaTransitoDe(b.saldo, b.ultimaEntradaValor),
      deuda: deudaBolsaTransito(b.saldo),
      totalCargado: redondear(num(t?.cargado ?? '0')),
      totalConsumido: redondear(num(t?.consumido ?? '0')),
    });
  }
  return salida;
}

// ─────────────────────────── Autogestión (D15, AC9) ──────────────────────────

/** Parejas (secretaría, impuesto) de `cobertura` cuyo organismo es autogestionado HOY. */
export async function paresAutogestionados(
  cobertura: Array<{ organismoCodigo: string; concepto: string }>,
): Promise<CoberturaBolsaDto[]> {
  const conImpuesto = [...new Set(cobertura.filter((c) => c.concepto === 'impuesto').map((c) => c.organismoCodigo))];
  if (conImpuesto.length === 0) return [];
  const auto = new Set(await organismosAutogestionados(conImpuesto));
  return conImpuesto.filter((o) => auto.has(o)).sort().map((organismoCodigo) => ({ organismoCodigo, concepto: 'impuesto' }));
}

/**
 * Códigos (de `codigos`, o todos si no se pasa) cuya modalidad VIGENTE es autogestionado. La modalidad vive
 * en `flito_organismo_vigencias` (CA-04): la vigente es la de `hasta IS NULL`; sin vigencia = sin clasificar.
 */
export async function organismosAutogestionados(codigos?: string[]): Promise<string[]> {
  if (codigos && codigos.length === 0) return [];
  const V = flitoOrganismoVigencias;
  const filas = await db.select({ codigo: V.organismoCodigo }).from(V)
    .where(and(
      isNull(V.hasta), eq(V.modalidad, MODALIDAD_AUTOGESTIONADO),
      codigos ? inArray(V.organismoCodigo, codigos) : undefined,
    ))
    .orderBy(asc(V.organismoCodigo));
  return filas.map((f) => f.codigo);
}

// ─────────────────────────── Cierres (Q3, AC6-AC7) ───────────────────────────

const C = flitoBolsasUnicasCierres;

function aCierreDto(c: typeof C.$inferSelect): CierreBolsaTransitoDto {
  return {
    id: c.id, bolsaId: c.bolsaId, periodo: c.periodo,
    saldoInicial: num(c.saldoInicial), totalEntradas: num(c.totalEntradas), totalSalidas: num(c.totalSalidas),
    saldoFinal: num(c.saldoFinal), movimientos: c.movimientos, observaciones: c.observaciones,
    cerradoPorNombre: c.cerradoPorNombre, cerradoEn: c.cerradoEn ? new Date(c.cerradoEn).toISOString() : '',
  };
}

/** Cierres de una bolsa (por id), del más reciente al más antiguo. */
export async function cierresDeBolsa(bolsaId: string): Promise<CierreBolsaTransitoDto[]> {
  const filas = await db.select().from(C).where(eq(C.bolsaId, bolsaId)).orderBy(desc(C.periodo));
  return filas.map(aCierreDto);
}

const sumaDe = (tipo: 'entrada' | 'salida') =>
  sql<string>`coalesce(sum(case when ${flitoBolsasUnicasMovimientos.tipo} = ${tipo} then ${flitoBolsasUnicasMovimientos.valor} else 0 end), 0)`;

/**
 * AC6: cierra el periodo de una bolsa POR ID (misma regla que el cierre de compañía): solo un mes ya
 * cumplido, una vez (409 si ya está cerrado), saldo inicial = saldo final del cierre anterior. La bolsa se
 * bloquea mientras se cierra para que ningún movimiento entre entre el conteo y el INSERT. Inactiva: sí (Q7).
 */
export async function cerrarPeriodoDeBolsa(
  bolsaId: string, periodo: string, observaciones: string | null, ctx: CtxUsuario,
): Promise<CierreBolsaTransitoDto> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(periodo)) {
    throw new BolsaError('El periodo debe tener la forma AAAA-MM', 400, CodigoErrorBolsa.DATOS_INVALIDOS);
  }
  const enCurso = periodoDeFecha(hoyIso());
  if (periodo > enCurso) throw new BolsaError('No se puede cerrar un periodo futuro');
  if (periodo === enCurso) throw new BolsaError('El periodo en curso no ha terminado: solo se cierra un mes ya cumplido');

  try {
    return await db.transaction(async (tx) => {
      const bolsa = await bolsaBloqueadaPorId(tx, bolsaId);
      if (!bolsa) throw new BolsaError('La bolsa no existe', 404);
      const [ya] = await tx.select({ id: C.id }).from(C).where(and(eq(C.bolsaId, bolsaId), eq(C.periodo, periodo))).limit(1);
      if (ya) throw new BolsaError('El periodo ya está cerrado', 409);

      const [totales] = await tx
        .select({ entradas: sumaDe('entrada'), salidas: sumaDe('salida'), movimientos: sql<number>`count(*)::int` })
        .from(flitoBolsasUnicasMovimientos)
        .where(and(eq(flitoBolsasUnicasMovimientos.bolsaId, bolsaId), eq(flitoBolsasUnicasMovimientos.periodo, periodo)));
      const [previo] = await tx.select({ saldoFinal: C.saldoFinal }).from(C)
        .where(and(eq(C.bolsaId, bolsaId), lt(C.periodo, periodo))).orderBy(desc(C.periodo)).limit(1);

      const saldoInicial = previo ? num(previo.saldoFinal) : 0;
      const totalEntradas = redondear(num(totales?.entradas ?? '0'));
      const totalSalidas = redondear(num(totales?.salidas ?? '0'));
      const [fila] = await tx.insert(C).values({
        bolsaId, periodo,
        saldoInicial: String(saldoInicial), totalEntradas: String(totalEntradas), totalSalidas: String(totalSalidas),
        saldoFinal: String(redondear(saldoInicial + totalEntradas - totalSalidas)),
        movimientos: totales?.movimientos ?? 0,
        observaciones: observaciones?.trim() ? observaciones.trim() : null,
        cerradoPorId: ctx.userId, cerradoPorNombre: ctx.nombre.slice(0, 150),
      }).returning();
      return aCierreDto(fila!);
    });
  } catch (e) {
    // Carrera: otro cierre del mismo periodo confirmó primero (único por bolsa + periodo).
    if (esLlaveDuplicada(e)) throw new BolsaError('El periodo ya está cerrado', 409);
    throw e;
  }
}
