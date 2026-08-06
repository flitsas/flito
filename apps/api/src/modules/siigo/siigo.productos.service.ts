// Siigo API — consulta de productos y validación del mapeo (HU #11283).
//
// El mapeo de la HU #11282 acepta cualquier código con la forma correcta. «Con la forma correcta»
// no es «existe»: un código bien escrito que en Siigo no está, o que está inactivo, no se descubre
// hasta el momento de emitir, y ahí ya hay un trámite parado y una factura que no salió.
//
// Tres decisiones sostienen este archivo:
//
//   1. **`no existe` y `no se pudo verificar` NUNCA se confunden** (AC6). La primera dice «corrige
//      el código»; la segunda dice «Siigo está caído, tu código puede estar perfecto». Colapsarlas
//      llevaría a cambiar un dato que estaba bien. Por eso CUALQUIER fallo de la consulta —red,
//      circuito abierto, credenciales, 5xx— produce `no_verificable`, y solo una respuesta
//      efectivamente recibida puede producir `no_existe`.
//   2. **Lo barato se comprueba primero.** Formato (AC4) y catálogos locales (AC3) no tocan la red.
//      Siigo da 100 peticiones por minuto y por empresa: gastar una para que rechace un código con
//      espacios es regalar cuota.
//   3. **El límite de tasa se comparte con los catálogos; el cortacircuitos no.** La cuota es de la
//      EMPRESA y la consumen todos los flujos a la vez, así que la clave del limitador tiene que ser
//      común. La salud es del ENDPOINT: que `/v1/products` esté caído no es razón para dejar de
//      sincronizar `/v1/taxes`. Es la misma distinción que la HU #11281 pagó por aprender.

import {
  CODIGO_PRODUCTO_SIIGO_RE,
  type EstadoValidacionMapeo,
  type ImpuestoAplicable,
  type MotivoRechazoValidacion,
  type SiigoListadoApi,
  type SiigoProductoApi,
  type ValidacionMapeo,
} from '@operaciones/shared-types';
import { CircuitoAbiertoError } from '../../services/circuitBreaker.js';
import { siigoRequestOrThrow } from './siigo.client.js';
import { claveResiliencia, leerCatalogo } from './siigo.catalogos.service.js';
import { SiigoApiError } from './siigo.errors.js';
import { ejecutarConResiliencia, SiigoOperacionFallida } from './siigo.resiliencia.js';
import { SiigoAuthError } from './siigo.token.js';
import type { SiigoAmbiente } from './credenciales.service.js';

/**
 * Timeout de la consulta de producto.
 *
 * Muy por debajo de los 120 s del cliente, que están pensados para la CREACIÓN de comprobantes.
 * Esto es una validación sincrónica con alguien esperando delante de un formulario: si Siigo tarda
 * quince segundos en decir si un producto existe, la respuesta correcta es «no se pudo verificar»,
 * no dejar la pantalla colgada medio minuto.
 */
export const TIMEOUT_CONSULTA_PRODUCTO_MS = 15_000;

/**
 * Circuito del cortacircuitos: uno por ambiente para el endpoint de productos.
 *
 * Separado de los catálogos a propósito. Ver la decisión 3 de la cabecera y `claveCortacircuitos`
 * en `siigo.catalogos.service.ts`, que documenta por qué compartir circuito entre recursos deja sin
 * servicio a los sanos.
 */
export function claveCortacircuitosProductos(ambiente: string): string {
  return `siigo:productos:${ambiente}`;
}

/** Lo que se sabe de un código tras preguntarle a Siigo. */
export interface ProductoConsultado {
  existe: boolean;
  /** Solo significativo cuando `existe`. */
  activo: boolean;
  nombre: string | null;
}

/**
 * Consulta un producto por su `code` exacto.
 *
 * **La coincidencia se exige EXACTA aunque Siigo filtre.** `GET /v1/products?code=` no está
 * documentado como búsqueda exacta, y un filtro por coincidencia parcial devolvería `SOAT-2024`
 * ante una consulta por `SOAT`. Aceptar el primer resultado daría por bueno un código que no es el
 * que se guardó, y la factura saldría con otro producto. Filtrar aquí cuesta nada y cierra el hueco.
 *
 * Lanza si no se pudo consultar. Quien llama traduce eso a `no_verificable`; este servicio no
 * decide políticas de validación, solo informa de lo que Siigo dijo.
 */
