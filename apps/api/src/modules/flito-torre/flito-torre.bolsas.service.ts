// Torre de Control Gerencial (Épica #14590, B4) — Financiera › Bolsas: cobertura de las bolsas de compañía, agotadas,
// movimientos del periodo y el bloque de conciliación de boletas.
//
// RN-TOR-BO1 (B4-AC3, invariante): cada KPI y cada fila es un conjunto de `CONJUNTOS_TORRE` contado sobre el MISMO
//   fragmento que lista el detalle. «En crítico» = `bolsas_cobertura` con `severidad: critico`.
// RN-TOR-BO2 (= RN-TOR-LG6): la cobertura de cada bolsa (saldo, consumo de 30 días, días y semáforo) sale del SQL
//   (`flito-torre.logistica-sql.ts`); `filasBolsas` es la ÚNICA lectura, y la usan esta subvista, el Resumen (B1) y el
//   360°. Hay una bolsa de compañía por compañía (índice `uq_flito_bolsas_unicas_compania`): bolsa = compañía.
// RN-TOR-BO3: cada fila de cobertura abre sus movimientos del periodo (`movimientos_bolsa_periodo` + `bolsa:<uuid>`).
// RN-TOR-BO4 (dedupe, UX B6.2): `criticasConSaldo` = críticas que no están agotadas (las agotadas son críticas).
// RN-TOR-BO5: solo conteos y sumas por compañía (sin placa ni datos del titular): sin `logPiiAccess` (regla 16).
import { sql } from 'drizzle-orm';
import type {
  FilaCoberturaBolsaTorre, SegmentoDetalle, SeveridadTorre, TableroBolsas,
} from '@operaciones/shared-types';
import { contarConjuntos, dondeFragmento, fragmentoConjunto, totalFragmento, type Umbrales } from './flito-torre.conjuntos.js';
import { donde } from './flito-torre.filtro.js';
import {
  CONSUMO_30, DIAS_COBERTURA, DIAS_CONSUMO_BOLSA, BOLSA_DEL_MOVIMIENTO, TIPO_MOVIMIENTO, severidadBolsa,
} from './flito-torre.logistica-sql.js';
import { enTorre, nombresCompania, type Ejecutor } from './flito-torre.metricas.service.js';
import { destino, kpi } from './flito-torre.productos.service.js';
import { conCacheTablero, num, r1, rangoTablero, type ContextoTablero } from './flito-torre.tablero-comun.js';
import { valoresUmbrales } from './flito-torre.umbrales.service.js';
import { flitoBolsasUnicas } from '../../db/schema.js';

const COP = (n: number): string => `$${Math.round(n).toLocaleString('es-CO')}`;

export interface FilaBolsaSql {
  bolsaId: string; companiaId: number; compania: string; saldo: number; consumoDiario: number;
  diasCobertura: number | null; severidad: SeveridadTorre;
}

/** RN-TOR-BO2: todas las bolsas activas de compañía con su cobertura, ordenadas por días ↑ (sin consumo al final). */
export async function filasBolsas(q: Ejecutor, ctx: ContextoTablero, rojo: number, amarillo: number): Promise<FilaBolsaSql[]> {
  const u = { dias_cobertura_rojo: rojo, dias_cobertura_amarillo: amarillo } as Umbrales;
  // `bolsas_agotadas` comparte `desde` y `base` (grupo `bolsa_foto`): se toma SOLO la base = todas las activas.
  const f = fragmentoConjunto('bolsas_agotadas', ctx, u);
  const B = flitoBolsasUnicas;
  const filas = await q<{ id: string; cia: number; saldo: string; consumo: string; dias: string | null; sev: SeveridadTorre }>(sql`SELECT
      ${B.id}::text AS id, ${B.companiaId} AS cia, ${B.saldo} AS saldo, ${CONSUMO_30} AS consumo, ${DIAS_COBERTURA} AS dias,
      ${severidadBolsa(rojo, amarillo)} AS sev
    FROM ${f.desde} WHERE ${donde(f.base)}
    ORDER BY ${DIAS_COBERTURA} ASC NULLS LAST, ${B.companiaId} ASC`);
  const nombres = await nombresCompania(q, filas.map((x) => Number(x.cia)));
  return filas.map((x) => ({
    bolsaId: x.id, companiaId: Number(x.cia), compania: nombres.get(Number(x.cia)) ?? `Compañía ${x.cia}`,
    saldo: num(x.saldo), consumoDiario: r1(num(x.consumo) / DIAS_CONSUMO_BOLSA),
    diasCobertura: x.dias == null ? null : Number(x.dias), severidad: x.sev,
  }));
}

