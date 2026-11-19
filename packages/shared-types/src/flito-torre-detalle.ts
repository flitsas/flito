// Torre de Control Gerencial (Épica #14590, ADR-0047) — contrato del DETALLE UNIVERSAL: cada cifra de un tablero o
// celda del Explorador abre los registros que la forman, contados con el MISMO fragmento SQL (`flito-torre.conjuntos.ts`).
//
// Va en un archivo aparte de `flito-torre.ts` para que B3–B5 no lo lleven por encima de 800 líneas.
// `CONJUNTOS_TORRE` es la ÚNICA fuente de la definición de cada cifra («¿Cómo se calcula?»): tablero, Detalle, Excel y
// ayuda la leen de aquí. Los marcadores `{umbral}` y `{doble}` los resuelve la API con el valor vigente del umbral.
import {
  AGRUPACIONES_TORRE, type ClaveUmbralTorre, type FechaBaseTorre, type FiltroTorre, type MetricaTorreId,
  type TramoAntiguedadTorre,
} from './flito-torre.js';
import { CONJUNTOS_PRODUCTOS_TORRE } from './flito-torre-productos.js';
import { CONJUNTOS_FINANCIERA_B4_TORRE, CONJUNTOS_LOGISTICA_TORRE, FUNCION_TABLERO_LOGISTICA_TORRE } from './flito-torre-logistica.js';
import { CONJUNTOS_EQUIPO_TORRE } from './flito-torre-equipo.js';

// ── Entidades, segmentos y columnas ──────────────────────────────────────────────────────────────────────

/** Entidades con detalle. B1 usa tramite / liquidacion / gestion_soat / impuesto / derecho; las demás nacen con su bloque. */
export const ENTIDADES_TORRE = ['tramite', 'liquidacion', 'gestion_soat', 'soat_incompleta', 'impuesto', 'derecho',
  'derecho_pendiente', 'traslado', 'acta', 'factura', 'bolsa', 'movimiento_bolsa', 'boleta', 'funcionario',
  // B4: un viaje adicional de logística y un trámite en la cola de facturación de Siigo.
  'viaje_logistica', 'cola_facturacion'] as const;
export type EntidadTorre = (typeof ENTIDADES_TORRE)[number];

/**
 * Dimensiones de segmento: las agrupaciones del motor (misma expresión, D2; incluye `tramo_antiguedad` desde B2) + las
 * propias de un conjunto.
 */
export const DIMENSIONES_SEGMENTO_TORRE = [...AGRUPACIONES_TORRE, 'nivel', 'faltante', 'severidad', 'estado', 'motivo', 'bolsa', 'funcionario'] as const;
export type DimensionSegmentoTorre = (typeof DIMENSIONES_SEGMENTO_TORRE)[number];

/** Un corte de la cifra. `null` en `valores` = «Sin compañía» / «Sin secretaría»… (≤ `TOPES_TORRE.VALORES_SEGMENTO_MAX`). */
export interface SegmentoDetalle { dimension: DimensionSegmentoTorre; valores: (string | null)[] }

/**
 * Valores admitidos de las dimensiones propias de conjunto:
 *   · `severidad`: `critico` = pasa del DOBLE del umbral; `atencion` = pasa del umbral sin llegar al doble.
 *   · `nivel` (soportes): `0`..`3` soportes vigentes · (entregas): `primer_intento` / `con_viajes`.
 *   · `faltante` (soportes): `soat` / `impuesto` / `derecho` = le falta ese soporte.
 *   · `estado` (productos, B3): el estado del SOAT o del impuesto tal cual (`pendiente`, `solicitado`, `con_novedad`,
 *     `pagado`) · `motivo` (productos): el motivo de la incompleta, de la novedad o el concepto del recibo; `null` = sin
 *     motivo.
 *   · `nivel` (cola de facturación, B4): `vencido` (el próximo intento ya pasó) / `agotado` (no se reintenta solo).
 *   · `bolsa` (movimientos, B4): el uuid de la bolsa (opaco).
 *   · `funcionario` (equipo, B5): el `users.id` del funcionario (entero positivo, opaco), sin «Sin valor». NO es una
 *     agrupación del Explorador: la operación del equipo solo la abre `torre.equipo.ver`.
 */
export const VALORES_SEVERIDAD_DETALLE = ['critico', 'atencion'] as const;
export const VALORES_NIVEL_SOPORTES = ['0', '1', '2', '3'] as const;
export const VALORES_NIVEL_ENTREGAS = ['primer_intento', 'con_viajes'] as const;
export const VALORES_FALTANTE_SOPORTE = ['soat', 'impuesto', 'derecho'] as const;
export const VALORES_NIVEL_COLA = ['vencido', 'agotado'] as const;

export const COLUMNAS_DETALLE_IDS = [
  'codigo_flit', 'placa', 'compania', 'organismo', 'tipo_tramite', 'estado', 'creado_en', 'aprobado_en', 'facturado_en',
  'dias_antiguedad', 'dias_en_estado', 'faltan_soportes', 'valor', 'horas_ciclo', 'aprobado', 'solicitado_en',
  'horas_sin_gestion', 'viajes_adicionales',
  // B3 (productos): fechas, vigencia y valores. La póliza va SOLO con sus 4 últimos; nunca dirección ni VIN.
  'pagado_en', 'vence_el', 'dias_para_vencer', 'poliza_ultimos', 'estado_vigencia', 'motivo', 'intentos', 'fecha_pago',
  'valor_liquidado',
  // B4 (logística y facturación). Sin dirección de entrega, receptor, contacto, quien entrega, coordenadas, storage
  // keys ni el mensajero; de Siigo, el error va como texto legible (nunca el código ni el payload crudo).
  'codigo_traslado', 'origen', 'destino', 'registrado_en', 'dias_abierto', 'n_tramites', 'placas', 'proveedor_logistica',
  'entregado_en', 'numero_viaje', 'numero_factura', 'enviada_en', 'error_factura', 'situacion_cola', 'proximo_intento',
  'saldo', 'consumo_diario', 'dias_cobertura', 'severidad', 'tipo_movimiento', 'fecha_movimiento', 'referencia',
  'total_declarado', 'total_cruzado', 'diferencia',
  // B5 (equipo). Del funcionario, solo el nombre (`users.name`); nunca su correo.
  'que_se_gestiono', 'funcionario', 'gestionado_en', 'ultimo_movimiento', 'horas_desde_movimiento',
] as const;
export type ColumnaDetalleId = (typeof COLUMNAS_DETALLE_IDS)[number];

