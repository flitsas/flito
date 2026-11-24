// Torre de Control Gerencial (Épica #14590, ADR-0047) — DETALLE UNIVERSAL: los registros detrás de una cifra.
//
// RN-TOR-D1: el `total` sale del MISMO fragmento con que cuenta el tablero o la celda (`flito-torre.conjuntos.ts`).
// RN-TOR-D9: acceso = `torre.detalle.ver` (ruta) + UNA de las `funcionesOrigen` del conjunto (o
//   `torre.metricas.consultar` para una métrica): sin ninguna, `DetalleSinOrigenError` (403 SIN_ORIGEN). Un conjunto o
//   métrica `requiereDinero` sin `FUNCION_TORRE_DINERO` es 403 SIN_DINERO; en los demás, las columnas de dinero van `null`.
// RN-TOR-D10: el servicio VUELVE a exigir cada regla de Zod (segmento admitido, orden ordenable, fecha base de la
//   matriz, `pagina*tamano ≤ FILAS_DETALLE_PAGINABLE_MAX`): lo que queda fuera es `TorreConsultaInvalidaError` (400).
// RN-TOR-D11: Redis guarda SOLO `{ total, valorTotal }` (clave sha256); las filas, que llevan placa, nunca se cachean.
// RN-TOR-D12: exportar exige `total ≤ FILAS_DETALLE_EXPORTAR_MAX`; si se pasa, `DetalleExcedeTopeError` (422), nunca
//   un recorte silencioso.
// RN-TOR-D13: no se loguea el body ni `filtrosDetalle` (placa); `enTorre` solo loguea el código de Postgres.
import {
  COLUMNAS_DETALLE, DETALLE_METRICA_TORRE, FUNCION_ORIGEN_METRICA_TORRE, TOPES_TORRE, conjuntoTorre,
  definicionConUmbral, esAgrupacionPermitida, fraseDeConjunto, esFechaBasePermitida, metricaTorre,
  type ColumnaDetalleId, type ConsultaDetalle, type DefinicionCifra, type ExportarDetalle, type FilaDetalle,
  type ResultadoDetalle, type SegmentoDetalle, type ValorCelda,
} from '@operaciones/shared-types';
import type { AlcanceResuelto } from '../../shared/middleware/frontera-enlace.js';
import { resolverDef } from './flito-torre.catalogo.js';
import {
  fragmentoConjunto, fragmentoMetrica, listarFragmento, totalFragmento, type FragmentoDetalle, type OrdenFragmento,
  type TotalFragmento,
} from './flito-torre.conjuntos.js';
import { exigirTopesRango, resolverRango, type RangoResuelto } from './flito-torre.filtro.js';
import {
  claveCache, enTorre, guardarCache, leerCache, nombreOrganismo, nombresCompania, SIN_COMPANIA, type Ejecutor,
} from './flito-torre.metricas.service.js';
import { ErrorDominioTorre, TorreConsultaInvalidaError } from './flito-torre.service.js';
import { hoyDe, type ContextoTablero } from './flito-torre.tablero-comun.js';
import { valoresUmbrales } from './flito-torre.umbrales.service.js';

export class DetalleSinOrigenError extends ErrorDominioTorre {
  readonly code = 'SIN_ORIGEN';
  constructor() { super('Su rol no tiene acceso al tablero de donde sale esta cifra.'); }
}

export class DetalleSinDineroError extends ErrorDominioTorre {
  readonly code = 'SIN_DINERO';
  constructor() { super('Su rol no tiene permiso para ver valores en dinero de la Torre.'); }
}

/**
 * B5 (UX «Equipo sin Excel en v1»): los detalles de Operativa › Equipo (entidad `funcionario`) se consultan pero no se
 * descargan: es información de desempeño de personas. 403 con código propio, antes de resolver nada.
 */
export class DetalleSinExportacionError extends ErrorDominioTorre {
  readonly code = 'DETALLE_SIN_EXPORTACION';
  constructor() { super('La lista de gestiones del equipo se puede consultar, pero no descargar.'); }
}

