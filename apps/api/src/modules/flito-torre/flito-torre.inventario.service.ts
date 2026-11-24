// Torre de Control Gerencial (Épica #14590, B2) — Operativa › Inventario por estado y Operativa › Soportes.
//
// RN-TOR-I1 (B2-AC1, invariante): cada celda de la matriz es el conjunto `inventario_estado` con los segmentos
//   `flit_estado` + `tramo_antiguedad` (+ `organismo` si se eligió). La matriz agrupa por `claveAgrupacion` de esas
//   dos dimensiones sobre el MISMO fragmento (`fragmentoConjunto`), así que la celda y el `total` de su detalle no
//   pueden discrepar. Los totales de fila, columna y general son la suma de sus celdas y abren el mismo conjunto con
//   un segmento menos. El total general sin organismo es O3 «Trámites en curso» (`en_curso`, mismo universo).
// RN-TOR-I2 (▲, UX §6.2): una celda pasa el umbral si al menos uno de sus trámites pasa el umbral de SU estado:
//   Borrador → `BORRADOR_ABANDONADO(dias_borrador_abandonado)` (la regla única de RN-TRA-B1, la misma de
//   `borrador_abandonado` y de la alerta `borrador_5d`); «Entregado»/«Enviado a OT» → `ESTANCADO_OT(dias_respuesta_ot)`
//   (la de `estancado_ot`). Los demás estados no tienen umbral y no se marcan; los totales tampoco.
// RN-TOR-I3: tramos FIJOS (`TRAMOS_ANTIGUEDAD_TORRE`); el organismo se SUMA al filtro de la Torre (segmento), no lo
//   reemplaza. Es una foto de hoy: ignora el rango.
// RN-TOR-I4: filas en el orden del flujo del trámite (`ORDEN_FLUJO_ESTADOS`); los estados sin orden conocido, al final
//   por nombre.
// RN-TOR-I5 (B2-AC3): soportes = `soportes_aprobados` (aprobados del periodo) frente a `soportes_faltantes` (los que no
//   tienen 3/3) y, por soporte, `soportes_faltantes` + segmento `faltante`. Una consulta (mismo grupo de base).
// Sin datos del titular: solo conteos (ni `logPiiAccess` ni enmascarado); la lista va por el detalle universal.
import { sql } from 'drizzle-orm';
import {
  TRAMOS_ANTIGUEDAD_TORRE, VALORES_FALTANTE_SOPORTE, conjuntoTorre, definicionConUmbral, fraseDeConjunto,
  type CeldaInventarioTorre, type ClaveUmbralTorre, type FilaInventarioTorre, type InventarioEstadoTorre,
  type SegmentoDetalle, type SoportesFaltantesTorre, type TramoAntiguedadTorre,
} from '@operaciones/shared-types';
import { BORRADOR_ABANDONADO, ESTADOS_EN_OT, ESTANCADO_OT, DIMS_TRAMITE } from './flito-torre.catalogo.js';
import { contarConjuntos, dondeFragmento, fragmentoConjunto, type Umbrales } from './flito-torre.conjuntos.js';
import { claveAgrupacion } from './flito-torre.filtro.js';
import { aConjunto } from './flito-torre.frases.js';
import { enTorre, nombreOrganismo } from './flito-torre.metricas.service.js';
import { conCacheTablero, num, rangoTablero, type ContextoTablero } from './flito-torre.tablero-comun.js';
import { valoresUmbrales } from './flito-torre.umbrales.service.js';

/** RN-TOR-I4: Borrador → Enviado a OT → Asignado → Entregado (el ciclo de FLIT; Aprobado y los cerrados no están en curso). */
export const ORDEN_FLUJO_ESTADOS = ['borrador', 'enviado a ot', 'asignado', 'entregado'] as const;

const norm = (e: string | null): string => (e ?? '').trim().toLowerCase();
const TRAMOS = TRAMOS_ANTIGUEDAD_TORRE.map((t) => t.clave) as TramoAntiguedadTorre[];

