// Torre de Control Gerencial (Épica #14590, B4) — área LOGÍSTICA (Traslados · Entregas) y las subvistas de FINANCIERA
// (Facturación · Bolsas, con la conciliación de boletas como bloque de Bolsas). La cartera salió de la Épica.
//
// Los conjuntos de este archivo entran en `CONJUNTOS_TORRE` (`flito-torre-detalle.ts`): misma regla (definición, frase
// y frase en 0 escritas UNA vez; la cifra del tablero y el `total` del detalle salen del mismo fragmento SQL).
// Ley 1581 (diseño §12 B4): ninguna columna lleva dirección de entrega, contacto, receptor, quien entrega, coordenadas,
// storage keys ni el mensajero (nombre ni datos personales: eso es B5). De Siigo, el error es un texto LEGIBLE, nunca
// el `error_code` crudo ni el payload. La placa solo va donde ya iba (actas, viajes, cola, movimientos).
//
// Solo imports de TIPO desde `flito-torre-detalle.ts` (que importa este archivo como valor): sin ciclo al cargar.
import type { ConjuntoTorreDef, ConjuntoTorreId, DestinoCifra, ExplicacionesTablero } from './flito-torre-detalle.js';
import type { FilaTablaProductosTorre } from './flito-torre-productos.js';
import type { FiltroTorre, SeveridadTorre } from './flito-torre.js';

/** La operación del tablero de Logística (y función de origen de sus conjuntos). */
export const FUNCION_TABLERO_LOGISTICA_TORRE = 'torre.tablero_logistica.ver';

const LOGISTICA = FUNCION_TABLERO_LOGISTICA_TORRE;
const FINANCIERO = 'torre.tablero_financiero.ver';
const FOTO = ['rango'] as const;
/** Traslados, actas, bolsas y boletas: tienen compañía, pero ni secretaría ni trámite. */
const SOLO_COMPANIA = ['rango', 'organismos', 'departamentos', 'tiposTramite', 'flitEstados'] as const;
/** Lo mismo, con periodo (actas devueltas, movimientos de bolsa). */
const COMPANIA_Y_PERIODO = ['organismos', 'departamentos', 'tiposTramite', 'flitEstados'] as const;

const COLS_TRASLADO = ['codigo_traslado', 'compania', 'origen', 'destino', 'estado', 'registrado_en', 'dias_abierto', 'n_tramites'] as const;
const COLS_ACTA = ['placas', 'compania', 'proveedor_logistica', 'creado_en', 'estado', 'dias_antiguedad'] as const;
const COLS_FACTURA = ['numero_factura', 'codigo_flit', 'compania', 'estado', 'enviada_en', 'valor', 'dias_antiguedad'] as const;
const COLS_BOLSA = ['compania', 'saldo', 'consumo_diario', 'dias_cobertura', 'severidad'] as const;
const COLS_BOLETA = ['referencia', 'compania', 'estado', 'fecha_pago', 'total_declarado', 'total_cruzado', 'creado_en', 'dias_antiguedad'] as const;

