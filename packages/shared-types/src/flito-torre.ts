// Torre de Control Gerencial (Épica #14590) — contrato entre la API (`/api/flito/torre`) y la web.
//
// Catálogo CERRADO de métricas: el cliente solo elige claves de `METRICAS_TORRE` y de las agrupaciones
// permitidas para cada una; ningún identificador SQL viaja desde el navegador. Las fechas de un rango
// son días calendario en hora de Bogotá (`YYYY-MM-DD`); la API las convierte a `[desde, hasta+1)`.
//
// Los umbrales configurables (`UMBRALES_TORRE`) viven en `flito_torre_umbrales` (migración 0303).
// Los operativos nacen con el ANS de la operación (`ANS_OPERATIVO`) para que la Torre y el tablero
// operativo no puedan discrepar el día uno.
import { ANS_OPERATIVO } from './flito-estados.js';

// ── Rango y filtro ───────────────────────────────────────────────────────────────────────────────

export const PRESETS_RANGO_TORRE = ['hoy', 'ayer', 'semana', 'mes', 'mes_anterior', 'trimestre', 'anio'] as const;
export type PresetRangoTorre = (typeof PRESETS_RANGO_TORRE)[number];

/** Un preset relativo a hoy (Bogotá) o un rango explícito de días calendario `YYYY-MM-DD`, ambos inclusive. */
export type RangoTorre = { preset: PresetRangoTorre } | { desde: string; hasta: string };

export interface FiltroTorre {
  rango: RangoTorre;
  companiaIds?: number[];
  /** Códigos DIVIPOLA del organismo de tránsito. */
  organismos?: string[];
  /** Códigos DANE de 2 dígitos (`DEPARTAMENTO_POR_CODIGO`). */
  departamentos?: string[];
  tiposTramite?: string[];
  flitEstados?: string[];
}

export const AGRUPACIONES_TORRE = [
  'dia', 'semana', 'mes', 'trimestre', 'compania', 'organismo', 'departamento', 'tipo_tramite', 'flit_estado',
] as const;
export type AgrupacionTorre = (typeof AGRUPACIONES_TORRE)[number];

const TEMPORALES = ['dia', 'semana', 'mes', 'trimestre'] as const satisfies readonly AgrupacionTorre[];
const DIMENSIONES = ['compania', 'organismo', 'departamento', 'tipo_tramite', 'flit_estado'] as const satisfies readonly AgrupacionTorre[];
const TODAS = [...TEMPORALES, ...DIMENSIONES] as const;

// ── Catálogo de métricas ─────────────────────────────────────────────────────────────────────────

export const UNIDADES_METRICA_TORRE = ['conteo', 'cop', 'horas', 'pct'] as const;
export type UnidadMetricaTorre = (typeof UNIDADES_METRICA_TORRE)[number];

export interface MetricaTorreDef {
  readonly id: string;
  readonly etiqueta: string;
  readonly unidad: UnidadMetricaTorre;
  readonly agrupacionesPermitidas: readonly AgrupacionTorre[];
  /**
   * Métrica de dinero: exige además la función `FUNCION_TORRE_DINERO` (decisión del humano, contract-first de la
   * Épica #14590). Lo decide el PERMISO del rol, no su código: un admin la quita desde Roles y permisos.
   */
  readonly requiereDinero: boolean;
}

/** Función que habilita las métricas con `requiereDinero` (sin ella, el motor responde 403). */
export const FUNCION_TORRE_DINERO = 'torre.metricas.dinero';

export const METRICAS_TORRE = [
  { id: 'tramites_creados', etiqueta: 'Trámites creados', unidad: 'conteo', agrupacionesPermitidas: TODAS, requiereDinero: false },
  { id: 'tramites_aprobados', etiqueta: 'Trámites aprobados', unidad: 'conteo', agrupacionesPermitidas: TODAS, requiereDinero: false },
  { id: 'tiempo_creacion_aprobacion', etiqueta: 'Tiempo de creación a aprobación', unidad: 'horas', agrupacionesPermitidas: TODAS, requiereDinero: false },
  { id: 'costo_logistica', etiqueta: 'Costo de logística', unidad: 'cop', agrupacionesPermitidas: TODAS, requiereDinero: true },
  { id: 'impuestos_pagados', etiqueta: 'Impuestos pagados', unidad: 'cop', agrupacionesPermitidas: TODAS, requiereDinero: true },
  { id: 'derechos_pagados', etiqueta: 'Derechos de tránsito pagados', unidad: 'cop', agrupacionesPermitidas: TODAS, requiereDinero: true },
  { id: 'ingreso_liquidado', etiqueta: 'Ingreso liquidado', unidad: 'cop', agrupacionesPermitidas: TODAS, requiereDinero: true },
  // Foto del momento: no tiene serie temporal, solo cortes por dimensión.
  { id: 'wip_activo', etiqueta: 'Trámites en curso', unidad: 'conteo', agrupacionesPermitidas: DIMENSIONES, requiereDinero: false },
  { id: 'tasa_aprobacion', etiqueta: 'Tasa de aprobación', unidad: 'pct', agrupacionesPermitidas: TODAS, requiereDinero: false },
  { id: 'sin_facturar', etiqueta: 'Aprobados sin facturar', unidad: 'conteo', agrupacionesPermitidas: DIMENSIONES, requiereDinero: true },
] as const satisfies readonly MetricaTorreDef[];