export type TipoColumnaDetalle = 'texto' | 'fecha' | 'numero' | 'cop' | 'horas' | 'dias' | 'lista' | 'booleano';

export interface ColumnaDetalle {
  id: ColumnaDetalleId;
  etiqueta: string;
  tipo: TipoColumnaDetalle;
  /** Sin `FUNCION_TORRE_DINERO` la API manda `null` en esta columna. */
  dinero: boolean;
  ordenable: boolean;
}

/** Metadatos de cada columna (la etiqueta del encabezado de la tabla y del Excel). */
export const COLUMNAS_DETALLE: Readonly<Record<ColumnaDetalleId, ColumnaDetalle>> = {
  codigo_flit: { id: 'codigo_flit', etiqueta: 'Código FLIT', tipo: 'texto', dinero: false, ordenable: true },
  placa: { id: 'placa', etiqueta: 'Placa', tipo: 'texto', dinero: false, ordenable: true },
  compania: { id: 'compania', etiqueta: 'Compañía', tipo: 'texto', dinero: false, ordenable: false },
  organismo: { id: 'organismo', etiqueta: 'Secretaría', tipo: 'texto', dinero: false, ordenable: false },
  tipo_tramite: { id: 'tipo_tramite', etiqueta: 'Tipo de trámite', tipo: 'texto', dinero: false, ordenable: true },
  estado: { id: 'estado', etiqueta: 'Estado', tipo: 'texto', dinero: false, ordenable: true },
  creado_en: { id: 'creado_en', etiqueta: 'Creado', tipo: 'fecha', dinero: false, ordenable: true },
  aprobado_en: { id: 'aprobado_en', etiqueta: 'Aprobado', tipo: 'fecha', dinero: false, ordenable: true },
  facturado_en: { id: 'facturado_en', etiqueta: 'Facturado', tipo: 'fecha', dinero: false, ordenable: true },
  dias_antiguedad: { id: 'dias_antiguedad', etiqueta: 'Días desde creado', tipo: 'dias', dinero: false, ordenable: true },
  dias_en_estado: { id: 'dias_en_estado', etiqueta: 'Días en el estado', tipo: 'dias', dinero: false, ordenable: true },
  faltan_soportes: { id: 'faltan_soportes', etiqueta: 'Faltan', tipo: 'lista', dinero: false, ordenable: false },
  valor: { id: 'valor', etiqueta: 'Valor', tipo: 'cop', dinero: true, ordenable: true },
  horas_ciclo: { id: 'horas_ciclo', etiqueta: 'Horas de creado a aprobado', tipo: 'horas', dinero: false, ordenable: true },
  aprobado: { id: 'aprobado', etiqueta: 'Aprobado', tipo: 'booleano', dinero: false, ordenable: false },
  solicitado_en: { id: 'solicitado_en', etiqueta: 'Pedido', tipo: 'fecha', dinero: false, ordenable: true },
  horas_sin_gestion: { id: 'horas_sin_gestion', etiqueta: 'Horas sin soporte', tipo: 'horas', dinero: false, ordenable: true },
  viajes_adicionales: { id: 'viajes_adicionales', etiqueta: 'Viajes adicionales', tipo: 'numero', dinero: false, ordenable: true },
  pagado_en: { id: 'pagado_en', etiqueta: 'Pagado', tipo: 'fecha', dinero: false, ordenable: true },
  vence_el: { id: 'vence_el', etiqueta: 'Vence', tipo: 'fecha', dinero: false, ordenable: true },
  dias_para_vencer: { id: 'dias_para_vencer', etiqueta: 'Días para vencer', tipo: 'dias', dinero: false, ordenable: true },
  poliza_ultimos: { id: 'poliza_ultimos', etiqueta: 'Póliza (4 últimos)', tipo: 'texto', dinero: false, ordenable: false },
  estado_vigencia: { id: 'estado_vigencia', etiqueta: 'Vigencia en el RUNT', tipo: 'texto', dinero: false, ordenable: true },
  motivo: { id: 'motivo', etiqueta: 'Motivo', tipo: 'texto', dinero: false, ordenable: true },
  intentos: { id: 'intentos', etiqueta: 'Intentos', tipo: 'numero', dinero: false, ordenable: true },
  fecha_pago: { id: 'fecha_pago', etiqueta: 'Fecha de pago', tipo: 'fecha', dinero: false, ordenable: true },
  valor_liquidado: { id: 'valor_liquidado', etiqueta: 'Valor liquidado', tipo: 'cop', dinero: true, ordenable: true },
  codigo_traslado: { id: 'codigo_traslado', etiqueta: 'Código del traslado', tipo: 'texto', dinero: false, ordenable: true },
  origen: { id: 'origen', etiqueta: 'Origen', tipo: 'texto', dinero: false, ordenable: true },
  destino: { id: 'destino', etiqueta: 'Destino', tipo: 'texto', dinero: false, ordenable: true },
  registrado_en: { id: 'registrado_en', etiqueta: 'Registrado', tipo: 'fecha', dinero: false, ordenable: true },
  dias_abierto: { id: 'dias_abierto', etiqueta: 'Días abierto', tipo: 'dias', dinero: false, ordenable: true },
  n_tramites: { id: 'n_tramites', etiqueta: 'N.º de trámites', tipo: 'numero', dinero: false, ordenable: true },
  placas: { id: 'placas', etiqueta: 'Placas', tipo: 'lista', dinero: false, ordenable: false },
  proveedor_logistica: { id: 'proveedor_logistica', etiqueta: 'Proveedor de logística', tipo: 'texto', dinero: false, ordenable: true },
  entregado_en: { id: 'entregado_en', etiqueta: 'Entregada', tipo: 'fecha', dinero: false, ordenable: true },
  numero_viaje: { id: 'numero_viaje', etiqueta: 'Viaje n.º', tipo: 'numero', dinero: false, ordenable: true },
  numero_factura: { id: 'numero_factura', etiqueta: 'N.º de factura', tipo: 'texto', dinero: false, ordenable: true },
  enviada_en: { id: 'enviada_en', etiqueta: 'Enviada', tipo: 'fecha', dinero: false, ordenable: true },
  error_factura: { id: 'error_factura', etiqueta: 'Error', tipo: 'texto', dinero: false, ordenable: false },
  situacion_cola: { id: 'situacion_cola', etiqueta: 'Situación', tipo: 'texto', dinero: false, ordenable: true },
  proximo_intento: { id: 'proximo_intento', etiqueta: 'Próximo intento', tipo: 'fecha', dinero: false, ordenable: true },
  saldo: { id: 'saldo', etiqueta: 'Saldo', tipo: 'cop', dinero: true, ordenable: true },
  consumo_diario: { id: 'consumo_diario', etiqueta: 'Consumo diario', tipo: 'cop', dinero: true, ordenable: true },
  dias_cobertura: { id: 'dias_cobertura', etiqueta: 'Días de cobertura', tipo: 'dias', dinero: false, ordenable: true },
  severidad: { id: 'severidad', etiqueta: 'Semáforo', tipo: 'texto', dinero: false, ordenable: false },
  tipo_movimiento: { id: 'tipo_movimiento', etiqueta: 'Tipo', tipo: 'texto', dinero: false, ordenable: true },
  fecha_movimiento: { id: 'fecha_movimiento', etiqueta: 'Fecha', tipo: 'fecha', dinero: false, ordenable: true },
  referencia: { id: 'referencia', etiqueta: 'Boleta', tipo: 'texto', dinero: false, ordenable: true },
  total_declarado: { id: 'total_declarado', etiqueta: 'Total declarado', tipo: 'cop', dinero: true, ordenable: true },
  total_cruzado: { id: 'total_cruzado', etiqueta: 'Total cruzado', tipo: 'cop', dinero: true, ordenable: true },
  diferencia: { id: 'diferencia', etiqueta: 'Diferencia', tipo: 'cop', dinero: true, ordenable: true },
  que_se_gestiono: { id: 'que_se_gestiono', etiqueta: 'Qué se gestionó', tipo: 'texto', dinero: false, ordenable: true },
  funcionario: { id: 'funcionario', etiqueta: 'Funcionario', tipo: 'texto', dinero: false, ordenable: true },
  gestionado_en: { id: 'gestionado_en', etiqueta: 'Gestionado el', tipo: 'fecha', dinero: false, ordenable: true },
  ultimo_movimiento: { id: 'ultimo_movimiento', etiqueta: 'Último movimiento el', tipo: 'fecha', dinero: false, ordenable: true },
  horas_desde_movimiento: { id: 'horas_desde_movimiento', etiqueta: 'Horas desde el último movimiento', tipo: 'horas', dinero: false, ordenable: true },
};