export const CONJUNTOS_LOGISTICA_TORRE = [
  // ── Traslados ──
  {
    id: 'traslados_por_estado', entidad: 'traslado', etiqueta: 'Traslados por estado',
    definicion: 'Traslados de documentos registrados (de la secretaría a FLIT, de la secretaría a la compañía o de FLIT a la compañía), por su estado actual. Abiertos son los registrados y los que van en camino. Es la foto de hoy: no depende del periodo.',
    fechaBase: null, filtrosIgnorados: SOLO_COMPANIA, columnas: [...COLS_TRASLADO],
    ordenDefecto: { columna: 'registrado_en', dir: 'desc' }, segmentosAdmitidos: ['estado', 'compania'],
    frase: '{n} {traslado registrado|traslados registrados}', fraseVacio: 'No hay traslados registrados.',
    requiereDinero: false, funcionesOrigen: [LOGISTICA],
  },
  {
    id: 'traslados_abiertos_mas_de_n', entidad: 'traslado', etiqueta: 'Traslados abiertos de más',
    definicion: 'Traslados abiertos (registrados o en camino) cuya fecha de registro tiene más de {umbral} días. El umbral se cambia en Umbrales y alertas. Es la foto de hoy: no depende del periodo.',
    fechaBase: null, filtrosIgnorados: SOLO_COMPANIA, columnas: [...COLS_TRASLADO],
    ordenDefecto: { columna: 'dias_abierto', dir: 'desc' }, segmentosAdmitidos: ['severidad', 'compania'],
    frase: '{n} {traslado lleva|traslados llevan} abierto más de {umbral} días', fraseVacio: 'Ningún traslado lleva abierto más de {umbral} días.',
    fraseCriticos: '{c} {pasa|pasan} de {doble}',
    requiereDinero: false, funcionesOrigen: [LOGISTICA], umbral: 'dias_traslado_abierto',
  },
  // ── Entregas ──
  {
    id: 'actas_pendientes_entrega', entidad: 'acta', etiqueta: 'Actas pendientes de entrega',
    definicion: 'Actas de entrega a la compañía creadas que todavía no tienen fecha de entrega ni devolución (generadas o despachadas). Es la foto de hoy: no depende del periodo.',
    fechaBase: null, filtrosIgnorados: SOLO_COMPANIA, columnas: [...COLS_ACTA],
    ordenDefecto: { columna: 'dias_antiguedad', dir: 'desc' }, segmentosAdmitidos: ['compania'],
    frase: '{n} {acta sigue pendiente|actas siguen pendientes} de entrega hoy', fraseVacio: 'No hay actas pendientes de entrega.',
    requiereDinero: false, funcionesOrigen: [LOGISTICA],
  },
  {
    id: 'actas_devueltas_periodo', entidad: 'acta', etiqueta: 'Actas devueltas',
    definicion: 'Actas de entrega a la compañía creadas en el periodo elegido que volvieron sin entregarse, con su motivo de devolución. Solo se filtran por compañía.',
    fechaBase: 'creacion', filtrosIgnorados: COMPANIA_Y_PERIODO, columnas: [...COLS_ACTA, 'motivo'],
    ordenDefecto: { columna: 'creado_en', dir: 'desc' }, segmentosAdmitidos: ['motivo', 'compania'],
    frase: '{n} {acta volvió|actas volvieron} sin entregarse en el periodo', fraseVacio: 'Ninguna acta volvió en el periodo.',
    requiereDinero: false, funcionesOrigen: [LOGISTICA],
  },
  {
    id: 'viajes_adicionales_periodo', entidad: 'viaje_logistica', etiqueta: 'Viajes adicionales',
    definicion: 'Viajes de logística registrados después del primero (el primero va incluido en la tarifa), con fecha de registro dentro del periodo elegido y los filtros de arriba. El valor es lo que se cobra por el viaje.',
    fechaBase: 'creacion', filtrosIgnorados: [],
    columnas: ['codigo_flit', 'placa', 'compania', 'organismo', 'numero_viaje', 'motivo', 'registrado_en', 'valor'],
    ordenDefecto: { columna: 'registrado_en', dir: 'desc' }, segmentosAdmitidos: ['compania', 'organismo'],
    frase: '{n} {viaje adicional|viajes adicionales} en el periodo', fraseVacio: 'No hubo viajes adicionales en el periodo.',
    requiereDinero: false, funcionesOrigen: [LOGISTICA],
  },
] as const satisfies readonly ConjuntoTorreDef[];

