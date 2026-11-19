// Torre de Control Gerencial (Épica #14590, B3) — área PRODUCTOS: SOAT, impuestos y derechos de tránsito.
//
// Los conjuntos de esta área (`CONJUNTOS_PRODUCTOS_TORRE`) entran en `CONJUNTOS_TORRE` (`flito-torre-detalle.ts`):
// misma regla (definición, frase y frase en 0 escritas UNA vez; la cifra del tablero y el `total` del detalle salen del
// mismo fragmento SQL). Viven aquí para que el catálogo de B1 no pase de 800 líneas.
// Sin datos del titular: las columnas son placa, compañía, estado, fechas y valores. La póliza va SOLO con sus 4
// últimos (`poliza_ultimos`), nunca la dirección del impuesto ni el VIN. `soat_masivo` no tiene detalle de fila.
//
// Solo imports de TIPO desde `flito-torre-detalle.ts` (que importa este archivo como valor): sin ciclo al cargar.
import type { ConjuntoTorreDef, ConjuntoTorreId, DestinoCifra, ExplicacionesTablero } from './flito-torre-detalle.js';
import type { FiltroTorre } from './flito-torre.js';

/** La operación del tablero de Productos (y función de origen de sus conjuntos). */
export const FUNCION_TABLERO_PRODUCTOS_TORRE = 'torre.tablero_productos.ver';

const PRODUCTOS = FUNCION_TABLERO_PRODUCTOS_TORRE;
const FOTO = ['rango'] as const;
/** Pendientes de derechos: no tienen compañía ni trámite; solo cuentan la secretaría (y el alcance). */
const SOLO_ORGANISMO = ['rango', 'companiaIds', 'departamentos', 'tiposTramite', 'flitEstados'] as const;
/** Incompletas de SOAT: tienen compañía, pero ni secretaría ni trámite. */
const SOLO_COMPANIA = ['rango', 'organismos', 'departamentos', 'tiposTramite', 'flitEstados'] as const;
const COLS_SOAT = ['codigo_flit', 'placa', 'compania', 'organismo', 'estado', 'creado_en'] as const;
const COLS_IMPUESTO = ['codigo_flit', 'placa', 'compania', 'organismo', 'estado', 'creado_en'] as const;
const COLS_DERECHO = ['codigo_flit', 'placa', 'compania', 'organismo', 'creado_en', 'fecha_pago', 'valor'] as const;