// ── Catálogo de conjuntos (B1) ───────────────────────────────────────────────────────────────────────────

export interface ConjuntoTorreDef {
  readonly id: string;
  readonly entidad: EntidadTorre;
  /** «Borradores abandonados». */
  readonly etiqueta: string;
  /** Texto de «¿Cómo se calcula?». ÚNICA fuente; `{umbral}` y `{doble}` se resuelven con `valoresUmbrales()`. */
  readonly definicion: string;
  /** `null` = foto del momento (ignora el rango); si no, la fecha que lo ancla. */
  readonly fechaBase: FechaBaseTorre | null;
  readonly filtrosIgnorados: readonly (keyof FiltroTorre)[];
  readonly columnas: readonly ColumnaDetalleId[];
  readonly ordenDefecto: { readonly columna: ColumnaDetalleId; readonly dir: 'asc' | 'desc' };
  readonly segmentosAdmitidos: readonly DimensionSegmentoTorre[];
  readonly requiereDinero: boolean;
  /** Operaciones `torre.*` que dan acceso (basta UNA). */
  readonly funcionesOrigen: readonly string[];
  readonly umbral?: ClaveUmbralTorre;
  /**
   * Frase del encabezado del detalle (y de la KPI cuando la cifra ES el conjunto), sin punto final. Marcadores: `{n}`
   * (el total vivo), `{umbral}`, `{doble}` y `{uno|varios}` (singular o plural según `{n}`). Se resuelve con
   * `fraseDeConjunto`. ÚNICA fuente del copy (UX §4.2, columna «Frase (lleno)»).
   */
  readonly frase: string;
  /** Lo que se dice cuando el conjunto está vacío (UX §4.2, «Frase en 0»). Admite `{umbral}` y `{doble}`. */
  readonly fraseVacio: string;
  /** Cola de la frase con los que pasan del doble del umbral (`{c}` y `{uno|varios}` según `{c}`): «4 pasan de 14 días». */
  readonly fraseCriticos?: string;
}

const OPERATIVO = 'torre.tablero_operativo.ver';
const EJECUTIVO = 'torre.tablero_ejecutivo.ver';
const COMERCIAL = 'torre.tablero_comercial.ver';
const FINANCIERO = 'torre.tablero_financiero.ver';
const FOTO = ['rango'] as const;
const SOLO_COMPANIA = ['rango', 'organismos', 'departamentos', 'tiposTramite', 'flitEstados'] as const;
const COLS_TRAMITE = ['codigo_flit', 'placa', 'compania', 'organismo', 'tipo_tramite', 'estado', 'creado_en'] as const;
const COLS_GESTION = ['codigo_flit', 'placa', 'compania', 'estado', 'solicitado_en', 'horas_sin_gestion'] as const;