export type MetricaTorreId = (typeof METRICAS_TORRE)[number]['id'];
export const METRICAS_TORRE_IDS = METRICAS_TORRE.map((m) => m.id) as unknown as readonly [MetricaTorreId, ...MetricaTorreId[]];

export const metricaTorre = (id: MetricaTorreId): MetricaTorreDef => METRICAS_TORRE.find((m) => m.id === id)!;

export const esAgrupacionPermitida = (metrica: MetricaTorreId, agrupacion: AgrupacionTorre): boolean =>
  (metricaTorre(metrica).agrupacionesPermitidas as readonly string[]).includes(agrupacion);

// ── Topes de seguridad (también los aplica la API; la web los usa para avisar antes) ─────────────

export const TOPES_TORRE = {
  /** Ventana máxima de un rango. */
  MESES_RANGO_MAX: 24,
  /** Ventana máxima cuando se agrupa por día. */
  DIAS_RANGO_MAX_POR_DIA: 366,
  /** Filas que devuelve una consulta en pantalla. */
  FILAS_PANTALLA_MAX: 500,
  /** Filas de una exportación. */
  FILAS_EXPORTAR_MAX: 50_000,
} as const;

// ── Consulta y resultado ─────────────────────────────────────────────────────────────────────────

export interface ConsultaMetrica {
  metrica: MetricaTorreId;
  agrupacion?: AgrupacionTorre;
  filtro: FiltroTorre;
  /** ≤ `TOPES_TORRE.FILAS_PANTALLA_MAX`. */
  limite?: number;
}

export interface ResultadoMetrica {
  metrica: MetricaTorreId;
  unidad: UnidadMetricaTorre;
  total: {
    valor: number; n: number; mediana?: number; p90?: number; max?: number; lapsoHoras?: number;
    /** Solo en tiempos: el trámite que más tardó (la placa va en la respuesta, nunca en la URL). */
    maximo?: { placa: string | null; tramiteUuid: string } | null;
  };
  /** `participacion` es el % de la fila sobre `total.valor` (0–100; 0 si el total es 0). */
  filas: { clave: string; etiqueta: string; valor: number; n: number; participacion: number; mediana?: number; p90?: number; max?: number }[];
  /**
   * Qué fecha ancla la métrica y cuántos registros quedaron fuera por no tenerla. `nBaseSincronizacion`: cuántos
   * trámites contados usaron el `created_at` de la sincronización porque no tienen `fecha_creacion_flit`.
   */
  baseFecha: { campo: string; excluidosSinFecha: number; nBaseSincronizacion: number };
  /** Hay más grupos que `limite`: la pantalla muestra los primeros. */
  truncado: boolean;
  /** ISO 8601. */
  generadoEn: string;
}

// ── Ficha de placa (sin PII del comprador) ───────────────────────────────────────────────────────

export interface BloqueFichaTorre { estado: string; fecha?: string | null }

export interface FichaPlacaTorre {
  /** Para «Abrir trámite» (el uuid sí puede ir en el path). */
  tramiteUuid: string;
  placa: string;
  tipoTramite: string | null;
  /** VIN con solo los últimos caracteres visibles; nunca el VIN completo. */
  vinMascara: string | null;
  compania: { id: number | null; nombre: string | null };
  organismo: { codigo: string | null; nombre: string | null };
  flitEstado: string | null;
  fechaCreacion: string | null;
  fechaAprobacion: string | null;
  duracionHoras: number | null;
  baseFecha: { campo: string; conFallback: boolean };
  /** Fechas de los pasos de la `LineaAvance` (ISO o null si aún no ocurre). */
  pasos: { creado: string | null; radicado: string | null; aprobado: string | null; facturado: string | null };
  /** Historial `campo='flit_estado'`, del más antiguo al más reciente. `anterior` es el estado del que salió. */
  lineaTiempo: { estado: string; anterior: string | null; desde: string }[];
  soat: BloqueFichaTorre;
  impuesto: BloqueFichaTorre;
  derecho: BloqueFichaTorre;
  logistica: BloqueFichaTorre;
}

