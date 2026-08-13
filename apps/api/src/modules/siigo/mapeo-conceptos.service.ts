// Siigo API — mapeo de conceptos facturables a productos (HU #11282, Feature #11240).
//
// Este módulo es la fuente de verdad de CÓMO se factura cada concepto: qué producto es en Siigo, si
// está gravado, exento o excluido, qué impuestos lleva, en qué unidad se mide y si es dinero
// recibido para terceros. Todo eso son DATOS de `siigo_mapeo_conceptos`, no constantes ni ramas del
// programa (AC3).
//
// Reglas que conviene no revertir sin pensarlo:
//
//   1. NINGUNA condición sobre un concepto concreto. En este archivo no aparece escrito el nombre
//      de ninguno de los seis: viven en `CONCEPTOS_FACTURABLES` (shared-types) y en la semilla de
//      la migración 0128. El test de AC3 lo verifica leyendo este fuente, porque es el tipo de
//      regla que se rompe sola en el primer «arreglo rápido».
//   2. `ambiente` entra en toda consulta. El código de producto y los ids de impuesto pertenecen a
//      UNA empresa de Siigo; leer el mapeo sin ambiente devolvería la configuración de la empresa
//      equivocada. La justificación larga está en la cabecera de la migración 0128.
//   3. La confirmación de contabilidad es frágil a propósito (AC4). Tocar cualquiera de los cuatro
//      campos sensibles la tumba, y el rastro de quién confirmó y cuándo NO se borra al tumbarla.
//
// NO modela retenciones (AC7): no está confirmado si ReteICA, ReteIVA o autorretención aplican a
// las facturas de FLIT. El día que contabilidad lo confirme, incorporarlas es añadir columnas a
// `siigo_mapeo_conceptos` y leerlas en el armado — el modelo y el flujo de confirmación no cambian.

import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  CAMPOS_QUE_REVIERTEN_CONFIRMACION,
  CAMPO_REVIERTE_LABEL,
  CODIGO_PRODUCTO_SIIGO_RE,
  CONCEPTOS_FACTURABLES,
  esClasificacionTributaria,
  esConceptoFacturable,
  esEstadoValidacionMapeo,
  normalizarTipoTramite,
  type CampoQueRevierteConfirmacion,
  type ClasificacionTributaria,
  type ConceptoFacturable,
  type ConceptoRevalidado,
  type EstadoValidacionMapeo,
  MAX_CODIGOS_POR_REVALIDACION,
  type ImpuestoAplicable,
  type ResultadoRevalidacion,
  type ValidacionMapeo,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { siigoMapeoConceptos } from '../../db/schema.js';
import type { SiigoAmbiente } from './credenciales.service.js';
import {
  consultarProductoPorCodigo, estadoDeValidacion, motivoLegible, validarMapeoContraSiigo,
} from './siigo.productos.service.js';
import { esViolacionDeUnico } from './siigo.redaccion.js';

/** Falla de negocio del mapeo. El router la traduce a un status HTTP. */
export class SiigoMapeoError extends Error {
  /**
   * `validacion` y `no_verificable` son distintos a propósito (AC6): el primero dice que el dato
   * está mal y hay que corregirlo, el segundo que Siigo no respondió y el dato puede estar bien.
   * El router los traduce a estados HTTP distintos para que la pantalla no tenga que adivinar.
   */
  readonly codigo: 'no_existe' | 'datos' | 'duplicado' | 'no_editable' | 'validacion'
  | 'no_verificable' | 'en_curso';
  constructor(codigo: SiigoMapeoError['codigo'], message: string) {
    super(message);
    this.name = 'SiigoMapeoError';
    this.codigo = codigo;
  }
}

/** Vista de una fila del mapeo tal como sale hacia la pantalla y hacia el armado de la factura. */
export interface MapeoConcepto {
  id: string;
  ambiente: SiigoAmbiente;
  concepto: ConceptoFacturable;
  /** null = configuración genérica del concepto. */
  tipoTramite: string | null;
  codigoProducto: string | null;
  nombreProducto: string | null;
  /** null = sin declarar por contabilidad. NO es lo mismo que «excluido». */
  clasificacionTributaria: ClasificacionTributaria | null;
  impuestos: ImpuestoAplicable[];
  unidadMedida: string | null;
  ingresoParaTerceros: boolean;
  facturaLineaPropia: boolean;
  /** true = la decisión de línea propia sigue sin confirmar por contabilidad (AC6). */
  lineaPropiaPendiente: boolean;
  confirmadoContabilidad: boolean;
  confirmadoPorId: number | null;
  confirmadoEn: string | null;
  confirmacionRevertidaEn: string | null;
  /** Nombres de los campos que tumbaron la última confirmación. Nunca valores. */
  confirmacionRevertidaPor: string | null;
  activo: boolean;
  notas: string | null;
  /** Última comprobación del código de producto contra Siigo (HU #11283). */
  validacionEstado: EstadoValidacionMapeo;
  validacionMensaje: string | null;
  validadoEn: string | null;
  /**
   * Derivado, no almacenado: la fila está lista para armar una línea de factura. Se calcula aquí
   * para que la pantalla y el armado no puedan discrepar sobre qué significa «listo».
   */
  listoParaFacturar: boolean;
}