export const CONJUNTOS_TORRE = [
  {
    id: 'soat_sin_gestion', entidad: 'gestion_soat', etiqueta: 'SOAT sin gestión',
    definicion: 'Gestiones de SOAT pedidas que siguen sin soporte cargado {umbral} horas después de pedidas. Críticas: las que pasan de {doble} horas. El umbral se cambia en Umbrales y alertas. No depende del periodo.',
    fechaBase: null, filtrosIgnorados: SOLO_COMPANIA, columnas: COLS_GESTION,
    ordenDefecto: { columna: 'horas_sin_gestion', dir: 'desc' }, segmentosAdmitidos: ['compania', 'severidad'],
    frase: '{n} {gestión de SOAT lleva|gestiones de SOAT llevan} más de {umbral} horas sin soporte', fraseVacio: 'Todas las gestiones de SOAT tienen soporte dentro de {umbral} horas.', fraseCriticos: '{c} {pasa|pasan} de {doble} horas',
    requiereDinero: false, funcionesOrigen: [OPERATIVO, EJECUTIVO], umbral: 'horas_soat_impuesto_sin_soporte',
  },
  {
    id: 'impuesto_sin_gestion', entidad: 'impuesto', etiqueta: 'Impuestos sin gestión',
    definicion: 'Gestiones de impuesto pedidas que siguen sin soporte cargado {umbral} horas después de pedidas. Críticas: las que pasan de {doble} horas. El umbral se cambia en Umbrales y alertas. No depende del periodo.',
    fechaBase: null, filtrosIgnorados: SOLO_COMPANIA, columnas: COLS_GESTION,
    ordenDefecto: { columna: 'horas_sin_gestion', dir: 'desc' }, segmentosAdmitidos: ['compania', 'severidad'],
    frase: '{n} {gestión de impuesto lleva|gestiones de impuestos llevan} más de {umbral} horas sin soporte', fraseVacio: 'Todas las gestiones de impuestos tienen soporte dentro de {umbral} horas.', fraseCriticos: '{c} {pasa|pasan} de {doble} horas',
    requiereDinero: false, funcionesOrigen: [OPERATIVO, EJECUTIVO], umbral: 'horas_soat_impuesto_sin_soporte',
  },
  {
    id: 'borrador_abandonado', entidad: 'tramite', etiqueta: 'Borradores abandonados',
    definicion: 'Trámites que siguen en estado Borrador más de {umbral} días después de entrar a ese estado: se cuenta desde su último cambio de estado o, si nunca cambió, desde su creación. Críticos: los de más de {doble} días. Es la misma regla de la alerta de Gestión Trámites. El umbral se cambia en Umbrales y alertas. Es la foto de hoy: no depende del periodo elegido.',
    fechaBase: null, filtrosIgnorados: FOTO, columnas: [...COLS_TRAMITE, 'dias_en_estado'],
    ordenDefecto: { columna: 'dias_en_estado', dir: 'desc' }, segmentosAdmitidos: ['compania', 'organismo', 'severidad'],
    frase: '{n} {trámite lleva|trámites llevan} más de {umbral} días en Borrador', fraseVacio: 'Hoy ningún borrador lleva más de {umbral} días.', fraseCriticos: '{c} {pasa|pasan} de {doble} días',
    requiereDinero: false, funcionesOrigen: [OPERATIVO, EJECUTIVO], umbral: 'dias_borrador_abandonado',
  },
  {
    id: 'estancado_ot', entidad: 'tramite', etiqueta: 'En el organismo sin respuesta',
    definicion: 'Trámites en «Entregado» o «Enviado a OT», sin aprobar, cuyo último cambio de estado tiene más de {umbral} días. Críticos: los de más de {doble} días. El umbral se cambia en Umbrales y alertas. No depende del periodo.',
    fechaBase: null, filtrosIgnorados: FOTO, columnas: [...COLS_TRAMITE, 'dias_en_estado'],
    ordenDefecto: { columna: 'dias_en_estado', dir: 'desc' }, segmentosAdmitidos: ['organismo', 'severidad'],
    frase: '{n} {trámite lleva|trámites llevan} más de {umbral} días en el organismo sin respuesta', fraseVacio: 'Ningún trámite lleva más de {umbral} días en el organismo sin respuesta.', fraseCriticos: '{c} {pasa|pasan} de {doble} días',
    requiereDinero: false, funcionesOrigen: [OPERATIVO, EJECUTIVO], umbral: 'dias_respuesta_ot',
  },
  {
    id: 'en_curso', entidad: 'tramite', etiqueta: 'Trámites en curso',
    definicion: 'Trámites sin fecha de aprobación cuyo estado no es Aprobado, Anulado, Abortado, Rechazado ni Revocado. No depende del periodo. Para verlos por estado y antigüedad, vaya a la pestaña Inventario por estado.',
    fechaBase: null, filtrosIgnorados: FOTO, columnas: [...COLS_TRAMITE, 'dias_antiguedad'],
    ordenDefecto: { columna: 'creado_en', dir: 'asc' }, segmentosAdmitidos: ['organismo', 'compania', 'flit_estado'],
    frase: '{n} {trámite está|trámites están} en curso hoy', fraseVacio: 'No hay trámites en curso.',
    requiereDinero: false, funcionesOrigen: [OPERATIVO, EJECUTIVO],
  },
  {
    id: 'inventario_estado', entidad: 'tramite', etiqueta: 'Inventario por estado',
    definicion: 'Trámites en curso hoy, agrupados por su estado actual y por los días que llevan en él, contados desde el último cambio de estado (o desde la creación, si nunca cambió). Los umbrales se cambian en Umbrales y alertas. No depende del periodo.',
    fechaBase: null, filtrosIgnorados: FOTO, columnas: [...COLS_TRAMITE, 'dias_en_estado'],
    ordenDefecto: { columna: 'dias_en_estado', dir: 'desc' }, segmentosAdmitidos: ['flit_estado', 'tramo_antiguedad', 'organismo', 'compania'],
    frase: '{n} {trámite en curso|trámites en curso} hoy', fraseVacio: 'No hay trámites en curso hoy.',
    requiereDinero: false, funcionesOrigen: [OPERATIVO],
  },
  {
    id: 'tramites_creados', entidad: 'tramite', etiqueta: 'Trámites creados',
    definicion: 'Trámites cuya fecha de creación cae en el periodo elegido, con los filtros de arriba.',
    fechaBase: 'creacion', filtrosIgnorados: [], columnas: [...COLS_TRAMITE, 'aprobado_en'],
    ordenDefecto: { columna: 'creado_en', dir: 'desc' }, segmentosAdmitidos: [...AGRUPACIONES_TORRE],
    frase: '{n} {trámite creado|trámites creados} en el periodo', fraseVacio: 'No se crearon trámites en el periodo.',
    requiereDinero: false, funcionesOrigen: [COMERCIAL, OPERATIVO, EJECUTIVO],
  },
  {
    id: 'radicados_cohorte', entidad: 'tramite', etiqueta: 'Trámites radicados',
    definicion: 'De los trámites creados en el periodo, los que ya pasaron por «Entregado» o «Enviado a OT», o ya están aprobados.',
    fechaBase: 'creacion', filtrosIgnorados: [], columnas: [...COLS_TRAMITE, 'aprobado_en'],
    ordenDefecto: { columna: 'creado_en', dir: 'desc' }, segmentosAdmitidos: ['compania'],
    frase: '{n} de los trámites creados en el periodo ya {está radicado|están radicados}', fraseVacio: 'Ningún trámite creado en el periodo está radicado.',
    requiereDinero: false, funcionesOrigen: [COMERCIAL],
  },
  {
    id: 'aprobados_cohorte', entidad: 'tramite', etiqueta: 'Trámites aprobados',
    definicion: 'De los trámites creados en el periodo, los que ya tienen fecha de aprobación.',
    fechaBase: 'creacion', filtrosIgnorados: [], columnas: [...COLS_TRAMITE, 'aprobado_en'],
    ordenDefecto: { columna: 'creado_en', dir: 'desc' }, segmentosAdmitidos: ['compania', 'organismo'],
    frase: '{n} de los trámites creados en el periodo ya {está aprobado|están aprobados}', fraseVacio: 'Ningún trámite creado en el periodo está aprobado.',
    requiereDinero: false, funcionesOrigen: [COMERCIAL, OPERATIVO],
  },
  {
    id: 'facturados_cohorte', entidad: 'tramite', etiqueta: 'Trámites facturados',
    definicion: 'Se parte de los trámites creados en el periodo y se cuentan los que ya tienen factura activa en Siigo.',
    fechaBase: 'creacion', filtrosIgnorados: [], columnas: [...COLS_TRAMITE, 'facturado_en'],
    ordenDefecto: { columna: 'creado_en', dir: 'desc' }, segmentosAdmitidos: ['compania'],
    frase: '{n} de los trámites creados en el periodo ya {tiene|tienen} factura activa en Siigo', fraseVacio: 'Ningún trámite creado en el periodo está facturado.',
    requiereDinero: false, funcionesOrigen: [COMERCIAL],
  },
  {
    id: 'rechazados_cohorte', entidad: 'tramite', etiqueta: 'Trámites rechazados',
    definicion: 'De los trámites creados en el periodo, los que están en estado Rechazado.',
    fechaBase: 'creacion', filtrosIgnorados: [], columnas: [...COLS_TRAMITE],
    ordenDefecto: { columna: 'creado_en', dir: 'desc' }, segmentosAdmitidos: ['organismo'],
    frase: '{n} de los trámites creados en el periodo {está|están} en Rechazado', fraseVacio: 'Ningún trámite creado en el periodo está rechazado.',
    requiereDinero: false, funcionesOrigen: [OPERATIVO],
  },
  {
    id: 'entregas_logistica', entidad: 'liquidacion', etiqueta: 'Entregas de logística',
    definicion: 'Trámites aprobados en el periodo con logística cobrada (sin anulados, abortados ni revocados). Cuentan como primer intento los que no tuvieron un segundo viaje.',
    fechaBase: 'aprobacion', filtrosIgnorados: [], columnas: [...COLS_TRAMITE, 'aprobado_en', 'viajes_adicionales'],
    ordenDefecto: { columna: 'aprobado_en', dir: 'desc' }, segmentosAdmitidos: ['nivel'],
    frase: '{n} {entrega|entregas} de trámites aprobados en el periodo', fraseVacio: 'No hubo entregas en el periodo.',
    // B4: también la abre Logística (E2 «Entregas al primer intento»).
    requiereDinero: false, funcionesOrigen: [OPERATIVO, FUNCION_TABLERO_LOGISTICA_TORRE],
  },
  {
    id: 'sin_facturar', entidad: 'tramite', etiqueta: 'Trabajo sin facturar',
    definicion: 'Trámites aprobados en el periodo que no están en una factura activa de Siigo. El valor es el total de su liquidación. No suman los anulados ni los que no tienen liquidación.',
    fechaBase: 'aprobacion', filtrosIgnorados: [], columnas: [...COLS_TRAMITE, 'aprobado_en', 'valor'],
    ordenDefecto: { columna: 'aprobado_en', dir: 'asc' }, segmentosAdmitidos: ['compania'],
    frase: '{n} {trámite aprobado|trámites aprobados} en el periodo aún no {tiene|tienen} factura', fraseVacio: 'Todo lo aprobado en el periodo ya está facturado.',
    requiereDinero: false, funcionesOrigen: [FINANCIERO, EJECUTIVO],
  },
  {
    id: 'soportes_aprobados', entidad: 'tramite', etiqueta: 'Soportes de los aprobados',
    definicion: 'Por cada trámite aprobado en el periodo se revisa si tiene soporte vigente de SOAT, de impuesto y de derecho. Un soporte descartado no cuenta.',
    fechaBase: 'aprobacion', filtrosIgnorados: [], columnas: [...COLS_TRAMITE, 'aprobado_en', 'faltan_soportes'],
    ordenDefecto: { columna: 'aprobado_en', dir: 'desc' }, segmentosAdmitidos: ['nivel', 'faltante', 'compania'],
    frase: '{n} {trámite aprobado|trámites aprobados} en el periodo', fraseVacio: 'No hay trámites aprobados en el periodo.',
    requiereDinero: false, funcionesOrigen: [FINANCIERO, EJECUTIVO],
  },
  {
    id: 'soportes_faltantes', entidad: 'tramite', etiqueta: 'Aprobados con soportes faltantes',
    definicion: 'Trámites aprobados en el periodo a los que les falta al menos un soporte vigente de SOAT, de impuesto o de derecho. Un soporte descartado no cuenta. Por soporte se cuentan los que no tienen ese soporte: un trámite al que le faltan dos aparece en los dos.',
    fechaBase: 'aprobacion', filtrosIgnorados: [], columnas: [...COLS_TRAMITE, 'aprobado_en', 'faltan_soportes'],
    ordenDefecto: { columna: 'aprobado_en', dir: 'desc' }, segmentosAdmitidos: ['faltante', 'compania', 'organismo'],
    frase: '{n} {trámite aprobado|trámites aprobados} en el periodo no {tiene|tienen} todos sus soportes', fraseVacio: 'Todos los aprobados del periodo tienen sus tres soportes.',
    requiereDinero: false, funcionesOrigen: [OPERATIVO, FINANCIERO, EJECUTIVO],
  },
  {
    id: 'margen_aprobados', entidad: 'liquidacion', etiqueta: 'Aprobados con liquidación',
    definicion: 'Lo cobrado en las liquidaciones de los aprobados del periodo, menos el costo de SOAT, impuesto, derecho y logística, dividido entre lo cobrado. El trámite digital no tiene costo en FLITO.',
    fechaBase: 'aprobacion', filtrosIgnorados: [], columnas: [...COLS_TRAMITE, 'aprobado_en', 'valor'],
    ordenDefecto: { columna: 'aprobado_en', dir: 'desc' }, segmentosAdmitidos: ['compania'],
    frase: '{n} {trámite aprobado|trámites aprobados} con liquidación en el periodo', fraseVacio: 'No hay trámites aprobados en el periodo.',
    requiereDinero: true, funcionesOrigen: [FINANCIERO],
  },
  // B3: el área Productos (SOAT · Impuestos · Derechos), en `flito-torre-productos.ts`.
  ...CONJUNTOS_PRODUCTOS_TORRE,
  // B4: Logística (Traslados · Entregas) y Financiera (Facturación · Bolsas), en `flito-torre-logistica.ts`.
  ...CONJUNTOS_LOGISTICA_TORRE,
  ...CONJUNTOS_FINANCIERA_B4_TORRE,
  // B5: Operativa › Equipo (solo `torre.equipo.ver`), en `flito-torre-equipo.ts`.
  ...CONJUNTOS_EQUIPO_TORRE,
] as const satisfies readonly ConjuntoTorreDef[];

