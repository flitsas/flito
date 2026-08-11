// Siigo API — configuración global de emisión (HU #11284, Feature #11240).
//
// Con qué tipo de comprobante, vendedor, forma de pago y centro de costo nacen las facturas.
//
// Dos reglas sostienen el archivo:
//
//   1. **Los cuatro valores se ELIGEN de los catálogos sincronizados, no se escriben** (AC1). Aquí
//      no se valida el formato de un código: se comprueba que exista y esté activo en la copia
//      local de la HU #11281. Un código bien formado que no está en Siigo es exactamente el fallo
//      que la parametrización existe para evitar.
//   2. **La validez se calcula al LEER, no se guarda** (AC2). Alguien puede inactivar el vendedor
//      en Siigo Nube sin tocar FLITO; si el veredicto estuviera almacenado, la configuración
//      seguiría diciendo «lista» hasta que alguien la recalculara. Y no se corrige sola: se señala
//      el campo y se deja que un humano decida.
//
// Los AC3, AC4 y AC5 corresponden a decisiones contables abiertas. Están implementados como
// configuración —forma de pago única, plazo en días, estrategia de numeración con un solo valor
// admitido— para que responderlas sea cambiar un dato y no reescribir la emisión.

import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import {
  CAMPOS_CATALOGO_EMISION,
  CAMPO_CATALOGO_EMISION_ETIQUETA,
  esEstrategiaNumeracion,
  type CampoCatalogoEmision,
  type CampoEmisionValidado,
  type ConfigEmision,
  type EstadoConfigEmision,
  type EstrategiaNumeracion,
  type SiigoCatalogoElemento,
  type SiigoTipoCatalogo,
  type ValidezCampoEmision,
} from '@operaciones/shared-types';
import { db } from '../../db/client.js';
import { siigoConfigEmision } from '../../db/schema.js';
import { leerCatalogo } from './siigo.catalogos.service.js';
import { esViolacionDeUnico } from './siigo.redaccion.js';
import type { SiigoAmbiente } from './credenciales.service.js';

/** Falla de negocio de la configuración de emisión. El router la traduce a un status HTTP. */
export class SiigoConfigEmisionError extends Error {
  readonly codigo: 'no_existe' | 'datos' | 'catalogo' | 'conflicto';
  /** Campo que provocó el rechazo, cuando lo hay. Permite que la pantalla lo resalte. */
  readonly campo: CampoCatalogoEmision | null;

  constructor(
    codigo: SiigoConfigEmisionError['codigo'], message: string,
    campo: CampoCatalogoEmision | null = null,
  ) {
    super(message);
    this.name = 'SiigoConfigEmisionError';
    this.codigo = codigo;
    this.campo = campo;
  }
}

/** De qué catálogo sale cada campo. Un solo sitio: la validación y el diagnóstico lo recorren. */
const CATALOGO_DE_CAMPO: Record<CampoCatalogoEmision, SiigoTipoCatalogo> = {
  documentoTipo: 'document_type',
  vendedor: 'user',
  formaPago: 'payment_type',
  centroCosto: 'cost_center',
};

type FilaConfig = typeof siigoConfigEmision.$inferSelect;

/** Cambios admitidos. `undefined` = no se toca; `null` = se borra el valor. */
export interface CambiosConfigEmision {
  documentoTipoCodigo?: string | null;
  vendedorCodigo?: string | null;
  formaPagoCodigo?: string | null;
  centroCostoCodigo?: string | null;
  plazoVencimientoDias?: number;
  estrategiaNumeracion?: EstrategiaNumeracion;
  notas?: string | null;
}

function codigoDeCampo(f: FilaConfig, campo: CampoCatalogoEmision): string | null {
  switch (campo) {
    case 'documentoTipo': return f.documentoTipoCodigo;
    case 'vendedor': return f.vendedorCodigo;
    case 'formaPago': return f.formaPagoCodigo;
    case 'centroCosto': return f.centroCostoCodigo;
  }
}