type FilaMapeo = typeof siigoMapeoConceptos.$inferSelect;

/**
 * Una fila sirve para facturar cuando tiene producto, está activa y ese producto no está marcado
 * como inválido en Siigo.
 *
 * **A7 — el tratamiento tributario dejó de ser de FLITO.** Antes se exigían además
 * `clasificacionTributaria` y `confirmadoContabilidad`, y las dos condiciones custodiaban una copia
 * de algo que Siigo ya publica: `GET /v1/products` devuelve `taxes[]` de cada producto con su id,
 * tipo y porcentaje. FLITO mantenía ese duplicado y encima pedía firmarlo, lo que obligaba a
 * declarar en FLITO el IVA de conceptos que ni siquiera se facturan.
 *
 * Ahora la factura no envía `taxes` —es campo opcional del contrato— y los aplica Siigo desde el
 * producto. Con eso no queda nada tributario aquí que confirmar, y la pregunta se reduce a la única
 * que FLITO puede responder: **¿qué producto de Siigo es este concepto?**
 *
 * Lo que esto mueve, dicho sin rodeos: la garantía de que el IVA sale bien pasa a depender de la
 * parametrización de Siigo Nube, no de una firma en FLITO. Es donde contabilidad trabaja, pero un
 * producto mal configurado allá ya no lo detiene nada de este lado.
 *
 * El `lineaPropiaPendiente` sigue bloqueando (AC6): esa decisión —si el GMF va como línea propia—
 * no es tributaria y sigue sin tomarse.
 */
function esListoParaFacturar(f: Pick<FilaMapeo,
  'codigoProducto' | 'activo' | 'lineaPropiaPendiente' | 'validacionEstado'>): boolean {
  return f.activo
    && !f.lineaPropiaPendiente
    && !!f.codigoProducto
    && !VALIDACION_BLOQUEA_FACTURACION.has(f.validacionEstado);
}

/**
 * Estados de validación que impiden facturar (HU #11283).
 *
 * Solo los que afirman que el producto está MAL. `no_verificable` queda fuera a propósito: dice que
 * Siigo no respondió cuando se miró, no que el producto no sirva. Si bloqueara, una caída de diez
 * minutos dejaría toda la parametrización marcada como no facturable hasta que alguien revalidara a
 * mano, mucho después de que Siigo volviera. `sin_validar` tampoco bloquea: es el estado de las
 * filas anteriores a esta HU, y convertirlas en no facturables de golpe sería un cambio de
 * comportamiento que ninguna HU pidió.
 */
const VALIDACION_BLOQUEA_FACTURACION = new Set<string>(['no_existe', 'inactivo']);

function aVista(f: FilaMapeo): MapeoConcepto {
  return {
    id: f.id,
    ambiente: f.ambiente as SiigoAmbiente,
    concepto: f.concepto as ConceptoFacturable,
    tipoTramite: f.tipoTramite,
    codigoProducto: f.codigoProducto,
    nombreProducto: f.nombreProducto,
    clasificacionTributaria: f.clasificacionTributaria as ClasificacionTributaria | null,
    impuestos: normalizarImpuestos(f.impuestos),
    unidadMedida: f.unidadMedida,
    ingresoParaTerceros: f.ingresoParaTerceros,
    facturaLineaPropia: f.facturaLineaPropia,
    lineaPropiaPendiente: f.lineaPropiaPendiente,
    confirmadoContabilidad: f.confirmadoContabilidad,
    confirmadoPorId: f.confirmadoPorId,
    confirmadoEn: f.confirmadoEn ? f.confirmadoEn.toISOString() : null,
    confirmacionRevertidaEn: f.confirmacionRevertidaEn ? f.confirmacionRevertidaEn.toISOString() : null,
    confirmacionRevertidaPor: f.confirmacionRevertidaPor,
    activo: f.activo,
    notas: f.notas,
    validacionEstado: (esEstadoValidacionMapeo(f.validacionEstado)
      ? f.validacionEstado
      : 'sin_validar'),
    validacionMensaje: f.validacionMensaje,
    validadoEn: f.validadoEn ? f.validadoEn.toISOString() : null,
    listoParaFacturar: esListoParaFacturar(f),
  };
}

/** `impuestos` es jsonb: lo que vuelve de la base es `unknown` y hay que tratarlo como tal. */
function normalizarImpuestos(v: unknown): ImpuestoAplicable[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((raw) => {
    if (typeof raw !== 'object' || raw === null) return [];
    const o = raw as Record<string, unknown>;
    if (typeof o.id !== 'number' || !Number.isFinite(o.id)) return [];
    return [{
      id: o.id,
      nombre: typeof o.nombre === 'string' ? o.nombre : null,
      porcentaje: typeof o.porcentaje === 'number' && Number.isFinite(o.porcentaje) ? o.porcentaje : null,
    }];
  });
}

// ───────────────────────────────── Lectura ──────────────────────────────────