/**
 * Respuesta de `POST /flito/torre/placa/buscar`: 1 o N trámites, del más reciente al más antiguo. Si no hay
 * ninguno (o están fuera del alcance) la API responde 404 indistinto.
 */
export interface ResultadoBusquedaPlaca { placa: string; tramites: FichaPlacaTorre[] }

// ── Tableros (POST /flito/torre/tableros/<area> con `{ filtro }`) ────────────────────────────────

export type SeveridadTorre = 'ok' | 'atencion' | 'critico';

/** Metadatos de cada bloque: qué filtros de la barra NO aplica (para el subtítulo de la tarjeta). */
export interface MetaBloqueTorre { filtrosIgnorados: (keyof FiltroTorre)[] }

export interface SerieTorre { clave: string; etiqueta: string; valor: number }

interface BaseTablero {
  /** Rango resuelto en Bogotá (`YYYY-MM-DD`, ambos inclusive). */
  rango: { desde: string; hasta: string };
  /** `false` si el rol no tiene `FUNCION_TORRE_DINERO`: los campos de dinero vienen `null`. */
  dineroVisible: boolean;
  /** ISO 8601. */
  generadoEn: string;
}

export interface FugaClienteTorre {
  companiaId: number; compania: string;
  /** Trámites creados en los últimos `ventanaDias`. */
  tramitesVentana: number;
  /** Promedio de los 90 días anteriores, llevado a una ventana de `ventanaDias`. */
  promedio: number;
  /** Negativo = caída (p. ej. −38). */
  variacionPct: number;
}

export interface ParticipacionTorre { companiaId: number | null; compania: string; valor: number; pct: number }
export interface ConcentracionTorre {
  top: ParticipacionTorre[]; demas: { n: number; valor: number; pct: number };
  top3Pct: number; top5Pct: number; total: number;
}

export const LINEAS_VENTA_TORRE = ['tramites', 'soat', 'impuestos', 'derechos', 'logistica'] as const;
export type LineaVentaTorre = (typeof LINEAS_VENTA_TORRE)[number];
export type UsoLineaTorre = 'usa' | 'no_usa' | 'autogestiona';

export interface TableroComercial extends BaseTablero {
  cifras: {
    clientesEnCaida: number;
    concentracionTop3Pct: number; concentracionTop5Pct: number;
    conversionFacturadoPct: number;
    tramitesPeriodo: number; tramitesPeriodoAnterior: number;
    /** Creados por día del periodo (para el `Sparkline`). */
    sparkline: number[];
  };
  fuga: MetaBloqueTorre & { umbralPct: number; ventanaDias: number; filas: FugaClienteTorre[] };
  concentracion: MetaBloqueTorre & { volumen: ConcentracionTorre; ingreso: ConcentracionTorre | null };
  embudo: MetaBloqueTorre & { pasos: { paso: 'creados' | 'radicados' | 'aprobados' | 'facturados'; valor: number; pct: number }[] };
  /** Últimos 6 meses cerrados (mensual) y sus trimestres. No depende del rango. */
  tendencia: MetaBloqueTorre & { mensual: SerieTorre[]; trimestral: SerieTorre[] };
  /** Top 10 clientes por trámites del periodo. */
  ventaCruzada: MetaBloqueTorre & {
    filas: { companiaId: number; compania: string; tramites: number; lineas: Record<LineaVentaTorre, UsoLineaTorre> }[];
  };
}

export const CAUSAS_RADAR_TORRE = ['soat_sin_gestion', 'impuesto_sin_gestion', 'borrador_abandonado', 'estancado_ot'] as const;
export type CausaRadarTorre = (typeof CAUSAS_RADAR_TORRE)[number];