/** ¿El tipo de comprobante elegido exige centro de costo? Sale del catálogo, no de una suposición. */
function exigeCentroCosto(documentoTipo: SiigoCatalogoElemento | undefined): boolean {
  return (documentoTipo?.atributos as { centroCostoObligatorio?: boolean } | null)
    ?.centroCostoObligatorio === true;
}

/** ¿Es un comprobante de VENTA? El AC1 lo exige y el dato viene de `/v1/document-types`. */
function esFacturaDeVenta(elemento: SiigoCatalogoElemento): boolean {
  return (elemento.atributos as { tipo?: string } | null)?.tipo === 'FV';
}

/**
 * Diagnóstico de un campo contra la copia local del catálogo (AC2).
 *
 * `catalogo_sin_sincronizar` se distingue de `no_existe` por la misma razón que en la HU #11283:
 * con la copia vacía TODO código parecería inválido, y mandar a corregir un vendedor que está
 * perfecto llevaría a buscar el problema donde no está.
 */
function diagnosticar(
  campo: CampoCatalogoEmision,
  codigo: string | null,
  elementos: SiigoCatalogoElemento[],
  aplica: boolean,
): CampoEmisionValidado {
  const etiqueta = CAMPO_CATALOGO_EMISION_ETIQUETA[campo];
  const base = { campo, etiqueta, codigo, nombre: null as string | null };

  if (!aplica) {
    return { ...base, validez: 'no_aplica', mensaje: null };
  }
  if (codigo === null) {
    return { ...base, validez: 'sin_configurar', mensaje: `Falta configurar: ${etiqueta.toLowerCase()}.` };
  }
  if (elementos.length === 0) {
    return {
      ...base,
      validez: 'catalogo_sin_sincronizar',
      mensaje: `El catálogo de ${etiqueta.toLowerCase()} no está sincronizado en este ambiente, `
        + 'así que no se puede comprobar el valor guardado. Sincronízalo desde la parametrización.',
    };
  }

  const encontrado = elementos.find((e) => e.codigo === codigo);
  if (!encontrado) {
    return {
      ...base,
      validez: 'no_existe',
      mensaje: `${etiqueta} ${codigo} ya no existe en Siigo. Elige otro valor del catálogo.`,
    };
  }
  if (!encontrado.activo) {
    return {
      ...base,
      nombre: encontrado.nombre,
      validez: 'inactivo',
      mensaje: `${etiqueta} «${encontrado.nombre}» quedó INACTIVO en Siigo. Actívalo en Siigo Nube `
        + 'o elige otro valor.',
    };
  }

  return { ...base, nombre: encontrado.nombre, validez: 'ok', mensaje: null };
}

/** Los cuatro catálogos que hacen falta, leídos una sola vez por consulta. */
async function catalogosDeEmision(
  ambiente: SiigoAmbiente,
): Promise<Record<CampoCatalogoEmision, SiigoCatalogoElemento[]>> {
  const leidos = await Promise.all(CAMPOS_CATALOGO_EMISION.map(async (campo) => {
    // Con inactivos: distinguir «no existe» de «está inactivo» exige verlos (AC2).
    const c = await leerCatalogo(CATALOGO_DE_CAMPO[campo], { incluirInactivos: true, ambiente });
    return [campo, c.elementos] as const;
  }));
  return Object.fromEntries(leidos) as Record<CampoCatalogoEmision, SiigoCatalogoElemento[]>;
}