/** Todo el mapeo de un ambiente. Orden estable para la pantalla de administración. */
export async function listarMapeo(
  ambiente: SiigoAmbiente, opciones: { incluirInactivos?: boolean } = {},
): Promise<MapeoConcepto[]> {
  const filas = await db.select().from(siigoMapeoConceptos)
    .where(opciones.incluirInactivos
      ? eq(siigoMapeoConceptos.ambiente, ambiente)
      : and(eq(siigoMapeoConceptos.ambiente, ambiente), eq(siigoMapeoConceptos.activo, true)))
    .orderBy(asc(siigoMapeoConceptos.concepto), asc(siigoMapeoConceptos.tipoTramite));

  return filas.map(aVista);
}

async function porId(id: string): Promise<FilaMapeo> {
  const [fila] = await db.select().from(siigoMapeoConceptos)
    .where(eq(siigoMapeoConceptos.id, id)).limit(1);
  if (!fila) throw new SiigoMapeoError('no_existe', 'El mapeo del concepto no existe.');
  return fila;
}

export async function obtenerMapeo(id: string): Promise<MapeoConcepto> {
  return aVista(await porId(id));
}

/**
 * AC5 — Resuelve la configuración aplicable: primero la del tipo de trámite exacto y, si no existe,
 * la genérica (`tipo_tramite IS NULL`). Las filas inactivas no cuentan: desactivar una específica
 * debe devolver el concepto a su configuración genérica, no dejarlo con un valor viejo.
 *
 * Devuelve `null` cuando el concepto no está configurado en ese ambiente. Un `null` explícito, y no
 * un objeto vacío con valores por defecto: quien arme la factura tiene que poder distinguir «no
 * configurado» de «configurado como excluido y sin impuestos».
 */
export async function resolverMapeo(
  ambiente: SiigoAmbiente, concepto: ConceptoFacturable, tipoTramite: string | null,
): Promise<{ mapeo: MapeoConcepto; origen: 'especifica' | 'generica' } | null> {
  const tipo = normalizarTipoTramite(tipoTramite);

  const filas = await db.select().from(siigoMapeoConceptos)
    .where(and(
      eq(siigoMapeoConceptos.ambiente, ambiente),
      eq(siigoMapeoConceptos.concepto, concepto),
      eq(siigoMapeoConceptos.activo, true),
      // Solo las dos que pueden aplicar: la del tipo exacto y la genérica.
      tipo === null
        ? isNull(siigoMapeoConceptos.tipoTramite)
        : sql`(${siigoMapeoConceptos.tipoTramite} = ${tipo} OR ${siigoMapeoConceptos.tipoTramite} IS NULL)`,
    ));

  const especifica = tipo === null ? undefined : filas.find((f) => f.tipoTramite === tipo);
  if (especifica) return { mapeo: aVista(especifica), origen: 'especifica' };
  const generica = filas.find((f) => f.tipoTramite === null);
  if (generica) return { mapeo: aVista(generica), origen: 'generica' };
  return null;
}

// ───────────────────────────────── Escritura ────────────────────────────────

/** Campos editables. `undefined` = no se toca; `null` = se borra el valor. */
export interface CambiosMapeo {
  codigoProducto?: string | null;
  nombreProducto?: string | null;
  clasificacionTributaria?: ClasificacionTributaria | null;
  impuestos?: ImpuestoAplicable[];
  unidadMedida?: string | null;
  ingresoParaTerceros?: boolean;
  facturaLineaPropia?: boolean;
  lineaPropiaPendiente?: boolean;
  notas?: string | null;
  activo?: boolean;
}

/** Datos de una fila específica por tipo de trámite (AC5). El ambiente y el concepto son su llave. */
export interface DatosMapeoEspecifico extends CambiosMapeo {
  ambiente: SiigoAmbiente;
  concepto: ConceptoFacturable;
  tipoTramite: string;
}

function validar(c: CambiosMapeo): void {
  if (c.codigoProducto != null && !CODIGO_PRODUCTO_SIIGO_RE.test(c.codigoProducto)) {
    throw new SiigoMapeoError('datos',
      'El código de producto de Siigo debe ser alfanumérico, sin espacios y de máximo 30 caracteres.');
  }
  if (c.clasificacionTributaria != null && !esClasificacionTributaria(c.clasificacionTributaria)) {
    throw new SiigoMapeoError('datos', 'Clasificación tributaria desconocida.');
  }
  if (c.impuestos !== undefined) {
    for (const imp of c.impuestos) {
      if (!Number.isInteger(imp.id) || imp.id <= 0) {
        throw new SiigoMapeoError('datos', 'Cada impuesto debe traer el id numérico que tiene en Siigo.');
      }
    }
  }
}

/**
 * AC4 — Qué campos sensibles cambian de verdad con esta edición.
 *
 * Compara VALOR A VALOR, no «vino en el cuerpo»: reenviar la misma clasificación tributaria no debe
 * tumbar una confirmación. Si tumbara, cualquier pantalla que mande el formulario entero haría
 * imposible mantener una fila confirmada.
 */
function camposSensiblesQueCambian(actual: FilaMapeo, c: CambiosMapeo): CampoQueRevierteConfirmacion[] {
  const nuevos: Record<CampoQueRevierteConfirmacion, boolean> = {
    codigoProducto: c.codigoProducto !== undefined
      && (c.codigoProducto ?? null) !== actual.codigoProducto,
    clasificacionTributaria: c.clasificacionTributaria !== undefined
      && (c.clasificacionTributaria ?? null) !== actual.clasificacionTributaria,
    ingresoParaTerceros: c.ingresoParaTerceros !== undefined
      && c.ingresoParaTerceros !== actual.ingresoParaTerceros,
    impuestos: c.impuestos !== undefined
      && !mismosImpuestos(c.impuestos, normalizarImpuestos(actual.impuestos)),
  };
  return CAMPOS_QUE_REVIERTEN_CONFIRMACION.filter((k) => nuevos[k]);
}