export async function consultarProductoPorCodigo(
  codigo: string, ambiente: SiigoAmbiente,
): Promise<ProductoConsultado> {
  const datos = await ejecutarConResiliencia(
    () => siigoRequestOrThrow<SiigoListadoApi<SiigoProductoApi>>({
      metodo: 'GET',
      ruta: `/v1/products?code=${encodeURIComponent(codigo)}`,
      ambiente,
      timeoutMs: TIMEOUT_CONSULTA_PRODUCTO_MS,
    }),
    {
      clave: claveResiliencia(ambiente),
      claveCortacircuitos: claveCortacircuitosProductos(ambiente),
    },
  );

  const exacto = (datos?.results ?? []).find((p) => p?.code === codigo);
  if (!exacto) return { existe: false, activo: false, nombre: null };

  // `active` ausente se trata como INACTIVO, no como activo. Ante una respuesta incompleta, el
  // sesgo tiene que ir hacia no dar por bueno un producto con el que se va a facturar ante la DIAN.
  return {
    existe: true,
    activo: exacto.active === true,
    nombre: typeof exacto.name === 'string' ? exacto.name : null,
  };
}

/**
 * Motivo del fallo APTO PARA QUIEN OPERA. No confundir con `detalleTecnico`, que es para el log.
 *
 * Hace falta una función propia porque el mensaje de validación tiene dos destinos que
 * `detalleTecnico` no contempla: el cuerpo de la respuesta HTTP y la columna `validacion_mensaje`.
 * `sanearMensaje` solo corta sentencias SQL — no redacta URLs, ni la clave interna del
 * cortacircuitos, ni el texto en inglés que devuelve Siigo—, así que apoyarse en él aquí dejaría
 * escapar tres cosas concretas:
 *
 *   · `Servicio siigo:productos:produccion temporalmente no disponible`, que expone la topología
 *     interna y que `circuitBreaker.ts` documenta que no debe llegar a una pantalla;
 *   · el `Message` literal de Siigo en inglés, que es justo lo que el traductor de errores existe
 *     para no mostrar;
 *   · la ruta `GET /v1/products?code=…` que compone `SiigoAuthError`.
 *
 * El detalle completo sigue estando en el log del servidor, que es donde se depura.
 */
export function motivoLegible(e: unknown): string {
  if (e instanceof CircuitoAbiertoError) {
    return 'la conexión con Siigo está temporalmente suspendida tras varios fallos seguidos';
  }
  if (e instanceof SiigoAuthError) {
    return 'Siigo rechazó la autenticación; revisa las credenciales del ambiente';
  }
  if (e instanceof SiigoApiError) return e.descripcionOperativa;
  if (e instanceof SiigoOperacionFallida) {
    // `causa` es el error real; su `message` puede ser el texto crudo de Siigo. Se traduce.
    if (e.causa instanceof SiigoApiError) return e.causa.descripcionOperativa;
    if (e.causa instanceof CircuitoAbiertoError) {
      return 'la conexión con Siigo está temporalmente suspendida tras varios fallos seguidos';
    }
    return 'Siigo no respondió tras varios intentos';
  }
  return 'Siigo no respondió';
}

/** Lo que hay que validar de un mapeo antes de guardarlo. */
export interface DatosAValidar {
  codigoProducto?: string | null;
  impuestos?: ImpuestoAplicable[];
}

/**
 * Válido porque SE COMPROBÓ. `verificadoEn` con valor es lo que distingue esto de «no había nada
 * que comprobar», y de esa distinción depende que la fila se marque `valido` o `sin_validar`.
 */
function verificado(nombre: string | null): ValidacionMapeo {
  return {
    valido: true,
    motivo: null,
    mensaje: nombre === null
      ? 'Producto verificado contra Siigo.'
      : `Verificado contra Siigo: ${nombre}.`,
    nombreProductoSiigo: nombre,
    verificadoEn: new Date().toISOString(),
  };
}

/**
 * Válido porque NO HABÍA NADA QUE COMPROBAR: la fila no declara código de producto.
 *
 * No es un aprobado. `verificadoEn` queda en `null` para que no se registre como validación una
 * comprobación que nunca ocurrió; una fila así queda `sin_validar`, que es justo lo que es.
 */