export type ConjuntoTorreId = (typeof CONJUNTOS_TORRE)[number]['id'];
export const CONJUNTOS_TORRE_IDS = CONJUNTOS_TORRE.map((c) => c.id) as unknown as readonly [ConjuntoTorreId, ...ConjuntoTorreId[]];
export const conjuntoTorre = (id: ConjuntoTorreId): ConjuntoTorreDef => CONJUNTOS_TORRE.find((c) => c.id === id)!;

/**
 * Definición de las cifras que NO son un conjunto de registros sino un bloque ya visible (ADR-0047 D3) o la suma de dos
 * conjuntos. Misma regla que `CONJUNTOS_TORRE`: se escriben aquí una sola vez; `{umbral}`/`{umbral2}` los resuelve la API.
 */
export const DEFINICIONES_BLOQUE_TORRE = {
  fuga: 'Por compañía: los trámites creados en los últimos {umbral} días frente a su promedio de los 90 días anteriores, llevado a la misma ventana. Entra si la caída es de {umbral2} % o más. Los dos valores se cambian en Umbrales y alertas. No depende del periodo.',
  bolsas: 'Saldo de hoy de la bolsa dividido entre su consumo diario promedio de los últimos 30 días. Bajo {umbral} días es crítico y bajo {umbral2}, atención; se cambia en Umbrales y alertas. No depende del periodo.',
  sin_gestion: 'Gestiones de SOAT e impuestos sin soporte cargado {umbral} horas después de pedidas. El umbral se cambia en Umbrales y alertas. No depende del periodo.',
  concentracion: 'Trámites creados en el periodo, agrupados por compañía. Se suman las 3 con más trámites y se dividen entre el total. En el bloque Concentración, la vista Ingreso hace lo mismo con lo liquidado de los aprobados.',
  periodo_anterior: 'Trámites cuya fecha de creación cae en el periodo elegido, con los filtros de arriba. El periodo anterior tiene la misma duración y termina el día antes.',
  ans_aprobacion: 'Trámites aprobados en el mes cuya aprobación llegó dentro de {umbral} días desde su creación.',
} as const;
export type BloqueDefinicionTorre = keyof typeof DEFINICIONES_BLOQUE_TORRE;