/**
 * Igualdad por contenido, sin importar el orden.
 *
 * No basta con comparar el conjunto de ids: `nombre` y `porcentaje` se persisten en el MISMO update,
 * así que mirando solo el id, pasar «IVA 19%» a «IVA 5%» sobre el id 13156 guardaría el 5% dejando
 * intacta la confirmación — la pantalla mostraría un 5% «confirmado por contabilidad» que nadie
 * firmó. Pero tampoco vale la igualdad estricta: rellenar un nombre que estaba vacío es completar
 * información, no cambiar la declaración. La regla es **contradecir**, no «diferir».
 */
function mismosImpuestos(nuevos: ImpuestoAplicable[], actuales: ImpuestoAplicable[]): boolean {
  if (nuevos.length !== actuales.length) return false;
  const idsNuevos = nuevos.map((i) => i.id).sort((x, y) => x - y);
  const idsActuales = actuales.map((i) => i.id).sort((x, y) => x - y);
  if (!idsNuevos.every((v, i) => v === idsActuales[i])) return false;

  const previoPorId = new Map(actuales.map((i) => [i.id, i]));
  return nuevos.every((n) => {
    const previo = previoPorId.get(n.id);
    return previo !== undefined
      && !contradice(n.nombre, previo.nombre)
      && !contradice(n.porcentaje, previo.porcentaje);
  });
}

/** Hay contradicción solo si ambos lados declaran un valor y no coinciden. */
function contradice<T>(entrante: T | null | undefined, previo: T | null | undefined): boolean {
  if (entrante === undefined || entrante === null) return false;
  if (previo === undefined || previo === null) return false;
  return entrante !== previo;
}


const MENSAJE_DUPLICADO = 'Ya hay una configuración activa para ese concepto y tipo de trámite '
  + 'en este ambiente. Edítala en vez de crear otra.';

/** Traduce la colisión con el índice único a un error propio; el resto se relanza tal cual. */
function traducirDuplicado(e: unknown): never {
  if (esViolacionDeUnico(e)) throw new SiigoMapeoError('duplicado', MENSAJE_DUPLICADO);
  throw e;
}

/**
 * HU #11283 — Valida contra Siigo y traduce el rechazo a un error de dominio.
 *
 * Se ejecuta ANTES de cualquier escritura, que es lo que hace cierto el «el mapeo conserva su valor
 * anterior» del AC1 y el «no queda ningún mapeo guardado sin validar» del AC6: si esto lanza, la
 * tabla no se ha tocado.
 *
 * Los tres códigos de salida no son adorno. `datos` es un formato mal escrito (400), `validacion`
 * es un dato que no existe en Siigo (422) y `no_verificable` es Siigo caído (503). Quien opera hace
 * cosas distintas con cada uno, y una pantalla que reciba siempre 400 no puede distinguirlas.
 */
async function exigirValidacionDeSiigo(
  datos: { codigoProducto?: string | null; impuestos?: ImpuestoAplicable[] },
  ambiente: SiigoAmbiente,
): Promise<ValidacionMapeo> {
  const v = await validarMapeoContraSiigo(datos, ambiente);
  if (v.valido) return v;

  if (v.motivo === 'formato') throw new SiigoMapeoError('datos', v.mensaje);
  if (v.motivo === 'no_verificable') throw new SiigoMapeoError('no_verificable', v.mensaje);
  throw new SiigoMapeoError('validacion', v.mensaje);
}

/** Los tres campos de validación que se escriben junto a cualquier cambio de producto o impuestos. */
function camposDeValidacion(v: ValidacionMapeo): {
  validacionEstado: EstadoValidacionMapeo;
  validacionMensaje: string;
  validadoEn: Date | null;
} {
  return {
    validacionEstado: estadoDeValidacion(v),
    validacionMensaje: recortarPorPuntosDeCodigo(v.mensaje, 300),
    // La fecha sale del veredicto, no del reloj: si no se comprobó nada, no hay fecha que poner. El
    // CHECK `siigo_mapeo_validacion_fechada` de la migración 0129 exige exactamente esa coherencia.
    validadoEn: v.verificadoEn === null ? null : new Date(v.verificadoEn),
  };
}

/** Frase legible de qué tumbó la confirmación. Nombres de campo, nunca valores. */
export function motivoDeReversion(campos: CampoQueRevierteConfirmacion[]): string {
  return `Cambio en ${campos.map((k) => CAMPO_REVIERTE_LABEL[k]).join(', ')}`;
}

export interface ResultadoActualizacion {
  mapeo: MapeoConcepto;
  /** Estado anterior, para que el router lo lleve a la auditoría (AC8). */
  anterior: MapeoConcepto;
  /** Campos sensibles que tumbaron la confirmación. Vacío si no había confirmación que tumbar. */
  confirmacionRevertidaPor: CampoQueRevierteConfirmacion[];
}