export const CONJUNTOS_PRODUCTOS_TORRE = [
  // ── SOAT ──
  {
    id: 'soat_por_estado', entidad: 'gestion_soat', etiqueta: 'SOAT por estado',
    definicion: 'Gestiones de SOAT creadas en el periodo elegido, por su estado actual (pendiente, solicitado, con novedad o pagado), con los filtros de arriba. El valor es lo pagado por la póliza.',
    fechaBase: 'creacion', filtrosIgnorados: [], columnas: [...COLS_SOAT, 'pagado_en', 'valor'],
    ordenDefecto: { columna: 'creado_en', dir: 'desc' }, segmentosAdmitidos: ['estado', 'compania', 'organismo'],
    frase: '{n} {gestión de SOAT creada|gestiones de SOAT creadas} en el periodo', fraseVacio: 'No se crearon gestiones de SOAT en el periodo.',
    requiereDinero: false, funcionesOrigen: [PRODUCTOS],
  },
  {
    id: 'soat_por_vencer', entidad: 'gestion_soat', etiqueta: 'SOAT por vencer',
    definicion: 'SOAT pagados cuya póliza, según el RUNT, vence entre hoy y los próximos {umbral} días. Solo cuentan los que el RUNT ya verificó con fecha de vencimiento. El umbral se cambia en Umbrales y alertas. Es la foto de hoy: no depende del periodo.',
    fechaBase: null, filtrosIgnorados: FOTO, columnas: [...COLS_SOAT, 'poliza_ultimos', 'vence_el', 'dias_para_vencer'],
    ordenDefecto: { columna: 'vence_el', dir: 'asc' }, segmentosAdmitidos: ['compania', 'organismo', 'severidad'],
    frase: '{n} {SOAT vence|SOAT vencen} en los próximos {umbral} días', fraseVacio: 'Ningún SOAT vence en los próximos {umbral} días.',
    requiereDinero: false, funcionesOrigen: [PRODUCTOS], umbral: 'dias_soat_por_vencer',
  },
  {
    id: 'soat_vigencia_no_verificada', entidad: 'gestion_soat', etiqueta: 'SOAT sin verificar en el RUNT',
    definicion: 'SOAT pagados de los que no consta ninguna respuesta del RUNT sobre su vigencia: no se sabe si la póliza sigue vigente ni cuándo vence. Es la foto de hoy: no depende del periodo.',
    fechaBase: null, filtrosIgnorados: FOTO, columnas: [...COLS_SOAT, 'pagado_en', 'estado_vigencia'],
    ordenDefecto: { columna: 'pagado_en', dir: 'asc' }, segmentosAdmitidos: ['compania', 'organismo'],
    frase: '{n} {SOAT pagado no tiene|SOAT pagados no tienen} su vigencia verificada en el RUNT', fraseVacio: 'Todos los SOAT pagados tienen su vigencia verificada en el RUNT.',
    requiereDinero: false, funcionesOrigen: [PRODUCTOS],
  },
  {
    id: 'soat_pagados_periodo', entidad: 'gestion_soat', etiqueta: 'SOAT pagados',
    definicion: 'Gestiones de SOAT cuya fecha de pago cae en el periodo elegido, con los filtros de arriba. El valor es lo pagado por la póliza.',
    fechaBase: 'pago', filtrosIgnorados: [], columnas: [...COLS_SOAT, 'poliza_ultimos', 'pagado_en', 'valor'],
    ordenDefecto: { columna: 'pagado_en', dir: 'desc' }, segmentosAdmitidos: ['compania', 'organismo'],
    frase: '{n} {SOAT pagado|SOAT pagados} en el periodo', fraseVacio: 'No se pagaron SOAT en el periodo.',
    requiereDinero: false, funcionesOrigen: [PRODUCTOS],
  },
  {
    id: 'soat_incompletas_abiertas', entidad: 'soat_incompleta', etiqueta: 'Solicitudes de SOAT incompletas',
    definicion: 'Solicitudes de SOAT del canal Cliente que siguen aparcadas porque el RUNT no respondió (no son un SOAT todavía), por su motivo. Es la foto de hoy: no depende del periodo.',
    fechaBase: null, filtrosIgnorados: SOLO_COMPANIA, columnas: ['placa', 'compania', 'estado', 'motivo', 'solicitado_en', 'intentos'],
    ordenDefecto: { columna: 'solicitado_en', dir: 'asc' }, segmentosAdmitidos: ['motivo', 'compania'],
    frase: '{n} {solicitud de SOAT sigue incompleta|solicitudes de SOAT siguen incompletas}', fraseVacio: 'No hay solicitudes de SOAT incompletas.',
    requiereDinero: false, funcionesOrigen: [PRODUCTOS],
  },
  // ── Impuestos ──
  {
    id: 'impuestos_por_estado', entidad: 'impuesto', etiqueta: 'Impuestos por estado',
    definicion: 'Gestiones de impuesto creadas en el periodo elegido, por su estado actual (pendiente, solicitado, con novedad o pagado), con los filtros de arriba. El valor es lo pagado.',
    fechaBase: 'creacion', filtrosIgnorados: [], columnas: [...COLS_IMPUESTO, 'pagado_en', 'valor'],
    ordenDefecto: { columna: 'creado_en', dir: 'desc' }, segmentosAdmitidos: ['estado', 'compania', 'organismo'],
    frase: '{n} {gestión de impuesto creada|gestiones de impuesto creadas} en el periodo', fraseVacio: 'No se crearon gestiones de impuesto en el periodo.',
    requiereDinero: false, funcionesOrigen: [PRODUCTOS],
  },
  {
    id: 'impuestos_rechazados_periodo', entidad: 'impuesto', etiqueta: 'Impuestos con novedad',
    definicion: 'Gestiones de impuesto creadas en el periodo elegido que están en «Con novedad» (devueltas con un motivo de rechazo), por su motivo, con los filtros de arriba.',
    fechaBase: 'creacion', filtrosIgnorados: [], columnas: [...COLS_IMPUESTO, 'motivo'],
    ordenDefecto: { columna: 'creado_en', dir: 'desc' }, segmentosAdmitidos: ['motivo', 'compania', 'organismo'],
    frase: '{n} {gestión de impuesto creada en el periodo está|gestiones de impuesto creadas en el periodo están} con novedad', fraseVacio: 'Ninguna gestión de impuesto creada en el periodo tiene novedad.',
    requiereDinero: false, funcionesOrigen: [PRODUCTOS],
  },
  {
    id: 'impuestos_con_diferencia', entidad: 'impuesto', etiqueta: 'Impuestos con diferencia de valor',
    definicion: 'Gestiones de impuesto creadas en el periodo elegido que quedaron marcadas porque lo pagado no coincide con lo liquidado, con los filtros de arriba.',
    fechaBase: 'creacion', filtrosIgnorados: [], columnas: [...COLS_IMPUESTO, 'valor_liquidado', 'valor'],
    ordenDefecto: { columna: 'creado_en', dir: 'desc' }, segmentosAdmitidos: ['compania', 'organismo'],
    frase: '{n} {impuesto creado en el periodo tiene|impuestos creados en el periodo tienen} diferencia entre lo liquidado y lo pagado', fraseVacio: 'Ningún impuesto creado en el periodo tiene diferencia de valor.',
    requiereDinero: false, funcionesOrigen: [PRODUCTOS],
  },
  {
    id: 'impuestos_direccion_pendiente', entidad: 'impuesto', etiqueta: 'Impuestos con dirección por revisar',
    definicion: 'Gestiones de impuesto cuya dirección de la factura quedó pendiente de revisión por una persona. Aquí solo se cuentan: la dirección no se muestra. Es la foto de hoy: no depende del periodo.',
    fechaBase: null, filtrosIgnorados: FOTO, columnas: [...COLS_IMPUESTO],
    ordenDefecto: { columna: 'creado_en', dir: 'asc' }, segmentosAdmitidos: ['compania', 'organismo'],
    frase: '{n} {impuesto tiene|impuestos tienen} la dirección pendiente de revisión', fraseVacio: 'Ningún impuesto tiene la dirección pendiente de revisión.',
    requiereDinero: false, funcionesOrigen: [PRODUCTOS],
  },
  {
    id: 'impuestos_pagados_periodo', entidad: 'impuesto', etiqueta: 'Impuestos pagados',
    definicion: 'Gestiones de impuesto cuya fecha de pago cae en el periodo elegido, con los filtros de arriba. El valor es lo pagado. Es la misma cifra de la métrica «Impuestos pagados» del Explorador.',
    fechaBase: 'pago', filtrosIgnorados: [], columnas: [...COLS_IMPUESTO, 'pagado_en', 'valor'],
    ordenDefecto: { columna: 'pagado_en', dir: 'desc' }, segmentosAdmitidos: ['compania', 'organismo'],
    frase: '{n} {impuesto pagado|impuestos pagados} en el periodo', fraseVacio: 'No se pagaron impuestos en el periodo.',
    requiereDinero: false, funcionesOrigen: [PRODUCTOS],
  },
  // ── Derechos de tránsito ──
  {
    id: 'derechos_pagados_periodo', entidad: 'derecho', etiqueta: 'Derechos de tránsito pagados',
    definicion: 'Derechos de tránsito cuya fecha de pago cae en el periodo elegido, con los filtros de arriba. El valor es el del recibo. Es la misma cifra de la métrica «Derechos de tránsito pagados» del Explorador.',
    fechaBase: 'pago', filtrosIgnorados: [], columnas: [...COLS_DERECHO],
    ordenDefecto: { columna: 'fecha_pago', dir: 'desc' }, segmentosAdmitidos: ['compania', 'organismo'],
    frase: '{n} {derecho de tránsito pagado|derechos de tránsito pagados} en el periodo', fraseVacio: 'No se pagaron derechos de tránsito en el periodo.',
    requiereDinero: false, funcionesOrigen: [PRODUCTOS],
  },
  {
    id: 'derechos_sin_soporte', entidad: 'derecho', etiqueta: 'Derechos sin soporte',
    definicion: 'Derechos de tránsito registrados que no tienen un recibo vigente cargado como soporte. Es la foto de hoy: no depende del periodo.',
    fechaBase: null, filtrosIgnorados: FOTO, columnas: [...COLS_DERECHO],
    ordenDefecto: { columna: 'creado_en', dir: 'asc' }, segmentosAdmitidos: ['compania', 'organismo'],
    frase: '{n} {derecho de tránsito no tiene|derechos de tránsito no tienen} soporte', fraseVacio: 'Todos los derechos de tránsito tienen soporte.',
    requiereDinero: false, funcionesOrigen: [PRODUCTOS],
  },
  {
    id: 'derechos_pendientes_sin_resolver', entidad: 'derecho_pendiente', etiqueta: 'Recibos pendientes de asociar',
    definicion: 'Recibos de derechos de tránsito (y de SOAT o impuesto) cargados que todavía no se pudieron asociar a un trámite y siguen sin resolver. No tienen compañía: solo se filtran por secretaría. Es la foto de hoy: no depende del periodo.',
    fechaBase: null, filtrosIgnorados: SOLO_ORGANISMO, columnas: ['placa', 'organismo', 'motivo', 'fecha_pago', 'intentos', 'creado_en', 'valor'],
    ordenDefecto: { columna: 'creado_en', dir: 'asc' }, segmentosAdmitidos: ['motivo', 'organismo'],
    frase: '{n} {recibo sigue|recibos siguen} sin asociar a un trámite', fraseVacio: 'No hay recibos pendientes de asociar.',
    requiereDinero: false, funcionesOrigen: [PRODUCTOS],
  },
] as const satisfies readonly ConjuntoTorreDef[];

