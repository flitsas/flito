// Torre de Control Gerencial (Épica #14590, B5) — Operativa › Equipo: cómo está repartido el trabajo del equipo.
//
// RN-TOR-EQ8 (B5-AC2, invariante): Q1/Q2/Q3 son los conjuntos `gestiones_funcionario_periodo`, `carga_funcionario` y
//   `fuera_ans_funcionario` contados con `contarConjuntos`; cada fila de «Por funcionario» agrupa por `usuario_id` el
//   MISMO fragmento (`fragmentoConjunto` + `dondeFragmento`), así que la celda == el `total` del detalle con el segmento
//   `funcionario` de esa fila, y la suma de las filas == la KPI.
// RN-TOR-EQ9 (UX B5, «no es un ranking»): las filas salen en orden ALFABÉTICO por nombre (es-CO, desempate por id),
//   nunca por cifra; solo los funcionarios con alguna cifra > 0; sin posiciones ni severidad por persona.
// RN-TOR-EQ10 (Ley 1581): del funcionario solo viaja `users.name` (dato interno del empleado); nunca el correo. Sin
//   `logPiiAccess` aquí: el tablero no proyecta datos del titular (las placas van por el detalle, que sí lo registra).
import { inArray, sql } from 'drizzle-orm';
import {
  CONJUNTO_POR_COLUMNA_EQUIPO, type ConjuntoEquipoTorreId, type FilaEquipoTorre, type TableroEquipoTorre,
} from '@operaciones/shared-types';
import { users } from '../../db/schema.js';
import { contarConjuntos, dondeFragmento, fragmentoConjunto, type Umbrales } from './flito-torre.conjuntos.js';
import { USUARIO_GESTION } from './flito-torre.equipo-sql.js';
import { enTorre, type Ejecutor } from './flito-torre.metricas.service.js';
import { destino, kpi } from './flito-torre.productos.service.js';
import { conCacheTablero, num, rangoTablero, type ContextoTablero } from './flito-torre.tablero-comun.js';
import { valoresUmbrales } from './flito-torre.umbrales.service.js';

type Columna = keyof typeof CONJUNTO_POR_COLUMNA_EQUIPO;
const COLUMNAS = Object.keys(CONJUNTO_POR_COLUMNA_EQUIPO) as Columna[];

/** RN-TOR-EQ8: el fragmento del conjunto agrupado por funcionario. */
async function porFuncionario(q: Ejecutor, ctx: ContextoTablero, u: Umbrales, c: ConjuntoEquipoTorreId): Promise<Map<number, number>> {
  const f = fragmentoConjunto(c, ctx, u);
  const filas = await q<{ u: number; n: number }>(sql`SELECT ${USUARIO_GESTION} AS u, count(*)::int AS n
    FROM ${f.desde} WHERE ${dondeFragmento(f)} GROUP BY 1`);
  return new Map(filas.map((r) => [num(r.u), num(r.n)]));
}

const plural = (n: number, uno: string, varios: string): string => `${n.toLocaleString('es-CO')} ${n === 1 ? uno : varios}`;

/** La frase guía de la pestaña (UX B5). */
export function fraseEquipo(funcionariosPeriodo: number, carga: number): string {
  if (!funcionariosPeriodo && !carga) return 'Nadie del equipo registró gestiones en el periodo ni tiene gestiones abiertas.';
  const periodo = funcionariosPeriodo
    ? `${plural(funcionariosPeriodo, 'funcionario registró', 'funcionarios registraron')} gestiones en el periodo`
    : 'Nadie del equipo registró gestiones en el periodo';
  const sujeto = funcionariosPeriodo ? (funcionariosPeriodo === 1 ? 'tiene' : 'tienen') : 'el equipo tiene';
  const hoy = carga ? `hoy ${sujeto} ${plural(carga, 'gestión abierta', 'gestiones abiertas')} a su cargo` : 'hoy no hay gestiones abiertas a cargo del equipo';
  return `${periodo}; ${hoy}.`;
}

/** `POST /tableros/operativa/equipo` (B5-AC2). Solo `torre.equipo.ver` (la ruta lo exige). */
export async function tableroEquipo(ctx: ContextoTablero): Promise<TableroEquipoTorre> {
  const rango = rangoTablero(ctx);
  const u = await valoresUmbrales();
  return conCacheTablero('equipo', ctx, () => enTorre(async (q) => {
    const k = await contarConjuntos(q, ctx, u, COLUMNAS.map((col) => ({ clave: col, conjunto: CONJUNTO_POR_COLUMNA_EQUIPO[col] })));
    const mapas = {} as Record<Columna, Map<number, number>>;
    for (const col of COLUMNAS) mapas[col] = await porFuncionario(q, ctx, u, CONJUNTO_POR_COLUMNA_EQUIPO[col]);
    const ids = [...new Set(COLUMNAS.flatMap((col) => [...mapas[col].keys()]))];
    const nombres = ids.length
      ? await q<{ id: number; name: string }>(sql`SELECT ${users.id} AS id, ${users.name} AS name FROM ${users} WHERE ${inArray(users.id, ids)}`)
      : [];
    const nombreDe = new Map(nombres.map((r) => [num(r.id), r.name]));
    const filas: FilaEquipoTorre[] = ids.map((id) => {
      const cifra = (col: Columna): number => mapas[col].get(id) ?? 0;
      const seg = [{ dimension: 'funcionario' as const, valores: [String(id)] }];
      return {
        funcionarioId: String(id), nombre: nombreDe.get(id) ?? 'Sin nombre',
        gestionesPeriodo: cifra('gestionesPeriodo'), cargaAbierta: cifra('cargaAbierta'), fueraAns: cifra('fueraAns'),
        destinos: Object.fromEntries(COLUMNAS.map((col) => [col, destino(cifra(col), CONJUNTO_POR_COLUMNA_EQUIPO[col], seg)])) as FilaEquipoTorre['destinos'],
      };
    }).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es-CO', { sensitivity: 'base' }) || Number(a.funcionarioId) - Number(b.funcionarioId));
    const conPeriodo = filas.filter((f) => f.gestionesPeriodo > 0).length;
    return {
      cifras: { funcionarios: filas.length, gestionesPeriodo: k.gestionesPeriodo!, cargaAbierta: k.cargaAbierta!, fueraAns: k.fueraAns! },
      frase: fraseEquipo(conPeriodo, k.cargaAbierta!),
      explicaciones: {
        gestionesPeriodo: kpi('gestiones_funcionario_periodo', k.gestionesPeriodo!, u),
        cargaAbierta: kpi('carga_funcionario', k.cargaAbierta!, u),
        fueraAns: kpi('fuera_ans_funcionario', k.fueraAns!, u),
      },
      porFuncionario: filas,
      rango: { desde: rango.desde, hasta: rango.hasta },
      generadoEn: new Date().toISOString(),
    };
  }));
}