function aVista(
  f: FilaConfig, catalogos: Record<CampoCatalogoEmision, SiigoCatalogoElemento[]>,
): ConfigEmision {
  const tipoElegido = f.documentoTipoCodigo === null
    ? undefined
    : catalogos.documentoTipo.find((e) => e.codigo === f.documentoTipoCodigo);

  const campos = CAMPOS_CATALOGO_EMISION.map((campo) => diagnosticar(
    campo,
    codigoDeCampo(f, campo),
    catalogos[campo],
    // El centro de costo solo aplica si el comprobante lo exige. Sin esta condición, una
    // configuración correcta con un comprobante que no lo pide aparecería siempre incompleta.
    campo === 'centroCosto' ? exigeCentroCosto(tipoElegido) : true,
  ));

  return {
    id: f.id,
    ambiente: f.ambiente,
    documentoTipoCodigo: f.documentoTipoCodigo,
    vendedorCodigo: f.vendedorCodigo,
    formaPagoCodigo: f.formaPagoCodigo,
    centroCostoCodigo: f.centroCostoCodigo,
    plazoVencimientoDias: f.plazoVencimientoDias,
    estrategiaNumeracion: (esEstrategiaNumeracion(f.estrategiaNumeracion)
      ? f.estrategiaNumeracion
      : 'siigo'),
    notas: f.notas,
    actualizadaEn: f.updatedAt.toISOString(),
    actualizadaPorId: f.updatedBy,
    campos,
    utilizable: campos.every((c) => c.validez === 'ok' || c.validez === 'no_aplica'),
  };
}

// ───────────────────────────────── Lectura ──────────────────────────────────

async function filaVigente(ambiente: SiigoAmbiente): Promise<FilaConfig | undefined> {
  const [fila] = await db.select().from(siigoConfigEmision)
    .where(and(
      eq(siigoConfigEmision.ambiente, ambiente),
      eq(siigoConfigEmision.vigente, true),
    ))
    .limit(1);
  return fila;
}

/**
 * Configuración vigente de un ambiente, con su diagnóstico. `null` si nunca se guardó una.
 *
 * Devuelve `null` explícito y no una configuración vacía: quien consuma esto tiene que poder
 * distinguir «nadie la ha configurado» de «está configurada y le falta un campo».
 */
export async function obtenerConfigEmision(ambiente: SiigoAmbiente): Promise<ConfigEmision | null> {
  const fila = await filaVigente(ambiente);
  if (!fila) return null;
  return aVista(fila, await catalogosDeEmision(ambiente));
}

/**
 * Los parámetros con los que se ARMA la factura (HU #11326).
 *
 * Aparte de `obtenerConfigEmision` porque responden preguntas distintas. Aquella es para la
 * pantalla: trae el diagnóstico campo a campo y por eso consulta los catálogos. Esta es para emitir,
 * y trae las cuatro columnas que la pantalla no enseña —la moneda, la estrategia de retenciones, el
 * corte del histórico y el arrendamiento— porque son datos de negocio, no de configuración visible.
 *
 * Vive en este módulo, y no en el de emisión, para que `siigo_config_emision` siga teniendo **un
 * solo lector**. Dos módulos leyendo la misma tabla acaban discrepando sobre qué fila es la vigente,
 * y aquí la fila vigente decide con qué comprobante se factura ante la DIAN.
 */
export interface ParametrosEmisionVigentes {
  documentoTipoCodigo: string | null;
  vendedorCodigo: string | null;
  formaPagoCodigo: string | null;
  centroCostoCodigo: string | null;
  plazoVencimientoDias: number;
  estrategiaNumeracion: EstrategiaNumeracion;
  /** Pregunta 7, abierta. Mientras valga `ninguna` no se envía `retentions[]`. */
  retencionesEstrategia: string;
  /** Pregunta 15, abierta. Hoy solo `COP`. */
  moneda: string;
  /** Minutos tras los cuales una factura `en_proceso` se considera huérfana. */
  arrendamientoEnProcesoMin: number;
}