/** RN-TOR-I2: umbral que marca la fila de un estado (`null` = sin umbral). */
export function umbralDeEstado(estado: string | null, u: Umbrales): { clave: ClaveUmbralTorre; valor: number } | null {
  const e = norm(estado);
  if (e === 'borrador') return { clave: 'dias_borrador_abandonado', valor: u.dias_borrador_abandonado };
  if (ESTADOS_EN_OT.includes(e)) return { clave: 'dias_respuesta_ot', valor: u.dias_respuesta_ot };
  return null;
}

function ordenEstados(a: string | null, b: string | null): number {
  const ia = (ORDEN_FLUJO_ESTADOS as readonly string[]).indexOf(norm(a));
  const ib = (ORDEN_FLUJO_ESTADOS as readonly string[]).indexOf(norm(b));
  if (ia !== ib) return (ia < 0 ? Infinity : ia) - (ib < 0 ? Infinity : ib);
  if (a == null || b == null) return a == null ? 1 : -1;
  return a.localeCompare(b, 'es');
}

const NINGUNO = { tipo: 'ninguno' } as const;
const celda = (n: number, sobreUmbral: boolean, segmentos: SegmentoDetalle[]): CeldaInventarioTorre =>
  ({ n, sobreUmbral: n > 0 && sobreUmbral, destino: n > 0 ? aConjunto('inventario_estado', segmentos) : NINGUNO });

const vacias = (): Record<TramoAntiguedadTorre, { n: number; s: number }> =>
  Object.fromEntries(TRAMOS.map((t) => [t, { n: 0, s: 0 }])) as Record<TramoAntiguedadTorre, { n: number; s: number }>;

/** `POST /tableros/operativa/inventario` (B2-AC1). `organismo` = código o `null` (todos). */
export async function inventarioEstado(ctx: ContextoTablero, organismo: string | null): Promise<InventarioEstadoTorre> {
  const u = await valoresUmbrales();
  return conCacheTablero(`operativa-inventario-${organismo ?? 'todos'}`, ctx, () => enTorre(async (q) => {
    const porOrganismo: SegmentoDetalle[] = organismo ? [{ dimension: 'organismo', valores: [organismo] }] : [];
    const f = fragmentoConjunto('inventario_estado', ctx, u, porOrganismo);
    const estadoK = claveAgrupacion('flit_estado', DIMS_TRAMITE, undefined);
    const tramoK = claveAgrupacion('tramo_antiguedad', DIMS_TRAMITE, undefined);
    const sobre = sql`(${BORRADOR_ABANDONADO(u.dias_borrador_abandonado)} OR ${ESTANCADO_OT(u.dias_respuesta_ot)})`;
    const [grupos, orgs] = await Promise.all([
      q<{ e: string | null; t: TramoAntiguedadTorre; n: number; s: number }>(sql`SELECT ${estadoK} AS e, ${tramoK} AS t,
          count(*)::int AS n, count(*) FILTER (WHERE ${sobre})::int AS s
        FROM ${f.desde} WHERE ${dondeFragmento(f)} GROUP BY 1, 2`),
      // Opciones del selector: el filtro de la Torre SIN el organismo elegido.
      (() => {
        const g = fragmentoConjunto('inventario_estado', ctx, u);
        const orgK = claveAgrupacion('organismo', DIMS_TRAMITE, undefined);
        return q<{ k: string }>(sql`SELECT DISTINCT ${orgK} AS k FROM ${g.desde}
          WHERE ${dondeFragmento(g)} AND ${orgK} IS NOT NULL ORDER BY 1`);
      })(),
    ]);

    const porEstado = new Map<string | null, ReturnType<typeof vacias>>();
    for (const r of grupos) {
      const fila = porEstado.get(r.e) ?? vacias();
      fila[r.t] = { n: num(r.n), s: num(r.s) };
      porEstado.set(r.e, fila);
    }
    const segEstado = (e: string | null): SegmentoDetalle => ({ dimension: 'flit_estado', valores: [e] });
    const segTramo = (t: TramoAntiguedadTorre): SegmentoDetalle => ({ dimension: 'tramo_antiguedad', valores: [t] });
    const columnas = vacias();

    const filas: FilaInventarioTorre[] = [...porEstado.keys()].sort(ordenEstados).map((e) => {
      const cuentas = porEstado.get(e)!;
      const umbral = umbralDeEstado(e, u);
      const celdas = Object.fromEntries(TRAMOS.map((t) => {
        columnas[t].n += cuentas[t].n;
        return [t, celda(cuentas[t].n, umbral != null && cuentas[t].s > 0, [segEstado(e), segTramo(t), ...porOrganismo])];
      })) as Record<TramoAntiguedadTorre, CeldaInventarioTorre>;
      const n = TRAMOS.reduce((a, t) => a + cuentas[t].n, 0);
      return { estado: e, etiqueta: e ?? 'Sin estado', umbral, celdas, total: celda(n, false, [segEstado(e), ...porOrganismo]) };
    });
    const general = TRAMOS.reduce((a, t) => a + columnas[t].n, 0);
    const def = conjuntoTorre('inventario_estado');

    return {
      tramos: TRAMOS_ANTIGUEDAD_TORRE.map((t) => ({ clave: t.clave, etiqueta: t.etiqueta })),
      filas,
      totales: {
        celdas: Object.fromEntries(TRAMOS.map((t) => [t, celda(columnas[t].n, false, [segTramo(t), ...porOrganismo])])) as Record<TramoAntiguedadTorre, CeldaInventarioTorre>,
        total: celda(general, false, porOrganismo),
      },
      organismo,
      organismos: orgs.map((o) => ({ codigo: o.k, nombre: nombreOrganismo(o.k) })),
      frase: general === 0 ? def.fraseVacio
        : `${general.toLocaleString('es-CO')} ${general === 1 ? 'trámite en curso' : 'trámites en curso'} hoy, por estado y por días en ese estado.`,
      definicion: def.definicion,
      leyendaUmbral: `▲ Pasa el umbral de ese estado (Borrador: ${u.dias_borrador_abandonado} días; en el organismo: ${u.dias_respuesta_ot} días).`,
      generadoEn: new Date().toISOString(),
    };
  }));
}