export const CONJUNTOS_FINANCIERA_B4_TORRE = [
  // ── Facturación ──
  {
    id: 'facturas_con_error', entidad: 'factura', etiqueta: 'Facturas con error',
    definicion: 'Facturas de Siigo con un error que sigue sin corregir (la emisión falló y su trámite no se volvió a facturar) o marcadas para revisión. Es la foto de hoy: no depende del periodo.',
    fechaBase: null, filtrosIgnorados: FOTO, columnas: [...COLS_FACTURA, 'error_factura'],
    ordenDefecto: { columna: 'dias_antiguedad', dir: 'desc' }, segmentosAdmitidos: ['compania'],
    frase: '{n} {factura tiene|facturas tienen} un error de Siigo o {quedó|quedaron} para revisión', fraseVacio: 'Ninguna factura tiene error ni está en revisión.',
    requiereDinero: false, funcionesOrigen: [FINANCIERO],
  },
  {
    id: 'facturas_rechazadas_dian', entidad: 'factura', etiqueta: 'Facturas rechazadas por la DIAN',
    definicion: 'Facturas cuyo último estado ante la DIAN es rechazada. Es la foto de hoy: no depende del periodo.',
    fechaBase: null, filtrosIgnorados: FOTO, columnas: [...COLS_FACTURA],
    ordenDefecto: { columna: 'dias_antiguedad', dir: 'desc' }, segmentosAdmitidos: ['compania'],
    frase: '{n} {factura fue rechazada|facturas fueron rechazadas} por la DIAN y {sigue|siguen} sin corregir', fraseVacio: 'Ninguna factura está rechazada por la DIAN.',
    requiereDinero: false, funcionesOrigen: [FINANCIERO],
  },
  {
    id: 'cola_facturacion_atascada', entidad: 'cola_facturacion', etiqueta: 'Cola de facturación detenida',
    definicion: 'Trámites en la cola de facturación de Siigo, todavía sin factura activa, cuyo próximo intento ya pasó o que agotaron los intentos (no se reintentan solos). Es la foto de hoy: no depende del periodo.',
    fechaBase: null, filtrosIgnorados: FOTO, columnas: ['codigo_flit', 'placa', 'compania', 'situacion_cola', 'intentos', 'proximo_intento', 'solicitado_en'],
    ordenDefecto: { columna: 'solicitado_en', dir: 'asc' }, segmentosAdmitidos: ['nivel', 'compania'],
    frase: '{n} {trámite espera|trámites esperan} en la cola de facturación', fraseVacio: 'La cola de facturación avanza sin atascos.',
    requiereDinero: false, funcionesOrigen: [FINANCIERO],
  },
  {
    id: 'facturado_periodo', entidad: 'factura', etiqueta: 'Facturas emitidas',
    definicion: 'Facturas emitidas en Siigo con fecha de envío dentro del periodo elegido, con los filtros de arriba. El valor es el total de la factura en Siigo.',
    fechaBase: 'facturacion', filtrosIgnorados: [], columnas: [...COLS_FACTURA],
    ordenDefecto: { columna: 'enviada_en', dir: 'desc' }, segmentosAdmitidos: ['compania'],
    frase: '{n} {factura emitida|facturas emitidas} en el periodo', fraseVacio: 'No se emitieron facturas en el periodo.',
    requiereDinero: false, funcionesOrigen: [FINANCIERO],
  },
  // ── Bolsas ──
  {
    id: 'bolsas_cobertura', entidad: 'bolsa', etiqueta: 'Bolsas con cobertura baja',
    definicion: 'Bolsas activas de compañía cuyo saldo de hoy, dividido entre su consumo diario promedio de los últimos 30 días, alcanza para menos de {umbral} días (atención), o menos de los días del umbral crítico (crítico). Una bolsa sin saldo es crítica; una sin consumo en 30 días no entra. Los umbrales se cambian en Umbrales y alertas. Es la foto de hoy: no depende del periodo.',
    fechaBase: null, filtrosIgnorados: SOLO_COMPANIA, columnas: [...COLS_BOLSA],
    ordenDefecto: { columna: 'dias_cobertura', dir: 'asc' }, segmentosAdmitidos: ['severidad', 'compania'],
    frase: '{n} {bolsa alcanza|bolsas alcanzan} para menos de {umbral} días', fraseVacio: 'Todas las bolsas activas cubren {umbral} días o más.',
    fraseCriticos: '{c} {está|están} en crítico',
    requiereDinero: false, funcionesOrigen: [FINANCIERO], umbral: 'dias_cobertura_amarillo',
  },
  {
    id: 'bolsas_agotadas', entidad: 'bolsa', etiqueta: 'Bolsas agotadas',
    definicion: 'Bolsas activas de compañía con saldo cero o negativo hoy. Es la foto de hoy: no depende del periodo.',
    fechaBase: null, filtrosIgnorados: SOLO_COMPANIA, columnas: [...COLS_BOLSA],
    ordenDefecto: { columna: 'saldo', dir: 'asc' }, segmentosAdmitidos: ['compania'],
    frase: '{n} {bolsa activa está|bolsas activas están} sin saldo', fraseVacio: 'Ninguna bolsa activa está sin saldo.',
    requiereDinero: false, funcionesOrigen: [FINANCIERO],
  },
  {
    id: 'movimientos_bolsa_periodo', entidad: 'movimiento_bolsa', etiqueta: 'Movimientos de bolsa',
    definicion: 'Recargas (entradas) y consumos (salidas) de las bolsas con fecha dentro del periodo elegido. Solo se filtran por compañía: las bolsas de tránsito no tienen compañía.',
    fechaBase: 'creacion', filtrosIgnorados: COMPANIA_Y_PERIODO,
    columnas: ['compania', 'tipo_movimiento', 'fecha_movimiento', 'codigo_flit', 'placa', 'valor'],
    ordenDefecto: { columna: 'fecha_movimiento', dir: 'desc' }, segmentosAdmitidos: ['bolsa', 'compania'],
    frase: '{n} {movimiento|movimientos} de bolsa en el periodo', fraseVacio: 'No hubo movimientos de bolsa en el periodo.',
    requiereDinero: false, funcionesOrigen: [FINANCIERO],
  },
  // ── Conciliación de boletas (bloque de Bolsas) ──
  {
    id: 'boletas_sin_conciliar', entidad: 'boleta', etiqueta: 'Boletas sin conciliar',
    definicion: 'Boletas de pago al organismo cargadas que todavía no se concilian con sus trámites (ni conciliadas ni descartadas). Es la foto de hoy: no depende del periodo.',
    fechaBase: null, filtrosIgnorados: SOLO_COMPANIA, columnas: [...COLS_BOLETA],
    ordenDefecto: { columna: 'creado_en', dir: 'asc' }, segmentosAdmitidos: ['compania'],
    frase: '{n} {boleta de pago al organismo aún no se cruza|boletas de pago al organismo aún no se cruzan} con sus trámites', fraseVacio: 'Todas las boletas están conciliadas.',
    requiereDinero: false, funcionesOrigen: [FINANCIERO],
  },
  {
    id: 'boletas_con_diferencia', entidad: 'boleta', etiqueta: 'Boletas con diferencia',
    definicion: 'Boletas sin conciliar en las que el total declarado por el portal no coincide con el total cruzado en FLITO. Es la foto de hoy: no depende del periodo.',
    fechaBase: null, filtrosIgnorados: SOLO_COMPANIA, columnas: [...COLS_BOLETA, 'diferencia'],
    ordenDefecto: { columna: 'creado_en', dir: 'asc' }, segmentosAdmitidos: ['compania'],
    frase: '{n} {boleta tiene|boletas tienen} diferencia entre el total declarado y el cruzado', fraseVacio: 'Ninguna boleta tiene diferencia.',
    requiereDinero: false, funcionesOrigen: [FINANCIERO],
  },
] as const satisfies readonly ConjuntoTorreDef[];