export async function parametrosDeEmision(
  ambiente: SiigoAmbiente,
): Promise<ParametrosEmisionVigentes | null> {
  const f = await filaVigente(ambiente);
  if (!f) return null;
  return {
    documentoTipoCodigo: f.documentoTipoCodigo,
    vendedorCodigo: f.vendedorCodigo,
    formaPagoCodigo: f.formaPagoCodigo,
    centroCostoCodigo: f.centroCostoCodigo,
    plazoVencimientoDias: f.plazoVencimientoDias,
    estrategiaNumeracion: esEstrategiaNumeracion(f.estrategiaNumeracion) ? f.estrategiaNumeracion : 'siigo',
    retencionesEstrategia: f.retencionesEstrategia,
    moneda: f.moneda,
    arrendamientoEnProcesoMin: f.arrendamientoEnProcesoMin,
  };
}

/** Historial de configuraciones de un ambiente, de la más reciente a la más antigua. */
export async function historialConfigEmision(
  ambiente: SiigoAmbiente, limite = 20,
): Promise<ConfigEmision[]> {
  const filas = await db.select().from(siigoConfigEmision)
    .where(eq(siigoConfigEmision.ambiente, ambiente))
    .orderBy(desc(siigoConfigEmision.createdAt))
    .limit(limite);

  const catalogos = await catalogosDeEmision(ambiente);
  return filas.map((f) => aVista(f, catalogos));
}

/**
 * AC6 — Estado de la parametrización de emisión. Es lo que consume la compuerta de la HU #11285.
 *
 * Enumera los campos que faltan, no un contador: la compuerta tiene que poder decir QUÉ falta.
 */
export async function estadoConfigEmision(ambiente: SiigoAmbiente): Promise<EstadoConfigEmision> {
  const config = await obtenerConfigEmision(ambiente);

  if (config === null) {
    return {
      ambiente,
      configurada: false,
      completa: false,
      // Sin configuración, lo que falta son los tres campos que siempre aplican. El centro de costo
      // no se puede saber todavía: depende del tipo de comprobante que se elija.
      faltantes: ['documentoTipo', 'vendedor', 'formaPago'],
      invalidos: [],
    };
  }

  const faltantes = config.campos
    .filter((c) => c.validez === 'sin_configurar')
    .map((c) => c.campo);
  const invalidos = config.campos.filter(
    (c) => c.validez === 'no_existe' || c.validez === 'inactivo' || c.validez === 'catalogo_sin_sincronizar',
  );

  return {
    ambiente,
    configurada: true,
    completa: faltantes.length === 0 && invalidos.length === 0,
    faltantes,
    invalidos,
  };
}

// ───────────────────────────────── Escritura ────────────────────────────────

/**
 * Comprueba un código contra su catálogo y lanza si no sirve (AC1).
 *
 * Exige ACTIVO, no solo existente: configurar un vendedor que Siigo tiene desactivado produciría
 * una factura rechazada en el momento de emitir, que es justo lo que esta parametrización evita.
 */
function exigirDelCatalogo(
  campo: CampoCatalogoEmision, codigo: string, elementos: SiigoCatalogoElemento[],
): SiigoCatalogoElemento {
  const etiqueta = CAMPO_CATALOGO_EMISION_ETIQUETA[campo];

  if (elementos.length === 0) {
    throw new SiigoConfigEmisionError('catalogo',
      `El catálogo de ${etiqueta.toLowerCase()} no está sincronizado en este ambiente. `
      + 'Sincronízalo desde la parametrización antes de configurar la emisión.', campo);
  }

  const encontrado = elementos.find((e) => e.codigo === codigo);
  if (!encontrado) {
    throw new SiigoConfigEmisionError('datos',
      `${etiqueta} ${codigo} no está en el catálogo sincronizado de este ambiente. `
      + 'Elige uno de la lista; estos valores no se escriben a mano.', campo);
  }
  if (!encontrado.activo) {
    throw new SiigoConfigEmisionError('datos',
      `${etiqueta} «${encontrado.nombre}» está INACTIVO en Siigo y no se puede usar para emitir.`,
      campo);
  }
  return encontrado;
}