export interface TableroOperativo extends BaseTablero {
  cifras: { sinGestionFueraAns: number; borradoresAbandonados: number; wip: number; primerIntentoPct: number | null };
  radar: MetaBloqueTorre & {
    filas: { causa: CausaRadarTorre; etiqueta: string; cantidad: number; umbral: number; unidad: 'horas' | 'dias'; severidad: SeveridadTorre }[];
  };
  carga: MetaBloqueTorre & {
    porOrganismo: SerieTorre[];
    /** `null` si ningún trámite en curso tiene funcionario registrado (`enviado_por_id`). */
    porFuncionario: SerieTorre[] | null;
  };
  benchmarkOt: MetaBloqueTorre & {
    umbralDias: number;
    filas: {
      organismoCodigo: string | null; organismo: string; volumen: number; pctAprobado: number; pctRechazado: number;
      pendientes: number; medianaRespuestaDias: number | null; sobreUmbral: boolean;
    }[];
  };
  logistica: MetaBloqueTorre & {
    entregas: number; primerIntento: number; primerIntentoPct: number | null;
    /** Viajes con `numero >= 2`. */
    viajesAdicionales: number;
    tiempoMedioEntregaDias: number | null;
  };
}

export const SERVICIOS_MARGEN_TORRE = ['tramite', 'soat', 'impuestos', 'derechos', 'logistica'] as const;
export type ServicioMargenTorre = (typeof SERVICIOS_MARGEN_TORRE)[number];

export interface TableroFinanciero extends BaseTablero {
  cifras: {
    menorCobertura: { companiaId: number; compania: string; dias: number; severidad: SeveridadTorre } | null;
    sinFacturarValor: number | null; sinFacturarTramites: number;
    margenPct: number | null;
    soportesCompletosPct: number | null;
  };
  /** Saldo de hoy y consumo de los últimos 30 días; de menor a mayor cobertura. No depende del rango. */
  bolsas: MetaBloqueTorre & {
    umbralAtencionDias: number; umbralCriticoDias: number;
    filas: {
      companiaId: number; compania: string; saldo: number | null; consumoDiario: number | null;
      /** `null` si no hubo consumo en 30 días (cobertura indefinida); `0` con saldo ≤ 0 (agotada, siempre crítico). */
      diasCobertura: number | null; severidad: SeveridadTorre;
    }[];
  };
  sinFacturar: MetaBloqueTorre & {
    filas: { companiaId: number | null; compania: string; tramites: number; valorEstimado: number | null; masAntiguoDias: number }[];
  };
  /** `null` si el rol no ve dinero. `costo: null` + `sinCostoRegistrado` cuando FLITO no tiene el costo. */
  margen: (MetaBloqueTorre & {
    porServicio: { servicio: ServicioMargenTorre; cobrado: number; costo: number | null; sinCostoRegistrado: boolean }[];
    porCliente: { companiaId: number | null; compania: string; cobrado: number; costo: number; margenPct: number | null; sinCostoRegistrado: boolean }[];
  }) | null;
  conciliacion: MetaBloqueTorre & { completos: number; dos: number; uno: number; cero: number; total: number; pctCompletos: number | null };
}

export interface RiesgoTorre {
  area: 'comercial' | 'operativo' | 'financiero';
  frase: string;
  /** Texto corto del umbral («crítico 7 días»). */
  umbral: string;
  severidad: Exclude<SeveridadTorre, 'ok'>;
  /** Para ordenar dentro de la misma severidad: monto o volumen afectado. */
  impacto: number;
}

export interface TableroEjecutivo extends BaseTablero {
  comercial: { tramitesMes: number; clientesEnCaida: number };
  /** % de aprobados del mes dentro del ANS de respuesta (`dias_respuesta_ot` desde la creación). */
  operativo: { pctDentroAns: number | null; umbralDias: number };
  financiero: { margenPct: number | null; sinFacturarValor: number | null };
  /** Siempre el mes en curso (Bogotá), sin importar el rango. */
  proyeccion: {
    mes: string; diasTranscurridos: number; diasMes: number;
    /** Acumulado diario de aprobados (`dia` 1..N). */
    acumulado: { dia: number; valor: number }[];
    mesAnterior: { dia: number; valor: number }[];
    totalMesAnterior: number; proyeccionCierre: number;
    variacionPct: number | null;
    /** `null` si `meta_mensual_aprobados` es 0. */
    meta: number | null;
  };
  /** Top 5: críticos primero y luego por impacto. */
  riesgos: RiesgoTorre[];
}

// ── Umbrales configurables ───────────────────────────────────────────────────────────────────────

export const UNIDADES_UMBRAL_TORRE = ['dias', 'horas', 'porcentaje', 'cop', 'conteo'] as const;
export type UnidadUmbralTorre = (typeof UNIDADES_UMBRAL_TORRE)[number];