// ── Tablas (las de Productos, con la compañía como dimensión) ───────────────────────────────────────────────────────

/** Una tabla de un área: el conjunto agrupado por su dimensión, con su fila total (= el conjunto sin segmento). */
export interface TablaAreaTorre {
  titulo: string;
  dimension: 'estado' | 'motivo' | 'organismo' | 'compania';
  conjunto: ConjuntoTorreId;
  definicion: string;
  conValor: boolean;
  filas: FilaTablaProductosTorre[];
  total: FilaTablaProductosTorre;
  filtrosIgnorados: (keyof FiltroTorre)[];
}

// ── `POST /api/flito/torre/tableros/logistica` ─────────────────────────────────────────────────────────────────────

/** Abiertos por ruta (origen → destino): el T1 sin «N orígenes y destinos» (solo hay tres rutas posibles). */
export interface RutaTrasladoTorre { origen: string; destino: string; etiqueta: string; n: number }

export interface CifrasTrasladosTorre {
  /** = `traslados_por_estado` con `estado ∈ {registrado, en_ruta}`. */
  abiertos: number;
  abiertosMasDeN: number;
}

export interface CifrasEntregasTorre {
  pendientesEntrega: number;
  /** = `entregas_logistica` (B1) del periodo. */
  entregasPeriodo: number;
  /** = `entregas_logistica` con `nivel = primer_intento`; el desglose lleva los de `con_viajes`. */
  primerIntento: number;
  /** % de entregas al primer intento (`null` sin entregas). No abre lista propia. */
  primerIntentoPct: number | null;
  devueltasPeriodo: number;
  viajesAdicionales: number;
  /** Trámites distintos con algún viaje adicional en el periodo (va en la frase de E4). */
  tramitesConViajes: number;
}