/**
 * Guarda la configuración de emisión: INSERTA una fila nueva y apaga la anterior.
 *
 * No es un UPDATE en sitio a propósito. Con estos cuatro valores se emiten documentos ante la DIAN;
 * «¿con qué vendedor salió la factura de marzo?» solo tiene respuesta si la configuración de marzo
 * sigue existiendo. El índice único parcial sobre `vigente` garantiza el AC1 desde la base.
 *
 * Los campos que no vengan en `cambios` se heredan de la configuración vigente: guardar solo el
 * plazo no debe borrar el vendedor.
 */
export async function guardarConfigEmision(
  cambios: CambiosConfigEmision, usuarioId: number, ambiente: SiigoAmbiente,
): Promise<ConfigEmision> {
  const actual = await filaVigente(ambiente);
  const catalogos = await catalogosDeEmision(ambiente);

  const resuelto = {
    documentoTipoCodigo: cambios.documentoTipoCodigo !== undefined
      ? cambios.documentoTipoCodigo : (actual?.documentoTipoCodigo ?? null),
    vendedorCodigo: cambios.vendedorCodigo !== undefined
      ? cambios.vendedorCodigo : (actual?.vendedorCodigo ?? null),
    formaPagoCodigo: cambios.formaPagoCodigo !== undefined
      ? cambios.formaPagoCodigo : (actual?.formaPagoCodigo ?? null),
    centroCostoCodigo: cambios.centroCostoCodigo !== undefined
      ? cambios.centroCostoCodigo : (actual?.centroCostoCodigo ?? null),
    plazoVencimientoDias: cambios.plazoVencimientoDias ?? actual?.plazoVencimientoDias ?? 0,
    estrategiaNumeracion: cambios.estrategiaNumeracion
      ?? (esEstrategiaNumeracion(actual?.estrategiaNumeracion) ? actual!.estrategiaNumeracion : 'siigo'),
    notas: cambios.notas !== undefined ? cambios.notas : (actual?.notas ?? null),
  };

  if (!Number.isInteger(resuelto.plazoVencimientoDias)
    || resuelto.plazoVencimientoDias < 0 || resuelto.plazoVencimientoDias > 365) {
    throw new SiigoConfigEmisionError('datos',
      'El plazo de vencimiento son días enteros entre 0 y 365. Cero significa de contado.');
  }
  if (!esEstrategiaNumeracion(resuelto.estrategiaNumeracion)) {
    throw new SiigoConfigEmisionError('datos',
      'La única estrategia de numeración admitida hoy es que el consecutivo lo asigne Siigo. '
      + 'Enviar el número desde FLITO no está implementado ni confirmado por contabilidad.');
  }

  // Cada código, contra su catálogo. Se valida lo RESUELTO y no lo que llegó en el cuerpo: guardar
  // solo el plazo sobre una configuración cuyo vendedor se inactivó no debe pasar por válido.
  let documentoTipo: SiigoCatalogoElemento | undefined;
  if (resuelto.documentoTipoCodigo !== null) {
    documentoTipo = exigirDelCatalogo('documentoTipo', resuelto.documentoTipoCodigo, catalogos.documentoTipo);
    // AC1 — tiene que ser de VENTA. Un comprobante de otro tipo emitiría un documento que no es
    // una factura, y el error saldría de la DIAN, no de aquí.
    if (!esFacturaDeVenta(documentoTipo)) {
      throw new SiigoConfigEmisionError('datos',
        `El comprobante «${documentoTipo.nombre}» no es de venta (FV) y no sirve para facturar.`,
        'documentoTipo');
    }
  }
  if (resuelto.vendedorCodigo !== null) {
    exigirDelCatalogo('vendedor', resuelto.vendedorCodigo, catalogos.vendedor);
  }
  if (resuelto.formaPagoCodigo !== null) {
    exigirDelCatalogo('formaPago', resuelto.formaPagoCodigo, catalogos.formaPago);
  }
  if (resuelto.centroCostoCodigo !== null) {
    exigirDelCatalogo('centroCosto', resuelto.centroCostoCodigo, catalogos.centroCosto);
  } else if (exigeCentroCosto(documentoTipo)) {
    throw new SiigoConfigEmisionError('datos',
      `El comprobante «${documentoTipo!.nombre}» exige centro de costo en Siigo. Elige uno.`,
      'centroCosto');
  }

  // Apagar y crear. En este orden: el índice único parcial rechazaría dos vigentes a la vez.
  //
  // La fila nueva se recupera con `returning()` DENTRO de la transacción, no releyendo la vigente
  // después del commit. Con una relectura, un `PUT` concurrente que confirmara en esa ventana
  // devolvería SU fila, y la auditoría registraría a este usuario un cambio que no hizo —
  // debilitando justo la trazabilidad que motiva el modelo de historial.
  let nueva: FilaConfig | undefined;
  try {
    nueva = await db.transaction(async (tx) => {
      if (actual) {
        await tx.update(siigoConfigEmision)
          .set({ vigente: false, updatedBy: usuarioId, updatedAt: new Date() })
          .where(eq(siigoConfigEmision.id, actual.id));
      }
      const [creada] = await tx.insert(siigoConfigEmision).values({
        ambiente,
        ...resuelto,
        vigente: true,
        createdBy: usuarioId,
        updatedBy: usuarioId,
      }).returning();
      return creada;
    });
  } catch (e) {
    // Dos guardados simultáneos sobre el mismo ambiente: ambos leyeron la misma vigente, uno la
    // apagó e insertó, y el segundo choca contra `idx_siigo_config_emision_vigente`. La integridad
    // la sostiene el índice —nunca hay dos vigentes— pero para quien opera esto es un conflicto
    // recuperable reintentando, no un fallo del servidor.
    if (esViolacionDeUnico(e)) {
      throw new SiigoConfigEmisionError('conflicto',
        'Otro usuario guardó la configuración de emisión mientras editabas. Recarga la pantalla '
        + 'para ver la vigente y vuelve a aplicar tu cambio.');
    }
    throw e;
  }

  if (!nueva) {
    throw new SiigoConfigEmisionError('no_existe',
      'No se pudo leer la configuración recién guardada.');
  }
  return aVista(nueva, catalogos);
}

