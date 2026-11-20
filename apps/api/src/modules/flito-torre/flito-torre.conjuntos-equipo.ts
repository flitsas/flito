// Torre de Control Gerencial (Épica #14590, B5) — los CONJUNTOS de Operativa › Equipo (entidad `funcionario`).
//
// Entran en `CONJUNTOS_SQL` (`flito-torre.conjuntos.ts`) y se cuentan y listan con el mismo `contarConjuntos` /
// `totalFragmento` / `listarFragmento`. Las reglas (RN-TOR-EQ1..EQ6) están en `flito-torre.equipo-sql.ts`.
// RN-TOR-EQ7: el segmento `funcionario` filtra por `users.id` sobre el MISMO fragmento; la tabla «Por funcionario» del
//   tablero agrupa ese fragmento por la misma columna, así que cada fila es igual al `total` de su detalle.
// Solo importa TIPOS de `flito-torre.conjuntos.ts` (que importa este archivo como valor): sin ciclo al cargar.
import type { SQL } from 'drizzle-orm';
import { conjuntoTorre, type ConjuntoEquipoTorreId } from '@operaciones/shared-types';
import type { ConjuntoSql } from './flito-torre.conjuntos.js';
import {
  CON_AUTOR, COLS_CARGA, COLS_EVENTO, DESDE_CARGA, DESDE_GESTIONES, DIMS_GESTION, FECHA_GESTION, FUNCIONARIO_GESTION, ID_GESTION,
  ID_REGISTRO, TRAMITE_GESTION, fueraDeAns,
} from './flito-torre.equipo-sql.js';
import { condicionesTorre, type FechaBase, type RangoResuelto } from './flito-torre.filtro.js';
import type { ContextoTablero } from './flito-torre.tablero-comun.js';

/** RN-TOR-EQ6: compañía y alcance; sin los filtros que el catálogo declara en `filtrosIgnorados`. */
const baseDe = (id: ConjuntoEquipoTorreId, fecha?: FechaBase) =>
  (ctx: ContextoTablero, rango: RangoResuelto | null): SQL[] =>
    condicionesTorre(ctx.filtro, ctx.alcance, DIMS_GESTION, { rango, fecha, ignorar: conjuntoTorre(id).filtrosIgnorados });

const comun = { entidad: 'funcionario', tabla: 'flito_estado_historial', dims: DIMS_GESTION, tramiteId: TRAMITE_GESTION,
  dimensiones: { funcionario: FUNCIONARIO_GESTION } } as const;

export const CONJUNTOS_EQUIPO_SQL: Record<ConjuntoEquipoTorreId, ConjuntoSql> = {
  gestiones_funcionario_periodo: {
    ...comun, grupo: 'equipo_periodo', desde: DESDE_GESTIONES, base: baseDe('gestiones_funcionario_periodo', FECHA_GESTION),
    propia: () => [CON_AUTOR], fecha: FECHA_GESTION, campoFecha: 'fecha de la gestión', id: ID_GESTION, cols: COLS_EVENTO,
  },
  carga_funcionario: {
    ...comun, grupo: 'equipo_foto', desde: DESDE_CARGA, base: baseDe('carga_funcionario'),
    propia: () => [CON_AUTOR], campoFecha: 'último movimiento', id: ID_REGISTRO, cols: COLS_CARGA,
  },
  fuera_ans_funcionario: {
    ...comun, grupo: 'equipo_foto', desde: DESDE_CARGA, base: baseDe('fuera_ans_funcionario'),
    propia: (u) => [CON_AUTOR, fueraDeAns(u.horas_soat_impuesto_sin_soporte, u.dias_traslado_abierto)],
    campoFecha: 'último movimiento', id: ID_REGISTRO, cols: COLS_CARGA,
  },
};
