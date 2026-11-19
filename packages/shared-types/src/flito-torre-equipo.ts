// Torre de Control Gerencial (Épica #14590, B5) — Operativa › EQUIPO: cómo está repartido el trabajo del equipo.
//
// Solo lo ven `gerencia_general` y `admin` (decisión del humano, 2026-11-19), con la operación `torre.equipo.ver`.
// No es un ranking (UX B5): la tabla abre en orden alfabético, sin posiciones, sin color por persona y sin Excel en v1.
// Ley 1581: del funcionario solo viaja su nombre (`users.name`, dato interno del empleado); nunca su correo
// (`usuario_email` de `flito_estado_historial` no se proyecta en ninguna parte). Del titular, como en todo el detalle,
// solo la placa (con `logPiiAccess`).
//
// Los conjuntos de este archivo entran en `CONJUNTOS_TORRE` (`flito-torre-detalle.ts`). El segmento `funcionario` es
// el id del usuario (opaco); la dimensión NO entra en `AGRUPACIONES_TORRE`: el Explorador no agrupa por persona.
//
// Solo imports de TIPO desde `flito-torre-detalle.ts` (que importa este archivo como valor): sin ciclo al cargar.
import type { ConjuntoTorreDef, DestinoCifra, ExplicacionesTablero } from './flito-torre-detalle.js';

/** La operación de la pestaña Equipo (y función de origen de sus conjuntos). */
export const FUNCION_EQUIPO_TORRE = 'torre.equipo.ver';

const EQUIPO = FUNCION_EQUIPO_TORRE;
/** Las gestiones solo tienen compañía (la del trámite, el SOAT, el impuesto, el derecho o el traslado). */
const FOTO_SOLO_COMPANIA = ['rango', 'organismos', 'departamentos', 'tiposTramite', 'flitEstados'] as const;
const PERIODO_SOLO_COMPANIA = ['organismos', 'departamentos', 'tiposTramite', 'flitEstados'] as const;

const COLS_GESTION = [
  'placa', 'codigo_flit', 'que_se_gestiono', 'compania', 'estado', 'funcionario', 'ultimo_movimiento', 'horas_desde_movimiento',
] as const;
const COLS_EVENTO = ['placa', 'codigo_flit', 'que_se_gestiono', 'compania', 'estado', 'funcionario', 'gestionado_en'] as const;

export const CONJUNTOS_EQUIPO_TORRE = [
  {
    id: 'gestiones_funcionario_periodo', entidad: 'funcionario', etiqueta: 'Gestiones del periodo',
    definicion: 'Cambios de estado y gestiones de SOAT, impuesto, derecho, traslado y solicitudes incompletas que registró cada funcionario dentro del periodo elegido. Cuenta cada gestión registrada (un mismo trámite puede sumar varias).',
    fechaBase: 'creacion', filtrosIgnorados: PERIODO_SOLO_COMPANIA, columnas: [...COLS_EVENTO],
    ordenDefecto: { columna: 'gestionado_en', dir: 'desc' }, segmentosAdmitidos: ['funcionario', 'compania'],
    frase: 'El equipo registró {n} {gestión|gestiones} en el periodo', fraseVacio: 'No se registraron gestiones en el periodo.',
    requiereDinero: false, funcionesOrigen: [EQUIPO],
  },
  {
    id: 'carga_funcionario', entidad: 'funcionario', etiqueta: 'Carga abierta',
    definicion: 'Gestiones que siguen abiertas (trámites en curso, SOAT e impuestos sin pagar y traslados registrados o en camino), asignadas al funcionario que las movió por última vez. No depende del periodo.',
    fechaBase: null, filtrosIgnorados: FOTO_SOLO_COMPANIA, columnas: [...COLS_GESTION],
    ordenDefecto: { columna: 'horas_desde_movimiento', dir: 'desc' }, segmentosAdmitidos: ['funcionario', 'compania'],
    frase: 'Hay {n} {gestión abierta|gestiones abiertas} cuyo último movimiento lo hizo alguien del equipo',
    fraseVacio: 'No hay gestiones abiertas a cargo del equipo.',
    requiereDinero: false, funcionesOrigen: [EQUIPO],
  },
  {
    id: 'fuera_ans_funcionario', entidad: 'funcionario', etiqueta: 'Pendientes fuera de ANS',
    definicion: 'Gestiones abiertas cuyo último movimiento hizo un funcionario y que pasan su ANS contado desde ese movimiento: 2 días para un trámite (el ANS operativo de aprobación), {umbral} horas para un SOAT o un impuesto y, para un traslado, los días de traslado abierto. Los dos últimos se cambian en Umbrales y alertas. No depende del periodo.',
    fechaBase: null, filtrosIgnorados: FOTO_SOLO_COMPANIA, columnas: [...COLS_GESTION],
    ordenDefecto: { columna: 'horas_desde_movimiento', dir: 'desc' }, segmentosAdmitidos: ['funcionario', 'compania'],
    frase: '{n} de esas gestiones abiertas ya {pasó|pasaron} su ANS', fraseVacio: 'Ninguna gestión abierta está fuera de ANS.',
    requiereDinero: false, funcionesOrigen: [EQUIPO], umbral: 'horas_soat_impuesto_sin_soporte',
  },
] as const satisfies readonly ConjuntoTorreDef[];

export type ConjuntoEquipoTorreId = (typeof CONJUNTOS_EQUIPO_TORRE)[number]['id'];

/** Una fila de «Por funcionario». Solo salen los que tienen alguna cifra > 0; orden alfabético por nombre. */
export interface FilaEquipoTorre {
  /** `users.id`: el valor del segmento `funcionario` del destino (opaco). */
  funcionarioId: string;
  /** `users.name`. Nunca el correo. */
  nombre: string;
  gestionesPeriodo: number;
  cargaAbierta: number;
  fueraAns: number;
  /**
   * El detalle de cada cifra: `CONJUNTO_POR_COLUMNA_EQUIPO[columna]` con `segmentos: [{ dimension: 'funcionario',
   * valores: [funcionarioId] }]`; en 0, `{ tipo: 'ninguno' }` (la celda muestra «—» y no se pulsa).
   */
  destinos: Record<'gestionesPeriodo' | 'cargaAbierta' | 'fueraAns', DestinoCifra>;
}

/** `POST /api/flito/torre/tableros/operativa/equipo` (B5-AC2). Sin `/exportar` en v1 (UX B5). */
export interface TableroEquipoTorre {
  cifras: {
    /** Funcionarios con alguna cifra > 0 (= filas de `porFuncionario`). */
    funcionarios: number;
    gestionesPeriodo: number;
    cargaAbierta: number;
    fueraAns: number;
  };
  /** La frase guía: «14 funcionarios registraron gestiones en el periodo; hoy tienen 286 gestiones abiertas a su cargo.» */
  frase: string;
  explicaciones: ExplicacionesTablero<Omit<TableroEquipoTorre['cifras'], 'funcionarios'>>;
  /** Orden alfabético por nombre (es-CO), nunca por cifra. */
  porFuncionario: FilaEquipoTorre[];
  rango: { desde: string; hasta: string };
  generadoEn: string;
}

/** Qué conjunto abre cada columna de la tabla. */
export const CONJUNTO_POR_COLUMNA_EQUIPO: Readonly<Record<'gestionesPeriodo' | 'cargaAbierta' | 'fueraAns', ConjuntoEquipoTorreId>> = {
  gestionesPeriodo: 'gestiones_funcionario_periodo', cargaAbierta: 'carga_funcionario', fueraAns: 'fuera_ans_funcionario',
};