/** Resuelve `{umbral}` / `{umbral2}` de un texto. */
/** Reemplaza todas las apariciones (sin `replaceAll`: la web compila con `lib` anterior a ES2021). */
const reemplazar = (texto: string, marca: string, valor: string): string => texto.split(marca).join(valor);

export const textoConUmbrales = (texto: string, umbral?: number, umbral2?: number): string => {
  const conPrimero = umbral == null ? texto : reemplazar(texto, '{umbral}', String(umbral));
  return umbral2 == null ? conPrimero : reemplazar(conPrimero, '{umbral2}', String(umbral2));
};

/** `{uno|varios}` según `n`. */
const conNumero = (texto: string, n: number): string => texto.replace(/\{([^{}|]+)\|([^{}|]+)\}/g, (_, uno: string, varios: string) => (n === 1 ? uno : varios));

/**
 * La frase del conjunto con su total vivo (y, si se conocen, los que pasan del doble del umbral). Con `n = 0` devuelve
 * `fraseVacio`. Una sola fuente para el encabezado del detalle y para la KPI que es ese conjunto.
 */
export function fraseDeConjunto(def: ConjuntoTorreDef, n: number, valorUmbral?: number, criticos?: number): string {
  const umbrales = (t: string): string => (valorUmbral == null ? t
    : reemplazar(reemplazar(t, '{umbral}', String(valorUmbral)), '{doble}', String(valorUmbral * 2)));
  if (n === 0) return umbrales(def.fraseVacio);
  const base = reemplazar(conNumero(umbrales(def.frase), n), '{n}', n.toLocaleString('es-CO'));
  const cola = def.fraseCriticos && criticos != null && criticos > 0
    ? `; ${reemplazar(conNumero(umbrales(def.fraseCriticos), criticos), '{c}', criticos.toLocaleString('es-CO'))}` : '';
  return `${base}${cola}.`;
}