// ── Respuesta de `POST /api/flito/torre/tableros/productos` ─────────────────────────────────────────────────────────

/** Una fila de una tabla de Productos: un estado, un motivo o una secretaría. `destino` abre el detalle de esa fila. */
export interface FilaTablaProductosTorre {
  /** Valor crudo del segmento (`null` = «Sin motivo» / «Sin secretaría»; `'__otros'` = el resto, sin destino). */
  clave: string | null;
  etiqueta: string;
  n: number;
  /** Σ del valor de la fila (lo pagado). `undefined` = la tabla no lleva valor; `null` = sin permiso de dinero. */
  valor?: number | null;
  destino: DestinoCifra;
}

export interface TablaProductosTorre {
  /** «SOAT del periodo por estado». */
  titulo: string;
  /** Dimensión de las filas (la del segmento del destino). */
  dimension: 'estado' | 'motivo' | 'organismo';
  /** El conjunto que corta (su definición es «¿Cómo se calcula?»). */
  conjunto: ConjuntoTorreId;
  definicion: string;
  /** ¿Las filas traen `valor`? */
  conValor: boolean;
  filas: FilaTablaProductosTorre[];
  /** Fila de total (= el conjunto sin segmento). */
  total: FilaTablaProductosTorre;
  filtrosIgnorados: (keyof FiltroTorre)[];
}