function nadaQueVerificar(): ValidacionMapeo {
  return {
    valido: true,
    motivo: null,
    mensaje: 'Sin código de producto que verificar.',
    nombreProductoSiigo: null,
    verificadoEn: null,
  };
}

function rechazo(
  motivo: MotivoRechazoValidacion, mensaje: string, verificado: boolean,
): ValidacionMapeo {
  return {
    valido: false,
    motivo,
    mensaje,
    nombreProductoSiigo: null,
    verificadoEn: verificado ? new Date().toISOString() : null,
  };
}

/**
 * AC3 — Los impuestos se validan contra la COPIA LOCAL, no contra Siigo.
 *
 * Preguntar a Siigo por cada id gastaría una petición por impuesto de cada guardado, y para eso
 * existe la caché que sincroniza la HU #11281. La contrapartida es honesta y está en el mensaje: si
 * el elemento es nuevo en Siigo, lo que falta es sincronizar, no corregir el dato.
 *
 * La copia vacía se distingue del id desconocido. Con la copia sin sincronizar, TODO id parecería
 * inválido, y decirle a quien parametriza que su impuesto no existe cuando lo que pasa es que nadie
 * ha traído el catálogo lo mandaría a buscar un problema que no está donde se le dice.
 */
async function validarImpuestos(
  impuestos: ImpuestoAplicable[], ambiente: SiigoAmbiente,
): Promise<ValidacionMapeo | null> {
  if (impuestos.length === 0) return null;

  const catalogo = await leerCatalogo('tax', { incluirInactivos: true, ambiente });
  if (catalogo.elementos.length === 0) {
    return rechazo('catalogo_sin_sincronizar',
      'El catálogo de impuestos de Siigo no está sincronizado en este ambiente, así que no se puede '
      + 'comprobar los impuestos del mapeo. Sincronízalo desde la parametrización y vuelve a guardar.',
      false);
  }

  const activos = new Set(catalogo.elementos.filter((e) => e.activo).map((e) => e.codigo));
  const conocidos = new Set(catalogo.elementos.map((e) => e.codigo));

  for (const imp of impuestos) {
    const codigo = String(imp.id);
    if (activos.has(codigo)) continue;

    // Mismo motivo para las dos ramas —la acción es la misma: elegir otro impuesto o arreglarlo en
    // Siigo— pero el mensaje distingue, porque «no existe» y «está inactivo» se resuelven en sitios
    // distintos de Siigo Nube.
    return rechazo('impuesto_desconocido',
      conocidos.has(codigo)
        ? `El impuesto ${codigo} existe en Siigo pero está inactivo. Actívalo en Siigo Nube o elige otro.`
        : `El impuesto ${codigo} no está en el catálogo sincronizado de este ambiente. Si es nuevo en `
          + 'Siigo, sincroniza el catálogo de impuestos y vuelve a intentarlo.',
      false);
  }

  return null;
}

/**
 * Valida un mapeo contra Siigo antes de guardarlo (AC1-AC6).
 *
 * El orden es deliberado y va de lo barato a lo caro: formato → catálogos locales → red. Cada paso
 * que rechaza ahorra el siguiente.
 *
 * Nunca lanza: devuelve el veredicto. Que la validación no lance es lo que permite que quien llama
 * decida qué hacer con un `no_verificable` —hoy rechazar, mañana quizá permitir guardar marcado—
 * sin tener que distinguir excepciones.
 */