/** `POST /tableros/financiera/bolsas` (B4-AC3). */
export async function tableroBolsas(ctx: ContextoTablero): Promise<TableroBolsas> {
  const rango = rangoTablero(ctx);
  const u = await valoresUmbrales();
  return conCacheTablero('financiera-bolsas', ctx, () => enTorre(async (q) => {
    const critico: SegmentoDetalle[] = [{ dimension: 'severidad', valores: ['critico'] }];
    const atencion: SegmentoDetalle[] = [{ dimension: 'severidad', valores: ['atencion'] }];
    const k = await contarConjuntos(q, ctx, u, [
      { clave: 'critico', conjunto: 'bolsas_cobertura', segmentos: critico },
      { clave: 'atencion', conjunto: 'bolsas_cobertura', segmentos: atencion },
      { clave: 'agotadas', conjunto: 'bolsas_agotadas' },
      { clave: 'sinConciliar', conjunto: 'boletas_sin_conciliar' },
      { clave: 'conDiferencia', conjunto: 'boletas_con_diferencia' },
    ]);
    // Movimientos: total, por tipo (recargas/consumos, ⓡ) y por bolsa (el destino de cada fila de cobertura).
    const fm = fragmentoConjunto('movimientos_bolsa_periodo', ctx, u);
    const mov = await totalFragmento(q, fm);
    const porTipo = await q<{ t: string; n: number; v: string }>(sql`SELECT ${TIPO_MOVIMIENTO} AS t, count(*)::int AS n,
        COALESCE(sum(${fm.cols.valor!}), 0)::numeric AS v FROM ${fm.desde} WHERE ${dondeFragmento(fm)} GROUP BY 1`);
    const porBolsa = new Map((await q<{ b: string; n: number }>(sql`SELECT ${BOLSA_DEL_MOVIMIENTO} AS b, count(*)::int AS n
        FROM ${fm.desde} WHERE ${dondeFragmento(fm)} GROUP BY 1`)).map((x) => [x.b, num(x.n)]));
    const bolsas = await filasBolsas(q, ctx, u.dias_cobertura_rojo, u.dias_cobertura_amarillo);

    const tipo = (t: 'entrada' | 'salida') => porTipo.find((x) => x.t === t);
    const dinero = <T>(v: T): T | null => (ctx.dinero ? v : null);
    const filas: FilaCoberturaBolsaTorre[] = bolsas.map((b) => {
      const n = porBolsa.get(b.bolsaId) ?? 0;
      return {
        bolsaId: b.bolsaId, companiaId: b.companiaId, compania: b.compania, saldo: dinero(b.saldo), consumoDiario: dinero(b.consumoDiario),
        diasCobertura: b.diasCobertura, severidad: b.severidad, movimientos: n,
        destino: destino(n, 'movimientos_bolsa_periodo', [{ dimension: 'bolsa', valores: [b.bolsaId] }]),
      };
    });
    const cifras: TableroBolsas['cifras'] = {
      activas: bolsas.length, enCritico: k.critico!, enAtencion: k.atencion!, criticasConSaldo: k.critico! - k.agotadas!,
      agotadas: k.agotadas!, movimientosPeriodo: mov.total, recargas: num(tipo('entrada')?.n), consumos: num(tipo('salida')?.n),
      recargasValor: dinero(num(tipo('entrada')?.v)), consumosValor: dinero(num(tipo('salida')?.v)),
      boletasSinConciliar: k.sinConciliar!, boletasConDiferencia: k.conDiferencia!,
    };

    const masBaja = bolsas.find((b) => b.severidad === 'critico');
    const colaCritico = masBaja
      ? `La más baja, ${masBaja.compania} (${masBaja.diasCobertura ?? 0} días).${k.atencion ? ` ${k.atencion} más ${k.atencion === 1 ? 'está' : 'están'} en atención.` : ''}`
      : undefined;
    const agotadasNombres = bolsas.filter((b) => b.saldo <= 0).map((b) => b.compania);
    const colaAgotadas = agotadasNombres.length
      ? `${agotadasNombres.slice(0, 3).join(', ')}${agotadasNombres.length > 3 ? ` y ${agotadasNombres.length - 3} más` : ''}.` : undefined;
    const colaMov = ctx.dinero && mov.total > 0
      ? `${COP(cifras.recargasValor ?? 0)} en recargas y ${COP(cifras.consumosValor ?? 0)} en consumos.` : undefined;
    return {
      cifras,
      explicaciones: {
        enCritico: {
          ...kpi('bolsas_cobertura', k.critico!, u),
          frase: k.critico ? `${k.critico} ${k.critico === 1 ? 'bolsa alcanza' : 'bolsas alcanzan'} para menos de ${u.dias_cobertura_rojo} días al ritmo de los últimos 30. ${colaCritico ?? ''}`.trim()
            : `Ninguna bolsa está en crítico.${k.atencion ? ` ${k.atencion} ${k.atencion === 1 ? 'está' : 'están'} en atención.` : ''}`,
          destino: destino(k.critico!, 'bolsas_cobertura', critico),
          desglose: [
            { etiqueta: 'En atención', valor: k.atencion!, destino: destino(k.atencion!, 'bolsas_cobertura', atencion) },
            { etiqueta: 'Agotadas', valor: k.agotadas!, destino: destino(k.agotadas!, 'bolsas_agotadas') },
          ],
        },
        agotadas: kpi('bolsas_agotadas', k.agotadas!, u, { cola: colaAgotadas }),
        movimientosPeriodo: kpi('movimientos_bolsa_periodo', mov.total, u, {
          cola: colaMov,
          desglose: [{ etiqueta: 'Recargas', valor: cifras.recargas }, { etiqueta: 'Consumos', valor: cifras.consumos }],
        }),
        boletasSinConciliar: kpi('boletas_sin_conciliar', k.sinConciliar!, u),
        boletasConDiferencia: kpi('boletas_con_diferencia', k.conDiferencia!, u),
      },
      cobertura: {
        filtrosIgnorados: ['rango', 'organismos', 'departamentos', 'tiposTramite', 'flitEstados'],
        umbralCriticoDias: u.dias_cobertura_rojo, umbralAtencionDias: u.dias_cobertura_amarillo, filas,
      },
      rango: { desde: rango.desde, hasta: rango.hasta },
      dineroVisible: ctx.dinero,
      generadoEn: new Date().toISOString(),
    };
  }));
}