export interface PestanaProductosTorre<C> {
  cifras: C;
  /** Hasta 4 KPI explicables (frase, definición, destino), como los demás tableros. */
  explicaciones: ExplicacionesTablero<C>;
  /** La primera es la tabla principal de la pestaña. */
  tablas: TablaProductosTorre[];
}

export interface CifrasSoatTorre {
  pagadosPeriodo: number;
  /** Σ de lo pagado; `null` sin permiso de dinero. No es KPI propio: va en la frase de `pagadosPeriodo`. */
  pagadosValor: number | null;
  porVencer: number;
  sinGestion: number;
  vigenciaNoVerificada: number;
}

export interface CifrasImpuestosTorre {
  pagadosPeriodo: number;
  pagadosValor: number | null;
  sinGestion: number;
  conDiferencia: number;
  direccionPendiente: number;
}

export interface CifrasDerechosTorre {
  pagadosPeriodo: number;
  pagadosValor: number | null;
  sinSoporte: number;
  pendientesSinResolver: number;
}

/** Respuesta de `POST /api/flito/torre/tableros/productos` (body `{ filtro }`). */
export interface TableroProductos {
  soat: PestanaProductosTorre<CifrasSoatTorre>;
  impuestos: PestanaProductosTorre<CifrasImpuestosTorre>;
  derechos: PestanaProductosTorre<CifrasDerechosTorre>;
  rango: { desde: string; hasta: string };
  dineroVisible: boolean;
  generadoEn: string;
}