export class DetalleExcedeTopeError extends ErrorDominioTorre {
  readonly code = 'DETALLE_EXCEDE_TOPE';
  constructor() { super(`Hay más de ${TOPES_TORRE.FILAS_DETALLE_EXPORTAR_MAX.toLocaleString('es-CO')} registros. Acote el periodo o los filtros.`); }
}

export interface AccesoDetalle {
  alcance: AlcanceResuelto;
  /** ¿Tiene `FUNCION_TORRE_DINERO`? */
  dinero: boolean;
  /** Operaciones `torre.*` de origen que tiene el usuario (la ruta las lee con `tieneFuncion` literal). */
  funciones: ReadonlySet<string>;
  /** Día de hoy en Bogotá (tests). */
  hoy?: string;
}

/** Lo resuelto de una consulta de detalle: fragmento, columnas, orden y definición. */
interface Resuelto {
  f: FragmentoDetalle;
  columnas: ColumnaDetalleId[];
  orden: OrdenFragmento;
  definicion: DefinicionCifra;
  filtrosIgnorados: ResultadoDetalle['filtrosIgnorados'];
  rango: RangoResuelto | null;
  segmentos: SegmentoDetalle[];
  /** Frase del encabezado con el total vivo (la del catálogo; en métricas, la genérica). */
  frase: (t: TotalFragmento) => string;
  fraseVacio: string;
}

const TEMPORALES = new Set(['dia', 'semana', 'mes', 'trimestre']);