/**
 * Huella de las notas para la auditoría: dice SI cambiaron, nunca QUÉ dicen.
 *
 * `notas` es texto libre y meterlo íntegro en `audit_logs` arrastraría hacia allí lo que un operador
 * haya escrito, datos personales incluidos. Pero omitirlo del todo dejaba una entrada de auditoría
 * cuyo «Antes» y «Después» eran idénticos cuando el cambio era solo esa nota: constaba que algo
 * pasó y no qué, que es justo lo que el AC7 pide evitar. Ocho caracteres de hash resuelven las dos
 * cosas: comparables entre sí, irreversibles hacia el contenido.
 */
function huellaNotas(notas: string | null): string {
  if (notas === null || notas.length === 0) return '(sin)';
  return createHash('sha256').update(notas).digest('hex').slice(0, 8);
}

/** Resumen de una configuración para la auditoría. Códigos y banderas, nunca la fila entera. */
export function resumenConfig(c: ConfigEmision): string {
  return `ambiente=${c.ambiente} comprobante=${c.documentoTipoCodigo ?? '(sin)'} `
    + `vendedor=${c.vendedorCodigo ?? '(sin)'} formaPago=${c.formaPagoCodigo ?? '(sin)'} `
    + `centroCosto=${c.centroCostoCodigo ?? '(sin)'} plazoDias=${c.plazoVencimientoDias} `
    + `numeracion=${c.estrategiaNumeracion} notas=${huellaNotas(c.notas)} `
    + `utilizable=${c.utilizable}`;
}

/** Valideces que significan «este campo está mal», para quien necesite filtrarlas. */
export const VALIDEZ_ES_PROBLEMA: readonly ValidezCampoEmision[] = [
  'no_existe', 'inactivo', 'catalogo_sin_sincronizar',
];