/**
 * Edita una fila del mapeo. Si estaba confirmada por contabilidad y el cambio toca alguno de los
 * cuatro campos sensibles, la confirmación se cae en el MISMO update (AC4).
 *
 * `confirmadoPorId` y `confirmadoEn` NO se limpian: el AC pide que quede registrado quién confirmó
 * y cuándo, y esa pregunta se hace precisamente después de que la confirmación se cayera.
 */
export async function actualizarMapeo(
  id: string, cambios: CambiosMapeo, usuarioId: number,
): Promise<ResultadoActualizacion> {
  validar(cambios);
  const actual = await porId(id);

  // AC1 — La genérica no se desactiva por ninguna vía. `DELETE` ya lo impide; sin esta guarda un
  // `PATCH {activo:false}` conseguiría lo mismo por la puerta de atrás, y toda lectura filtra por
  // `activo = true`. Además rompería la idempotencia de la migración: el `ON CONFLICT DO NOTHING`
  // de la semilla se apoya en el índice único PARCIAL (`WHERE activo`), así que con la genérica
  // desactivada una segunda pasada insertaría una fila duplicada.
  if (cambios.activo === false && actual.tipoTramite === null) {
    throw new SiigoMapeoError('no_editable',
      'La configuración genérica de un concepto no se puede desactivar; edítala o déjala sin código de producto.');
  }

  // HU #11283 — Solo se valida cuando la edición toca lo que Siigo puede desmentir. Un cambio de
  // notas no gasta una petición de la cuota, y tampoco debe poder fallar porque Siigo esté caído.
  const tocaValidable = cambios.codigoProducto !== undefined || cambios.impuestos !== undefined;
  const validacion = tocaValidable
    ? await exigirValidacionDeSiigo({
      codigoProducto: cambios.codigoProducto !== undefined
        ? cambios.codigoProducto
        : actual.codigoProducto,
      // El estado que se valida es el RESULTANTE, no el que llegó en el cuerpo: cambiar solo el
      // código con unos impuestos ya guardados tiene que verificar la pareja que va a quedar.
      impuestos: cambios.impuestos !== undefined
        ? cambios.impuestos
        : normalizarImpuestos(actual.impuestos),
    }, actual.ambiente as SiigoAmbiente)
    : null;

  const sensibles = camposSensiblesQueCambian(actual, cambios);
  const revierte = actual.confirmadoContabilidad && sensibles.length > 0;

  const [fila] = await db.update(siigoMapeoConceptos)
    .set({
      ...(validacion ? camposDeValidacion(validacion) : {}),
      ...(cambios.codigoProducto !== undefined ? { codigoProducto: cambios.codigoProducto } : {}),
      ...(cambios.nombreProducto !== undefined ? { nombreProducto: cambios.nombreProducto } : {}),
      ...(cambios.clasificacionTributaria !== undefined
        ? { clasificacionTributaria: cambios.clasificacionTributaria } : {}),
      ...(cambios.impuestos !== undefined ? { impuestos: cambios.impuestos } : {}),
      ...(cambios.unidadMedida !== undefined ? { unidadMedida: cambios.unidadMedida } : {}),
      ...(cambios.ingresoParaTerceros !== undefined
        ? { ingresoParaTerceros: cambios.ingresoParaTerceros } : {}),
      ...(cambios.facturaLineaPropia !== undefined
        ? { facturaLineaPropia: cambios.facturaLineaPropia } : {}),
      ...(cambios.lineaPropiaPendiente !== undefined
        ? { lineaPropiaPendiente: cambios.lineaPropiaPendiente } : {}),
      ...(cambios.notas !== undefined ? { notas: cambios.notas } : {}),
      ...(cambios.activo !== undefined ? { activo: cambios.activo } : {}),
      ...(revierte ? {
        confirmadoContabilidad: false,
        confirmacionRevertidaEn: new Date(),
        confirmacionRevertidaPor: motivoDeReversion(sensibles).slice(0, 300),
      } : {}),
      updatedBy: usuarioId,
      updatedAt: new Date(),
    })
    .where(eq(siigoMapeoConceptos.id, id))
    .returning()
    // Reactivar una fila cuya pareja (ambiente, concepto, tipo) ya tiene otra viva choca contra el
    // índice único parcial igual que un alta. Sin esta traducción sale un 500 en vez del 409.
    .catch(traducirDuplicado);

  if (!fila) throw new SiigoMapeoError('no_existe', 'El mapeo del concepto no existe.');
  return {
    mapeo: aVista(fila),
    anterior: aVista(actual),
    confirmacionRevertidaPor: revierte ? sensibles : [],
  };
}

/**
 * AC4 y AC8 — Marca la fila como confirmada por contabilidad, dejando quién y cuándo.
 *
 * Confirmar sin código de producto o sin clasificación tributaria se rechaza: sería una firma sobre
 * un formulario en blanco, y el AC4 la haría caer con el primer cambio de todos modos.
 */