export interface PestanaAreaTorre<C> {
  cifras: C;
  explicaciones: ExplicacionesTablero<C>;
  /** La primera es la tabla principal de la pestaña. */
  tablas: TablaAreaTorre[];
}

/** Respuesta de `POST /api/flito/torre/tableros/logistica` (body `{ filtro }`). */
export interface TableroLogistica {
  traslados: PestanaAreaTorre<CifrasTrasladosTorre> & { rutasAbiertas: RutaTrasladoTorre[]; umbralDias: number };
  entregas: PestanaAreaTorre<CifrasEntregasTorre>;
  rango: { desde: string; hasta: string };
  dineroVisible: boolean;
  generadoEn: string;
}

// ── `POST /api/flito/torre/tableros/financiera/facturacion` ────────────────────────────────────────────────────────

export interface CifrasFacturacionTorre {
  /** = `sin_facturar` (FA1, la F2 del Resumen). */
  sinFacturar: number;
  /** Σ de las liquidaciones vigentes; `null` sin permiso de dinero. */
  sinFacturarValor: number | null;
  conError: number;
  rechazadasDian: number;
  /** = `cola_facturacion_atascada`; el desglose separa `vencido` y `agotado`. */
  colaAtascada: number;
  /** Frase guía: facturas emitidas en el periodo (`facturado_periodo`). */
  facturadasPeriodo: number;
  /** Σ de `total_siigo`; `null` sin permiso de dinero. */
  facturadoValor: number | null;
}

/** Respuesta de `POST /api/flito/torre/tableros/financiera/facturacion` (body `{ filtro }`). */
export interface TableroFacturacion extends PestanaAreaTorre<CifrasFacturacionTorre> {
  rango: { desde: string; hasta: string };
  dineroVisible: boolean;
  generadoEn: string;
}

// ── `POST /api/flito/torre/tableros/financiera/bolsas` ─────────────────────────────────────────────────────────────

/** Una fila de «Cobertura por bolsa». `destino` = sus movimientos del periodo (`movimientos_bolsa_periodo` + `bolsa`). */
export interface FilaCoberturaBolsaTorre {
  /** uuid de la bolsa (opaco: es el valor del segmento `bolsa`). */
  bolsaId: string;
  companiaId: number;
  compania: string;
  /** `null` sin permiso de dinero. */
  saldo: number | null;
  consumoDiario: number | null;
  /** `null` = sin consumo en 30 días («Sin consumo»); 0 = sin saldo. */
  diasCobertura: number | null;
  severidad: SeveridadTorre;
  /** Movimientos de la bolsa en el periodo (= el `total` de su destino). */
  movimientos: number;
  destino: DestinoCifra;
}

export interface CifrasBolsasTorre {
  activas: number;
  /** = `bolsas_cobertura` con `severidad = critico` (B4-AC3). Incluye las agotadas. */
  enCritico: number;
  enAtencion: number;
  /** Dedupe (UX B6.2): en crítico CON saldo = `enCritico − agotadas` (las agotadas son críticas por definición). */
  criticasConSaldo: number;
  agotadas: number;
  movimientosPeriodo: number;
  recargas: number;
  consumos: number;
  /** `null` sin permiso de dinero. */
  recargasValor: number | null;
  consumosValor: number | null;
  boletasSinConciliar: number;
  boletasConDiferencia: number;
}

/** Respuesta de `POST /api/flito/torre/tableros/financiera/bolsas` (body `{ filtro }`). */
export interface TableroBolsas {
  cifras: CifrasBolsasTorre;
  explicaciones: ExplicacionesTablero<CifrasBolsasTorre>;
  cobertura: {
    filtrosIgnorados: (keyof FiltroTorre)[];
    umbralCriticoDias: number;
    umbralAtencionDias: number;
    /** Ordenadas por días de cobertura ↑ (las sin consumo al final). */
    filas: FilaCoberturaBolsaTorre[];
  };
  rango: { desde: string; hasta: string };
  dineroVisible: boolean;
  generadoEn: string;
}