/** Resuelve `{umbral}` / `{doble}` de una definición con el valor vigente del umbral. */
export function definicionConUmbral(def: ConjuntoTorreDef, valorUmbral?: number): string {
  if (valorUmbral == null) return def.definicion;
  return reemplazar(reemplazar(def.definicion, '{umbral}', String(valorUmbral)), '{doble}', String(valorUmbral * 2));
}

/** Detalle de cada métrica del Explorador: la entidad = las filas del `desde` de la métrica. */
const COLS_METRICA_TRAMITE = [...COLS_TRAMITE, 'aprobado_en'] as const;
export const DETALLE_METRICA_TORRE: Readonly<Record<MetricaTorreId, { entidad: EntidadTorre; columnas: readonly ColumnaDetalleId[] }>> = {
  tramites: { entidad: 'tramite', columnas: COLS_METRICA_TRAMITE },
  tramites_creados: { entidad: 'tramite', columnas: COLS_METRICA_TRAMITE },
  tramites_aprobados: { entidad: 'tramite', columnas: COLS_METRICA_TRAMITE },
  tiempo_creacion_aprobacion: { entidad: 'tramite', columnas: [...COLS_METRICA_TRAMITE, 'horas_ciclo'] },
  costo_logistica: { entidad: 'liquidacion', columnas: [...COLS_METRICA_TRAMITE, 'valor'] },
  impuestos_pagados: { entidad: 'impuesto', columnas: ['codigo_flit', 'placa', 'compania', 'organismo', 'estado', 'valor'] },
  derechos_pagados: { entidad: 'derecho', columnas: ['codigo_flit', 'placa', 'compania', 'organismo', 'estado', 'valor'] },
  ingreso_liquidado: { entidad: 'liquidacion', columnas: [...COLS_METRICA_TRAMITE, 'valor'] },
  wip_activo: { entidad: 'tramite', columnas: [...COLS_TRAMITE, 'dias_antiguedad'] },
  dias_en_estado: { entidad: 'tramite', columnas: [...COLS_TRAMITE, 'dias_en_estado'] },
  tasa_aprobacion: { entidad: 'tramite', columnas: [...COLS_METRICA_TRAMITE, 'aprobado'] },
  sin_facturar: { entidad: 'tramite', columnas: COLS_METRICA_TRAMITE },
  // B3: sin dirección, VIN ni póliza completa (la póliza no se proyecta en el Explorador).
  soat_gestionados: { entidad: 'gestion_soat', columnas: ['codigo_flit', 'placa', 'compania', 'organismo', 'estado', 'creado_en', 'pagado_en'] },
  soat_pagados_valor: { entidad: 'gestion_soat', columnas: ['codigo_flit', 'placa', 'compania', 'organismo', 'estado', 'pagado_en', 'valor'] },
  impuestos_gestionados: { entidad: 'impuesto', columnas: ['codigo_flit', 'placa', 'compania', 'organismo', 'estado', 'creado_en', 'pagado_en'] },
  derechos_registrados: { entidad: 'derecho', columnas: ['codigo_flit', 'placa', 'compania', 'organismo', 'creado_en', 'fecha_pago'] },
};

/** Operación que da acceso al detalle de una métrica del Explorador. */
export const FUNCION_ORIGEN_METRICA_TORRE = 'torre.metricas.consultar';

// ── Consulta y resultado ─────────────────────────────────────────────────────────────────────────────────

export type OrigenDetalle =
  | { tipo: 'conjunto'; conjunto: ConjuntoTorreId }
  | { tipo: 'metrica'; metrica: MetricaTorreId; fechaBase?: FechaBaseTorre };

export interface FiltrosDetalleTorre {
  /** SOLO body (AGENTS §14); 3–7 [A-Z0-9], coincidencia por prefijo. */
  placa?: string;
  /** Se suman (AND) al filtro global. */
  companiaIds?: number[];
  estados?: string[];
}

export interface OrdenDetalle { columna: ColumnaDetalleId; dir: 'asc' | 'desc' }

export interface ConsultaDetalle {
  origen: OrigenDetalle;
  /** ≤ 3 (fila y columna de un cruce; en el inventario, estado × tramo × organismo). */
  segmentos?: SegmentoDetalle[];
  filtro: FiltroTorre;
  filtrosDetalle?: FiltrosDetalleTorre;
  orden?: OrdenDetalle;
  /** 1-based. */
  pagina: number;
  tamano: 25 | 50 | 100;
}
export type ExportarDetalle = Omit<ConsultaDetalle, 'pagina' | 'tamano'>;