export async function confirmarMapeo(id: string, usuarioId: number): Promise<ResultadoActualizacion> {
  const actual = await porId(id);
  if (!actual.activo) {
    throw new SiigoMapeoError('no_editable', 'No se puede confirmar un mapeo desactivado.');
  }
  if (!actual.codigoProducto) {
    throw new SiigoMapeoError('datos',
      'No se puede confirmar un concepto sin código de producto en Siigo.');
  }
  if (!actual.clasificacionTributaria) {
    throw new SiigoMapeoError('datos',
      'No se puede confirmar un concepto sin clasificación tributaria declarada.');
  }

  const [fila] = await db.update(siigoMapeoConceptos)
    .set({
      confirmadoContabilidad: true,
      confirmadoPorId: usuarioId,
      confirmadoEn: new Date(),
      // La reversión anterior se limpia: ya no está pendiente, acaba de confirmarse de nuevo.
      confirmacionRevertidaEn: null,
      confirmacionRevertidaPor: null,
      updatedBy: usuarioId,
      updatedAt: new Date(),
    })
    .where(eq(siigoMapeoConceptos.id, id))
    .returning();

  if (!fila) throw new SiigoMapeoError('no_existe', 'El mapeo del concepto no existe.');
  return { mapeo: aVista(fila), anterior: aVista(actual), confirmacionRevertidaPor: [] };
}

/**
 * AC5 — Alta de una configuración específica para un tipo de trámite. La genérica de cada concepto
 * ya existe desde la migración; lo único que se crea aquí son las excepciones por tipo.
 *
 * Nace sin confirmar aunque se copie de una confirmada: la confirmación es de una fila concreta.
 */
export async function crearMapeoEspecifico(
  datos: DatosMapeoEspecifico, usuarioId: number,
): Promise<MapeoConcepto> {
  if (!esConceptoFacturable(datos.concepto)) {
    throw new SiigoMapeoError('datos',
      `Concepto facturable desconocido. Los válidos son: ${CONCEPTOS_FACTURABLES.join(', ')}.`);
  }
  validar(datos);
  const tipo = normalizarTipoTramite(datos.tipoTramite);
  if (tipo === null) {
    throw new SiigoMapeoError('datos',
      'El tipo de trámite es obligatorio: la configuración genérica del concepto ya existe y se edita, no se crea.');
  }

  // AC6 — Los dos indicadores de línea propia se HEREDAN de la genérica del mismo concepto y
  // ambiente cuando no vienen en el cuerpo. Con un valor fijo, una específica de GMF nacería
  // afirmando «sí, se factura como línea propia» y con el pendiente apagado: decidiría en silencio
  // la pregunta que esta historia se comprometió a dejar abierta. Y como la específica tiene
  // precedencia (AC5), esa respuesta inventada sería justo la que se usaría al armar la factura.
  const [generica] = await db.select().from(siigoMapeoConceptos)
    .where(and(
      eq(siigoMapeoConceptos.ambiente, datos.ambiente),
      eq(siigoMapeoConceptos.concepto, datos.concepto),
      isNull(siigoMapeoConceptos.tipoTramite),
      eq(siigoMapeoConceptos.activo, true),
    )).limit(1);

  // HU #11283 — Antes del INSERT. Un alta que no se pudo verificar no se guarda a medias (AC6).
  const validacion = await exigirValidacionDeSiigo({
    codigoProducto: datos.codigoProducto ?? null,
    impuestos: datos.impuestos ?? [],
  }, datos.ambiente);

  const [fila] = await db.insert(siigoMapeoConceptos).values({
    ...camposDeValidacion(validacion),
    ambiente: datos.ambiente,
    concepto: datos.concepto,
    tipoTramite: tipo,
    codigoProducto: datos.codigoProducto ?? null,
    nombreProducto: datos.nombreProducto ?? null,
    clasificacionTributaria: datos.clasificacionTributaria ?? null,
    impuestos: datos.impuestos ?? [],
    unidadMedida: datos.unidadMedida ?? null,
    ingresoParaTerceros: datos.ingresoParaTerceros ?? false,
    // Sin genérica, el mismo valor que la columna: `DEFAULT false`. Nunca `true` por conveniencia.
    facturaLineaPropia: datos.facturaLineaPropia ?? generica?.facturaLineaPropia ?? false,
    lineaPropiaPendiente: datos.lineaPropiaPendiente ?? generica?.lineaPropiaPendiente ?? false,
    notas: datos.notas ?? null,
    createdBy: usuarioId,
    updatedBy: usuarioId,
  }).returning().catch(traducirDuplicado);

  if (!fila) throw new SiigoMapeoError('datos', 'No se pudo crear la configuración del concepto.');
  return aVista(fila);
}

/**
 * Desactiva una fila específica por tipo de trámite. Soft delete: el historial nunca se borra y el
 * índice único parcial deja libre la pareja para una configuración nueva.
 *
 * Las genéricas NO se desactivan: son las seis filas que el AC1 garantiza que existen siempre. Si
 * una genérica pudiera desaparecer, un ambiente recién migrado y uno usado dejarían de parecerse.
 */