export async function validarMapeoContraSiigo(
  datos: DatosAValidar, ambiente: SiigoAmbiente,
): Promise<ValidacionMapeo> {
  // AC4 — formato ANTES de salir a la red. Un código con espacios no merece una petición.
  const codigo = datos.codigoProducto ?? null;
  if (codigo !== null && !CODIGO_PRODUCTO_SIIGO_RE.test(codigo)) {
    return rechazo('formato',
      'El código de producto de Siigo debe ser alfanumérico (admite punto, guion y guion bajo), sin '
      + 'espacios y de máximo 30 caracteres.',
      false);
  }

  // AC3 — impuestos contra la copia local. También sin red, así que va antes que la consulta.
  const falloImpuestos = await validarImpuestos(datos.impuestos ?? [], ambiente);
  if (falloImpuestos) return falloImpuestos;

  // Sin código no hay nada más que verificar. No es un fallo: una fila puede tener su tratamiento
  // tributario declarado y quedar pendiente del producto.
  if (codigo === null) return nadaQueVerificar();

  let consultado: ProductoConsultado;
  try {
    consultado = await consultarProductoPorCodigo(codigo, ambiente);
  } catch (e) {
    // AC6 — cualquier fallo de la consulta es «no se pudo verificar», nunca «no existe».
    return rechazo('no_verificable',
      `No se pudo verificar el producto ${codigo} contra Siigo: ${motivoLegible(e)}. `
      + 'El código puede estar bien; vuelve a intentarlo cuando Siigo responda.',
      false);
  }

  // AC1 — existe o no. Esta rama solo se alcanza con una respuesta efectivamente recibida.
  if (!consultado.existe) {
    return rechazo('no_existe',
      `El producto ${codigo} no existe en Siigo en el ambiente ${ambiente}. Créalo en Siigo Nube o `
      + 'corrige el código.',
      true);
  }

  // AC2 — existe pero está inactivo. El código está bien; lo que falta es activarlo.
  if (!consultado.activo) {
    return rechazo('inactivo',
      `El producto ${codigo} existe en Siigo pero está INACTIVO. Actívalo en Siigo Nube antes de `
      + 'usarlo en la facturación.',
      true);
  }

  return verificado(consultado.nombre);
}

/**
 * Traduce el veredicto al estado que se persiste en la fila (AC7).
 *
 * `formato`, `impuesto_desconocido` y `catalogo_sin_sincronizar` no llegan a persistirse nunca:
 * rechazan el guardado antes de tocar la tabla. Se mapean a `sin_validar` por completitud del
 * exhaustivo, no porque haya un camino que los escriba.
 */
export function estadoDeValidacion(v: ValidacionMapeo): EstadoValidacionMapeo {
  // Válido sin fecha = no había código que comprobar. Marcarlo `valido` afirmaría una comprobación
  // que nunca se hizo, y la revalidación del AC7 daría por buena una fila que nadie miró.
  if (v.valido) return v.verificadoEn === null ? 'sin_validar' : 'valido';
  switch (v.motivo) {
    case 'no_existe': return 'no_existe';
    case 'inactivo': return 'inactivo';
    case 'no_verificable': return 'no_verificable';
    default: return 'sin_validar';
  }
}

// ── Creación de productos (HU #11286) ───────────────────────────────────────

/** Cuerpo de `POST /v1/products` tal como lo documenta Siigo. En inglés: es la forma del API. */
export interface SiigoProductoNuevoApi {
  code: string;
  name: string;
  account_group: number;
  type: 'Product' | 'Service';
  stock_control: boolean;
  active: boolean;
  tax_classification?: 'Taxed' | 'Exempt' | 'Excluded';
  taxes?: Array<{ id: number }>;
  unit?: string;
}

/**
 * Crea un producto en Siigo.
 *
 * `type: 'Service'` y `stock_control: false` no son configurables: lo que FLITO factura son
 * servicios y derechos de trámite, no inventario. Un producto con control de existencias exigiría
 * movimientos de bodega que aquí no existen, y Siigo rechazaría la factura.
 *
 * Timeout corto por la misma razón que la consulta: hay alguien esperando delante de un formulario.
 * Sin reintentos automáticos —`maxIntentos: 1`— porque **crear no es idempotente**: un reintento
 * sobre un timeout que en realidad llegó a Siigo produce el segundo intento un `already_exists`, y
 * en el peor caso dos productos. Quien llama decide qué hacer, y el flujo de alta ya busca antes de
 * crear (AC2), así que el reintento humano es seguro.
 */
export async function crearProducto(
  cuerpo: SiigoProductoNuevoApi, ambiente: SiigoAmbiente,
): Promise<SiigoProductoApi> {
  return ejecutarConResiliencia(
    () => siigoRequestOrThrow<SiigoProductoApi>({
      metodo: 'POST',
      ruta: '/v1/products',
      cuerpo,
      ambiente,
      timeoutMs: TIMEOUT_CONSULTA_PRODUCTO_MS,
    }),
    {
      clave: claveResiliencia(ambiente),
      claveCortacircuitos: claveCortacircuitosProductos(ambiente),
      maxIntentos: 1,
    },
  );
}