async function resolver(c: ExportarDetalle, acc: AccesoDetalle): Promise<Resuelto> {
  const ctx: ContextoTablero = { filtro: c.filtro, alcance: acc.alcance, dinero: acc.dinero, hoy: acc.hoy };
  const segmentos = c.segmentos ?? [];
  if (segmentos.length > TOPES_TORRE.SEGMENTOS_MAX) throw new TorreConsultaInvalidaError('segmentos', `a lo sumo ${TOPES_TORRE.SEGMENTOS_MAX}`);
  if (segmentos.some((s) => !s.valores.length || s.valores.length > TOPES_TORRE.VALORES_SEGMENTO_MAX)) {
    throw new TorreConsultaInvalidaError('segmentos', `de 1 a ${TOPES_TORRE.VALORES_SEGMENTO_MAX} valores`);
  }
  let r: Omit<Resuelto, 'orden'> & { ordenDefecto: OrdenFragmento; ordenables: ColumnaDetalleId[] };
  if (c.origen.tipo === 'conjunto') {
    const def = conjuntoTorre(c.origen.conjunto);
    if (!def.funcionesOrigen.some((fn) => acc.funciones.has(fn))) throw new DetalleSinOrigenError();
    if (def.requiereDinero && !acc.dinero) throw new DetalleSinDineroError();
    const u = await valoresUmbrales();
    const f = fragmentoConjunto(c.origen.conjunto, ctx, u, segmentos, c.filtrosDetalle);
    r = {
      f, columnas: [...def.columnas], rango: f.rango, segmentos, filtrosIgnorados: [...def.filtrosIgnorados],
      definicion: { etiqueta: def.etiqueta, definicion: definicionConUmbral(def, def.umbral ? u[def.umbral] : undefined), fechaBase: def.fechaBase, campoFecha: f.campoFecha },
      ordenDefecto: { ...def.ordenDefecto }, ordenables: [...def.columnas].filter((col) => COLUMNAS_DETALLE[col].ordenable),
      frase: (t) => fraseDeConjunto(def, t.total, def.umbral ? u[def.umbral] : undefined, t.criticos),
      fraseVacio: fraseDeConjunto(def, 0, def.umbral ? u[def.umbral] : undefined),
    };
  } else {
    const { metrica, fechaBase } = c.origen;
    if (!acc.funciones.has(FUNCION_ORIGEN_METRICA_TORRE)) throw new DetalleSinOrigenError();
    const meta = metricaTorre(metrica);
    if (meta.requiereDinero && !acc.dinero) throw new DetalleSinDineroError();
    if (fechaBase && !esFechaBasePermitida(metrica, fechaBase)) throw new TorreConsultaInvalidaError('origen.fechaBase', 'esa fecha base no aplica a la métrica');
    for (const s of segmentos) {
      if (!esAgrupacionPermitida(metrica, s.dimension as never)) throw new TorreConsultaInvalidaError('segmentos', 'esa dimensión no aplica a la métrica');
    }
    const def = resolverDef(metrica, fechaBase);
    let rango: RangoResuelto | null = null;
    if (def.fecha) {
      rango = resolverRango(c.filtro.rango, hoyDe(ctx));
      exigirTopesRango(rango, segmentos.find((s) => s.dimension === 'dia') ? 'dia' : undefined);
    }
    const det = DETALLE_METRICA_TORRE[metrica];
    const f = fragmentoMetrica(def, det.entidad, ctx, rango, segmentos, c.filtrosDetalle);
    const tiempo = def.forma === 'tiempo' ? ' No se listan los trámites sin fecha de creación en FLIT.' : '';
    r = {
      f, columnas: [...det.columnas], rango, segmentos, filtrosIgnorados: def.fecha ? [] : ['rango'],
      definicion: { etiqueta: meta.etiqueta, definicion: `${meta.etiqueta}: los registros que forman la cifra del Explorador con los filtros de arriba.${tiempo}`, fechaBase: def.fechaBase, campoFecha: def.campoFecha },
      ordenDefecto: { columna: det.columnas.includes('aprobado_en') && def.fechaBase === 'aprobacion' ? 'aprobado_en' : 'creado_en', dir: 'desc' },
      ordenables: [...det.columnas].filter((col) => COLUMNAS_DETALLE[col].ordenable),
      frase: (t) => `${t.total.toLocaleString('es-CO')} ${meta.etiqueta.toLowerCase()} con los filtros de arriba.`,
      fraseVacio: `Sin registros de ${meta.etiqueta.toLowerCase()} con los filtros de arriba.`,
    };
    if (segmentos.some((s) => TEMPORALES.has(s.dimension)) && !def.fecha) throw new TorreConsultaInvalidaError('segmentos', 'un corte de tiempo no aplica a una foto');
  }
  if (c.orden && !r.ordenables.includes(c.orden.columna)) throw new TorreConsultaInvalidaError('orden', 'esa columna no se puede ordenar en este detalle');
  // Sin permiso de dinero no se ordena por una columna de dinero (el orden la revelaría).
  if (c.orden && COLUMNAS_DETALLE[c.orden.columna].dinero && !acc.dinero) throw new TorreConsultaInvalidaError('orden', 'esa columna no se puede ordenar sin permiso de dinero');
  const orden = c.orden ?? (r.ordenables.includes(r.ordenDefecto.columna) ? r.ordenDefecto : { columna: r.ordenables[0]!, dir: 'desc' as const });
  return {
    f: r.f, columnas: r.columnas, orden, definicion: r.definicion, filtrosIgnorados: r.filtrosIgnorados, rango: r.rango, segmentos,
    frase: r.frase, fraseVacio: r.fraseVacio,
  };
}

// ── Celdas ─────────────────────────────────────────────────────────────────────────────────────────────

const aTexto = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
const aNumero = (v: unknown, decimales = 0): number | null => {
  if (v == null) return null;
  const n = Number(v);
  const p = 10 ** decimales;
  return Number.isFinite(n) ? Math.round(n * p) / p : null;
};
const aLista = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') return v.replace(/^\{|\}$/g, '').split(',').filter(Boolean);
  return [];
};