export type ValorCelda = string | number | boolean | string[] | null;
export interface FilaDetalle { id: string; tramiteId: string | null; celdas: Partial<Record<ColumnaDetalleId, ValorCelda>> }

export interface DefinicionCifra { etiqueta: string; definicion: string; fechaBase: FechaBaseTorre | null; campoFecha: string }

export interface ResultadoDetalle {
  origen: OrigenDetalle;
  segmentos: SegmentoDetalle[];
  definicion: DefinicionCifra;
  total: number;
  /** Métricas de suma (y conjuntos con columna `valor`): Σ sobre TODO el conjunto. `null` sin dinero o si no aplica. */
  valorTotal: number | null;
  columnas: ColumnaDetalle[];
  filas: FilaDetalle[];
  pagina: number;
  tamano: number;
  /** `total > FILAS_DETALLE_PAGINABLE_MAX`: hay registros que se cuentan pero no se pueden paginar. */
  truncado: boolean;
  /** Frase del encabezado con el `total` vivo y los umbrales resueltos (`fraseDeConjunto`); con 0, la de vacío. */
  frase: string;
  /** Lo que se dice cuando la lista queda vacía con estos filtros (propio de cada conjunto). */
  fraseVacio: string;
  filtrosIgnorados: (keyof FiltroTorre)[];
  rango: { desde: string; hasta: string } | null;
  dineroVisible: boolean;
  generadoEn: string;
}

// ── KPI explicable (se añade a cada Tablero*) ────────────────────────────────────────────────────────────

export type DestinoCifra =
  | { tipo: 'conjunto'; origen: OrigenDetalle; segmentos?: SegmentoDetalle[] }
  /** ADR-0047 D3: la cifra es una lista de compañías/bolsas ya visible en el bloque. */
  | { tipo: 'bloque'; bloque: string }
  | { tipo: 'ninguno' };

export interface ComponenteCifra { etiqueta: string; valor: number; pct?: number | null; destino?: DestinoCifra }

export interface CifraExplicada {
  /** «98 % de los trámites creados en el periodo vienen de 3 compañías: A, B y C». */
  frase: string;
  /** = `CONJUNTOS_TORRE[c].definicion` con `{umbral}` resuelto. */
  definicion: string;
  destino: DestinoCifra;
  /** Nombres que forman la cifra (Top 3 con %). */
  componentes?: ComponenteCifra[];
  /** Lo que la explica (de 12 abandonados, 4 pasan del doble del umbral). */
  desglose?: ComponenteCifra[];
}

/** Explicaciones por clave de `cifras` de un tablero. */
export type ExplicacionesTablero<C> = Partial<Record<keyof C & string, CifraExplicada>>;

// ── Inventario por estado y soportes faltantes (B2: Operativa › Inventario por estado · Soportes) ─────────────

/** Una cifra de la matriz. `destino` = el detalle `inventario_estado` con sus segmentos; en 0, `{ tipo: 'ninguno' }`. */
export interface CeldaInventarioTorre {
  n: number;
  /**
   * ▲ (UX §6.2): al menos un trámite de la celda pasa el umbral de SU estado (Borrador: `dias_borrador_abandonado`;
   * «Entregado»/«Enviado a OT»: `dias_respuesta_ot`). Los estados sin umbral y los totales nunca se marcan.
   */
  sobreUmbral: boolean;
  destino: DestinoCifra;
}

export interface FilaInventarioTorre {
  /** Valor crudo de `flit_estado` (`null` = sin estado): el segmento `flit_estado` del destino. */
  estado: string | null;
  etiqueta: string;
  /** Umbral que marca la fila; `null` = estado sin umbral. */
  umbral: { clave: ClaveUmbralTorre; valor: number } | null;
  celdas: Record<TramoAntiguedadTorre, CeldaInventarioTorre>;
  total: CeldaInventarioTorre;
}

/** Respuesta de `POST /api/flito/torre/tableros/operativa/inventario` (foto de hoy). */
export interface InventarioEstadoTorre {
  /** Columnas en orden (`TRAMOS_ANTIGUEDAD_TORRE`). */
  tramos: { clave: TramoAntiguedadTorre; etiqueta: string }[];
  /** En el orden del flujo del trámite; los estados sin orden conocido van al final, por nombre. */
  filas: FilaInventarioTorre[];
  /** Totales por columna y el general (= O3 «Trámites en curso» sin organismo). */
  totales: { celdas: Record<TramoAntiguedadTorre, CeldaInventarioTorre>; total: CeldaInventarioTorre };
  /** Organismo elegido (se suma al filtro de la Torre) o `null` = todos. */
  organismo: string | null;
  /** Opciones del selector: organismos con trámites en curso bajo el filtro de la Torre (sin el organismo elegido). */
  organismos: { codigo: string; nombre: string }[];
  /** «312 trámites en curso hoy, por estado y por días en ese estado.» */
  frase: string;
  /** «¿Cómo se calcula?» (= `CONJUNTOS_TORRE.inventario_estado.definicion`). */
  definicion: string;
  /** «▲ Pasa el umbral de ese estado (Borrador: 7 días; en el organismo: 10 días).» */
  leyendaUmbral: string;
  generadoEn: string;
}

/** Respuesta de `POST /api/flito/torre/tableros/operativa/soportes` (aprobados del periodo). */
export interface SoportesFaltantesTorre {
  /** Aprobados del periodo (= `soportes_aprobados`). */
  aprobados: number;
  /** Aprobados a los que les falta al menos uno (= `soportes_faltantes`). */
  incompletos: { n: number; destino: DestinoCifra };
  /** Por soporte: los que no lo tienen (= `soportes_faltantes` + segmento `faltante`). */
  porFaltante: { faltante: (typeof VALORES_FALTANTE_SOPORTE)[number]; etiqueta: string; n: number; destino: DestinoCifra }[];
  frase: string;
  definicion: string;
  rango: { desde: string; hasta: string };
  generadoEn: string;
}