const ETIQUETA_FALTANTE: Record<(typeof VALORES_FALTANTE_SOPORTE)[number], string> = {
  soat: 'Sin SOAT', impuesto: 'Sin impuesto', derecho: 'Sin derecho',
};

/** `POST /tableros/operativa/soportes` (B2-AC3): aprobados del periodo sin SOAT, impuesto o derecho. */
export async function soportesFaltantes(ctx: ContextoTablero): Promise<SoportesFaltantesTorre> {
  const rango = rangoTablero(ctx);
  const u = await valoresUmbrales();
  return conCacheTablero('operativa-soportes', ctx, () => enTorre(async (q) => {
    const seg = (v: string): SegmentoDetalle[] => [{ dimension: 'faltante', valores: [v] }];
    const k = await contarConjuntos(q, ctx, u, [
      { clave: 'aprobados', conjunto: 'soportes_aprobados' },
      { clave: 'incompletos', conjunto: 'soportes_faltantes' },
      ...VALORES_FALTANTE_SOPORTE.map((v) => ({ clave: v, conjunto: 'soportes_faltantes' as const, segmentos: seg(v) })),
    ]);
    const def = conjuntoTorre('soportes_faltantes');
    const destino = (n: number, segmentos?: SegmentoDetalle[]) => (n > 0 ? aConjunto('soportes_faltantes', segmentos) : NINGUNO);
    return {
      aprobados: k.aprobados!,
      incompletos: { n: k.incompletos!, destino: destino(k.incompletos!) },
      porFaltante: VALORES_FALTANTE_SOPORTE.map((v) => ({ faltante: v, etiqueta: ETIQUETA_FALTANTE[v], n: k[v]!, destino: destino(k[v]!, seg(v)) })),
      frase: fraseDeConjunto(def, k.incompletos!),
      definicion: definicionConUmbral(def),
      rango: { desde: rango.desde, hasta: rango.hasta },
      generadoEn: new Date().toISOString(),
    };
  }));
}