async function aFilas(q: Ejecutor, crudas: Record<string, unknown>[], columnas: readonly ColumnaDetalleId[], dinero: boolean): Promise<FilaDetalle[]> {
  const ids = columnas.includes('compania') ? crudas.map((c) => c.compania).filter((v) => v != null).map(Number) : [];
  const nombres = await nombresCompania(q, ids);
  return crudas.map((c) => {
    const celdas: Partial<Record<ColumnaDetalleId, ValorCelda>> = {};
    for (const col of columnas) {
      const meta = COLUMNAS_DETALLE[col];
      const v = c[col];
      if (meta.dinero && !dinero) { celdas[col] = null; continue; }
      switch (col) {
        case 'compania': celdas[col] = v == null ? SIN_COMPANIA : nombres.get(Number(v)) ?? `Compañía ${v}`; break;
        case 'organismo': celdas[col] = nombreOrganismo(v == null ? null : String(v)); break;
        case 'aprobado': celdas[col] = v == null ? null : Boolean(v); break;
        default:
          // `lista`: `faltan_soportes` y (B4) las `placas` de un acta. B4: los días de cobertura van con un decimal.
          celdas[col] = meta.tipo === 'lista' ? aLista(v)
            : meta.tipo === 'fecha' || meta.tipo === 'texto' ? aTexto(v)
              : aNumero(v, meta.tipo === 'horas' || col === 'dias_cobertura' ? 1 : 0);
      }
    }
    return { id: String(c.__id), tramiteId: c.__tramite == null ? null : String(c.__tramite), celdas };
  });
}

/** RN-TOR-D11: total (suma y críticos: solo números) con caché de 60 s; la clave es un sha256, nunca la placa en claro. */
async function totalConCache(q: Ejecutor, c: ExportarDetalle, r: Resuelto, acc: AccesoDetalle): Promise<TotalFragmento> {
  const clave = claveCache('detalle-total', c.origen, r.segmentos, c.filtro, c.filtrosDetalle ?? null, acc.alcance, acc.dinero, acc.hoy ?? null, r.rango);
  const cacheado = await leerCache<TotalFragmento>(clave);
  if (cacheado) return cacheado;
  const t = await totalFragmento(q, r.f);
  await guardarCache(clave, t);
  return t;
}

const columnasDe = (cols: readonly ColumnaDetalleId[]) => cols.map((c) => COLUMNAS_DETALLE[c]);

/** `POST /detalle/consultar`. */
export async function consultarDetalle(c: ConsultaDetalle, acc: AccesoDetalle): Promise<ResultadoDetalle> {
  const pagina = c.pagina ?? 1;
  const tamano = c.tamano ?? 50;
  if (![25, 50, 100].includes(tamano)) throw new TorreConsultaInvalidaError('tamano', 'debe ser 25, 50 o 100');
  if (pagina * tamano > TOPES_TORRE.FILAS_DETALLE_PAGINABLE_MAX) {
    throw new TorreConsultaInvalidaError('pagina', `solo se pueden paginar los primeros ${TOPES_TORRE.FILAS_DETALLE_PAGINABLE_MAX.toLocaleString('es-CO')} registros`);
  }
  const r = await resolver(c, acc);
  return enTorre(async (q) => {
    const t = await totalConCache(q, c, r, acc);
    const { total, valorTotal } = t;
    const crudas = await listarFragmento(q, r.f, r.columnas, r.orden, tamano, (pagina - 1) * tamano);
    return {
      origen: c.origen, segmentos: r.segmentos, definicion: r.definicion, total, frase: r.frase(t), fraseVacio: r.fraseVacio,
      valorTotal: acc.dinero ? valorTotal : null,
      columnas: columnasDe(r.columnas), filas: await aFilas(q, crudas, r.columnas, acc.dinero),
      pagina, tamano, truncado: total > TOPES_TORRE.FILAS_DETALLE_PAGINABLE_MAX,
      filtrosIgnorados: r.filtrosIgnorados, rango: r.rango, dineroVisible: acc.dinero, generadoEn: new Date().toISOString(),
    };
  });
}

export interface DatosExportacionDetalle {
  resultado: Omit<ResultadoDetalle, 'pagina' | 'tamano'>;
  /** Para el nombre del archivo (nunca una placa ni una compañía). */
  nombreOrigen: string;
}