export async function desactivarMapeoEspecifico(
  id: string, usuarioId: number,
): Promise<MapeoConcepto> {
  const actual = await porId(id);
  if (actual.tipoTramite === null) {
    throw new SiigoMapeoError('no_editable',
      'La configuración genérica de un concepto no se puede eliminar; edítala o déjala sin código de producto.');
  }

  const [fila] = await db.update(siigoMapeoConceptos)
    .set({ activo: false, updatedBy: usuarioId, updatedAt: new Date() })
    .where(eq(siigoMapeoConceptos.id, id))
    .returning();
  if (!fila) throw new SiigoMapeoError('no_existe', 'El mapeo del concepto no existe.');
  return aVista(fila);
}

/**
 * Resumen de cuánto falta para poder facturar en un ambiente. Alimenta la compuerta de la HU #11285
 * y la pantalla de administración, para que ambas cuenten lo mismo.
 */
export interface EstadoMapeo {
  ambiente: SiigoAmbiente;
  total: number;
  confirmados: number;
  /** Conceptos (no filas) sin una configuración lista. Ordenados como `CONCEPTOS_FACTURABLES`. */
  conceptosPendientes: ConceptoFacturable[];
  /** Conceptos con una decisión contable todavía abierta (AC6). */
  conceptosConDecisionPendiente: ConceptoFacturable[];
  completo: boolean;
}

export async function estadoMapeo(ambiente: SiigoAmbiente): Promise<EstadoMapeo> {
  const filas = await listarMapeo(ambiente);
  const genericas = new Map(filas.filter((f) => f.tipoTramite === null).map((f) => [f.concepto, f]));

  const conceptosPendientes = CONCEPTOS_FACTURABLES.filter((c) => {
    if (!genericas.get(c)?.listoParaFacturar) return true;
    // AC5 — La específica manda sobre la genérica, así que mirar solo la genérica da un GO en
    // falso: basta con dar de alta una específica (que nace sin producto, por diseño) para que el
    // resumen diga `completo` mientras la fila que de verdad se usaría está vacía. Esta compuerta
    // alimenta el armado de la factura (HU 11285); ahí el `codigoProducto` nulo sería una sorpresa.
    return filas.some((f) => f.concepto === c && f.tipoTramite !== null && !f.listoParaFacturar);
  });
  const conceptosConDecisionPendiente = CONCEPTOS_FACTURABLES
    .filter((c) => filas.some((f) => f.concepto === c && f.lineaPropiaPendiente));

  return {
    ambiente,
    total: filas.length,
    confirmados: filas.filter((f) => f.confirmadoContabilidad).length,
    conceptosPendientes: [...conceptosPendientes],
    conceptosConDecisionPendiente: [...conceptosConDecisionPendiente],
    completo: conceptosPendientes.length === 0,
  };
}

// ─────────────────────────── AC7 — Revalidación de lo configurado ───────────────────────────

/** Veredicto de un código concreto, ya traducido al estado que se persiste. */
interface VeredictoCodigo {
  estado: EstadoValidacionMapeo;
  mensaje: string;
}

/**
 * Ambientes con una revalidación en curso. Dos a la vez sobre el mismo ambiente duplicarían el
 * consumo de la cuota de Siigo —que se comparte con la emisión de facturas— para producir el mismo
 * informe dos veces.
 *
 * En proceso y no en Redis a conciencia: `ecosystem.config.cjs` no declara `instances`, así que PM2
 * corre una sola instancia de la API y esta guarda las cubre todas. **Si algún día se pasa a modo
 * cluster o a varias réplicas, esto deja de bastar** y hay que moverlo a un lock en Redis, junto
 * con el limitador de la ruta.
 */
const revalidacionesEnCurso = new Set<string>();

/**
 * Solo para tests y para el arranque del proceso, igual que `reiniciarLimitador` en
 * `siigo.resiliencia.ts`. Sin esto, un test que dejara la marca puesta haría fallar a todos los
 * siguientes con un mensaje que no tiene nada que ver con lo que prueban.
 */
export function reiniciarRevalidaciones(): void {
  revalidacionesEnCurso.clear();
}

/**
 * Recorta por PUNTOS DE CÓDIGO, no por unidades UTF-16.
 *
 * `slice` parte los pares suplentes: un nombre de producto con un carácter fuera del BMP justo en
 * el límite dejaría medio par, y Postgres rechazaría el UPDATE con un error que aquí, dentro del
 * bucle de revalidación, no está capturado — subiría al `errorHandler`, que registra `err.message`
 * sin sanear. Es el mismo camino de fuga que la HU #11281 cerró en la bitácora WORM.
 */
function recortarPorPuntosDeCodigo(texto: string, maximo: number): string {
  const puntos = [...texto];
  return puntos.length <= maximo ? texto : puntos.slice(0, maximo).join('');
}

/**
 * Comprueba UN código contra Siigo. No lanza: un fallo es `no_verificable`, no una excepción que
 * abortaría la revalidación entera y dejaría a medias las filas que sí se podían mirar.
 */