export const GRUPOS_UMBRAL_TORRE = ['operativo', 'comercial', 'financiero', 'general'] as const;
export type GrupoUmbralTorre = (typeof GRUPOS_UMBRAL_TORRE)[number];

export interface UmbralTorreDef {
  readonly clave: string;
  readonly grupo: GrupoUmbralTorre;
  readonly unidad: UnidadUmbralTorre;
  readonly valorPorDefecto: number;
  readonly descripcion: string;
}

/**
 * Catálogo de umbrales. La semilla de la migración 0303 debe coincidir con `valorPorDefecto`
 * (lo verifica `__tests__/services/flito-torre/flito-torre-umbrales.test.ts`).
 */
export const UMBRALES_TORRE = [
  { clave: 'horas_sin_gestion', grupo: 'operativo', unidad: 'horas', valorPorDefecto: ANS_OPERATIVO.SIN_GESTION_HORAS,
    descripcion: 'Horas sin gestión a partir de las cuales un trámite se marca en riesgo.' },
  { clave: 'dias_borrador_abandonado', grupo: 'operativo', unidad: 'dias', valorPorDefecto: ANS_OPERATIVO.BORRADOR_DIAS,
    descripcion: 'Días en borrador a partir de los cuales el trámite se considera abandonado.' },
  { clave: 'horas_soat_impuesto_sin_soporte', grupo: 'operativo', unidad: 'horas', valorPorDefecto: ANS_OPERATIVO.SIN_GESTION_HORAS,
    descripcion: 'Horas que un SOAT o un impuesto solicitado puede esperar sin soporte.' },
  { clave: 'dias_respuesta_ot', grupo: 'operativo', unidad: 'dias', valorPorDefecto: ANS_OPERATIVO.SIN_APROBAR_DIAS,
    descripcion: 'Días que el organismo de tránsito tiene para responder antes de que el trámite se marque atrasado.' },
  { clave: 'pct_caida_volumen', grupo: 'comercial', unidad: 'porcentaje', valorPorDefecto: 30,
    descripcion: 'Caída de volumen de una compañía frente a su promedio que dispara la alerta comercial.' },
  { clave: 'dias_ventana_fuga', grupo: 'comercial', unidad: 'dias', valorPorDefecto: 30,
    descripcion: 'Días sin trámites a partir de los cuales una compañía se considera en fuga.' },
  { clave: 'dias_cobertura_amarillo', grupo: 'financiero', unidad: 'dias', valorPorDefecto: 15,
    descripcion: 'Días de cobertura de saldo por debajo de los cuales la bolsa se pinta en ámbar.' },
  { clave: 'dias_cobertura_rojo', grupo: 'financiero', unidad: 'dias', valorPorDefecto: 7,
    descripcion: 'Días de cobertura de saldo por debajo de los cuales la bolsa se pinta en rojo.' },
  { clave: 'meta_mensual_aprobados', grupo: 'general', unidad: 'conteo', valorPorDefecto: 0,
    descripcion: 'Meta mensual de trámites aprobados. 0 significa sin meta.' },
] as const satisfies readonly UmbralTorreDef[];

export type ClaveUmbralTorre = (typeof UMBRALES_TORRE)[number]['clave'];
export const CLAVES_UMBRAL_TORRE = UMBRALES_TORRE.map((u) => u.clave) as unknown as readonly [ClaveUmbralTorre, ...ClaveUmbralTorre[]];

/** Máximo de un valor de umbral: `numeric(14,2)`. */
export const UMBRAL_TORRE_VALOR_MAX = 999_999_999_999.99;

export interface UmbralTorre {
  clave: string;
  valor: number;
  unidad: UnidadUmbralTorre;
  descripcion: string;
  actualizadoPor: { id: number; nombre: string | null } | null;
  /** ISO 8601. */
  actualizadoEn: string | null;
}

// ── Opciones de los filtros (GET /flito/torre/opciones) ──────────────────────────────────────────

/**
 * Opciones de la barra de filtros de la Torre, con el alcance del motor. Solo IDs y nombres (sin NIT ni PII).
 * `tiposTramite[].valor` y `flitEstados[].valor` son los valores REALES de `flito_tramites.tipo_tramite` /
 * `flit_estado` (lo que el motor compara en minúsculas): mandarlos tal cual en `FiltroTorre` filtra exacto.
 */
export interface OpcionesFiltroTorre {
  companias: { id: number; nombre: string }[];
  organismos: { codigo: string; nombre: string }[];
  tiposTramite: { valor: string; etiqueta: string }[];
  flitEstados: { valor: string; etiqueta: string }[];
}