/** `POST /detalle/exportar`: todas las filas (≤ `FILAS_DETALLE_EXPORTAR_MAX`, si no 422). */
export async function datosExportacion(c: ExportarDetalle, acc: AccesoDetalle): Promise<DatosExportacionDetalle> {
  if (esDetalleDeEquipo(c)) throw new DetalleSinExportacionError();
  const r = await resolver(c, acc);
  return enTorre(async (q) => {
    const t = await totalFragmento(q, r.f);
    const { total, valorTotal } = t;
    if (total > TOPES_TORRE.FILAS_DETALLE_EXPORTAR_MAX) throw new DetalleExcedeTopeError();
    const crudas = await listarFragmento(q, r.f, r.columnas, r.orden, TOPES_TORRE.FILAS_DETALLE_EXPORTAR_MAX, 0);
    return {
      nombreOrigen: c.origen.tipo === 'conjunto' ? c.origen.conjunto : c.origen.metrica,
      resultado: {
        origen: c.origen, segmentos: r.segmentos, definicion: r.definicion, total, frase: r.frase(t), fraseVacio: r.fraseVacio,
        valorTotal: acc.dinero ? valorTotal : null, columnas: columnasDe(r.columnas),
        filas: await aFilas(q, crudas, r.columnas, acc.dinero), truncado: false,
        filtrosIgnorados: r.filtrosIgnorados, rango: r.rango, dineroVisible: acc.dinero, generadoEn: new Date().toISOString(),
      },
    };
  });
}

/** B5: ¿el detalle es de un conjunto de Equipo (entidad `funcionario`)? */
export const esDetalleDeEquipo = (c: ExportarDetalle): boolean =>
  c.origen.tipo === 'conjunto' && conjuntoTorre(c.origen.conjunto).entidad === 'funcionario';

/**
 * Campos de `pii_access_log`: la placa y, en los detalles de Equipo, también el funcionario (cada fila lleva su nombre:
 * es un dato del empleado y la lectura queda registrada).
 */
export function camposPiiDe(c: ExportarDetalle): string[] {
  return esDetalleDeEquipo(c) ? ['placa', 'funcionario'] : ['placa'];
}

/** Tabla de la entidad para `pii_access_log` (sin consultar: la ruta registra antes de resolver). */
export function tablaPiiDe(c: ExportarDetalle): string {
  const entidad = c.origen.tipo === 'conjunto' ? conjuntoTorre(c.origen.conjunto).entidad : DETALLE_METRICA_TORRE[c.origen.metrica].entidad;
  const TABLAS: Record<string, string> = {
    tramite: 'flito_tramite', liquidacion: 'flito_liquidaciones', gestion_soat: 'flito_soat', impuesto: 'flito_impuestos', derecho: 'flito_derechos_tramite',
    // B3 (Productos).
    soat_incompleta: 'flito_soat_incompletas', derecho_pendiente: 'flito_derechos_pendientes',
    // B4 (Logística y Financiera).
    traslado: 'flito_logistica_traslados', acta: 'flito_logistica_actas', viaje_logistica: 'flito_tramite_viajes_logistica',
    factura: 'siigo_facturas', cola_facturacion: 'siigo_cola_facturacion', bolsa: 'flito_bolsas_unicas',
    movimiento_bolsa: 'flito_bolsas_unicas_movimientos', boleta: 'flito_conciliacion_boletas',
    // B5 (Equipo): la gestión con autor; la placa sale del trámite, el SOAT, el impuesto o la incompleta.
    funcionario: 'flito_estado_historial',
  };
  return TABLAS[entidad] ?? 'flito_tramite';
}

/** ¿El detalle proyecta la placa (o, B4, las placas de un acta)? (AC10: se registra aunque traiga 0 filas). */
export function proyectaPlaca(c: ExportarDetalle): boolean {
  const cols: readonly ColumnaDetalleId[] = c.origen.tipo === 'conjunto' ? conjuntoTorre(c.origen.conjunto).columnas : DETALLE_METRICA_TORRE[c.origen.metrica].columnas;
  return cols.includes('placa') || cols.includes('placas');
}