async function comprobarCodigo(codigo: string, ambiente: SiigoAmbiente): Promise<VeredictoCodigo> {
  try {
    const c = await consultarProductoPorCodigo(codigo, ambiente);
    if (!c.existe) {
      return {
        estado: 'no_existe',
        mensaje: `El producto ${codigo} ya no existe en Siigo. Créalo de nuevo o corrige el mapeo.`,
      };
    }
    if (!c.activo) {
      return {
        estado: 'inactivo',
        mensaje: `El producto ${codigo} quedó INACTIVO en Siigo. Actívalo antes de la próxima factura.`,
      };
    }
    return { estado: 'valido', mensaje: `Verificado contra Siigo: ${c.nombre ?? codigo}.` };
  } catch (e) {
    // `motivoLegible` y no `detalleTecnico`: este texto se PERSISTE en `validacion_mensaje` y se
    // devuelve al cliente. El detalle crudo se queda en el log del servidor.
    return {
      estado: 'no_verificable',
      mensaje: `No se pudo verificar ${codigo}: ${motivoLegible(e)}`,
    };
  }
}

/**
 * AC7 — Revalida todas las filas activas de un ambiente que tengan código de producto, y deja el
 * resultado ESCRITO en cada fila para que la pantalla las señale al abrirla.
 *
 * Tres decisiones:
 *
 *   1. **Un código se consulta UNA vez.** Dos conceptos pueden apuntar al mismo producto —el caso
 *      normal cuando una específica hereda de su genérica—, y preguntar dos veces gasta cuota de las
 *      100 por minuto para recibir exactamente la misma respuesta.
 *   2. **Secuencial, no en paralelo.** El limitador de tasa ya serializa; lanzarlas todas a la vez
 *      solo llenaría su cola y haría que la primera espera se pareciera a un cuelgue.
 *   3. **No toca la confirmación de contabilidad.** Que un producto desaparezca de Siigo no
 *      invalida el criterio tributario que contabilidad firmó, que es sobre el concepto y no sobre
 *      el producto. Tumbarla aquí obligaría a recoger firmas cada vez que alguien reorganiza el
 *      catálogo en Siigo Nube.
 */
export async function revalidarMapeo(
  ambiente: SiigoAmbiente, usuarioId: number,
): Promise<ResultadoRevalidacion> {
  if (revalidacionesEnCurso.has(ambiente)) {
    throw new SiigoMapeoError('en_curso',
      `Ya hay una revalidación en curso para el ambiente ${ambiente}. Espera a que termine: `
      + 'dos a la vez duplicarían el consumo de la cuota de Siigo sin dar más información.');
  }
  revalidacionesEnCurso.add(ambiente);

  try {
    const filas = await db.select().from(siigoMapeoConceptos)
      .where(and(
        eq(siigoMapeoConceptos.ambiente, ambiente),
        eq(siigoMapeoConceptos.activo, true),
        isNotNull(siigoMapeoConceptos.codigoProducto),
      ))
      .orderBy(asc(siigoMapeoConceptos.concepto), asc(siigoMapeoConceptos.tipoTramite));

    const porCodigo = new Map<string, VeredictoCodigo>();
    const conNovedad: ConceptoRevalidado[] = [];
    const noVerificados: ConceptoRevalidado[] = [];
    const codigosOmitidos = new Set<string>();
    let revisados = 0;

    for (const f of filas) {
      const codigo = f.codigoProducto;
      if (codigo === null) continue; // Imposible por el WHERE; el tipo no lo sabe.

      let veredicto = porCodigo.get(codigo);
      if (veredicto === undefined) {
        // Tope de códigos DISTINTOS por ejecución. Las filas que comparten un código ya consultado
        // siguen procesándose: lo que se acota es el consumo de cuota, no el trabajo local.
        if (porCodigo.size >= MAX_CODIGOS_POR_REVALIDACION) {
          codigosOmitidos.add(codigo);
          continue;
        }
        veredicto = await comprobarCodigo(codigo, ambiente);
        porCodigo.set(codigo, veredicto);
      }

      revisados += 1;
      await db.update(siigoMapeoConceptos)
        .set({
          validacionEstado: veredicto.estado,
          validacionMensaje: recortarPorPuntosDeCodigo(veredicto.mensaje, 300),
          // Fecha del ÚLTIMO INTENTO, incluido `no_verificable`. Es lo que responde «¿cuándo se
          // miró esto por última vez?», que es la pregunta que se hace ante una fila dudosa.
          validadoEn: new Date(),
          updatedBy: usuarioId,
          updatedAt: new Date(),
        })
        .where(eq(siigoMapeoConceptos.id, f.id));

      if (veredicto.estado === 'valido') continue;

      const item: ConceptoRevalidado = {
        id: f.id,
        concepto: f.concepto,
        tipoTramite: f.tipoTramite,
        codigoProducto: codigo,
        estado: veredicto.estado,
        mensaje: veredicto.mensaje,
      };
      // `no_verificable` va a su propia lista: informar de «3 conceptos con problemas» cuando lo que
      // pasó es que Siigo no respondió sería trasladar al informe justo la confusión que el AC6 pide
      // evitar en el guardado.
      if (veredicto.estado === 'no_verificable') noVerificados.push(item);
      else conNovedad.push(item);
    }

    return {
      ambiente,
      ejecutadaEn: new Date().toISOString(),
      revisados,
      conNovedad,
      noVerificados,
      truncado: codigosOmitidos.size > 0,
      codigosPendientes: codigosOmitidos.size,
    };
  } finally {
    // En `finally`: si la consulta a la base falla, la marca no puede quedarse puesta o el ambiente
    // se bloquearía hasta reiniciar el proceso.
    revalidacionesEnCurso.delete(ambiente);
  }
}
